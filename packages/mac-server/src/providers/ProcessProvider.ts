import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { EventEmitter } from 'events'
import { homedir } from 'node:os'
import { v4 as uuidv4 } from 'uuid'
import type { Session, ClaudeStreamEvent, Result, PermissionMode, EffortLevel, ImageAttachment } from '@sessix/shared'
import type { ExecutionProvider, StartSessionOptions } from './ExecutionProvider.js'
import { findClaudePath } from '../utils/claudePath.js'
import { killProcessCrossPlatform, isNormalExit } from '../utils/platform.js'

const CLAUDE_PATH = findClaudePath()

// ============================================
// ProcessProvider — 通过 child_process 管理 Claude CLI
// ============================================

/** 活跃会话的内部记录 */
interface ActiveSessionEntry {
  session: Session
  process: ChildProcess
  /** 创建会话时指定的模型别名（复用于 sendMessage 重新 spawn） */
  model?: string
  /** 当前权限模式（用于检测模式切换时需要 respawn） */
  permissionMode?: PermissionMode
  /** 思考等级 */
  effort?: EffortLevel
  /** 当前等待用户回答的 AskUserQuestion 请求（toolUseId → resolve） */
  pendingQuestion?: {
    toolUseId: string
    resolve: () => void
  }
  /** stdout readline 接口引用（进程退出时需关闭） */
  rl?: ReturnType<typeof import('readline').createInterface>
}

/**
 * 基于 child_process.spawn 的 ExecutionProvider 实现
 *
 * 直接在本机通过 spawn 启动 `claude` CLI 进程，
 * 从 stdout 逐行读取 NDJSON 格式的 stream-json 事件。
 */
export class ProcessProvider implements ExecutionProvider {
  /** 活跃会话映射表：sessionId -> { session, process } */
  private activeSessions: Map<string, ActiveSessionEntry> = new Map()

  /** 事件发射器，用于分发 Claude 事件流 */
  private emitter: EventEmitter = new EventEmitter()

  /** 已发射的 AskUserQuestion toolUseId 集合，按会话隔离（避免 partial message 重复触发） */
  private emittedQuestionToolUseIds: Map<string, Set<string>> = new Map()

  /**
   * 启动新会话或恢复已有会话
   *
   * 会 spawn 一个 `claude` CLI 进程，设置工作目录和环境变量，
   * 并开始监听 stdout 的 NDJSON 输出。
   */
  async startSession(opts: StartSessionOptions): Promise<Session> {
    const { projectPath, message, sessionId: existingSessionId, model, permissionMode, effort, images } = opts
    const sessionId = existingSessionId ?? uuidv4()

    // 如果该 sessionId 已有活跃进程，先终止
    if (this.activeSessions.has(sessionId)) {
      await this.killSession(sessionId)
    }

    // 构建项目 ID（使用路径的最后一段）
    const projectId = projectPath.split('/').filter(Boolean).pop() ?? 'unknown'

    // 创建 Session 对象
    const session: Session = {
      id: sessionId,
      projectId,
      projectPath,
      status: 'running',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      summary: message.slice(0, 80),
    }

    // 启动 Claude CLI 进程（如果是恢复已有会话，使用 --resume）
    const resume = opts.resume ?? !!existingSessionId
    const proc = this.spawnClaudeProcess(sessionId, projectPath, resume, model, permissionMode, effort)
    // 写入第一条用户消息
    this.writeUserMessage(proc, message, sessionId, images)
    session.pid = proc.pid

    // 保存到活跃会话映射
    this.activeSessions.set(sessionId, { session, process: proc, model, permissionMode, effort })

    // 监听进程错误（如命令不存在）
    proc.on('error', (err) => {
      console.error(`[ProcessProvider] Session ${sessionId} process error:`, err.message)
      // 立即从活跃映射中移除，防止僵尸会话
      this.activeSessions.delete(sessionId)
      // 发射合成 error result 事件，让 SessionManager 广播状态变化到手机端
      const syntheticResult: ClaudeStreamEvent = {
        type: 'result',
        subtype: 'error',
        result: `Process spawn failed: ${err.message}`,
        session_id: sessionId,
        duration_ms: 0,
        is_error: true,
        num_turns: 0,
      }
      this.emitter.emit(this.getEventName(sessionId), syntheticResult)
    })

    // 监听 stdout，逐行解析 NDJSON
    this.attachStdoutListener(sessionId, proc)

    // 监听 stderr，记录日志但不影响运行
    this.attachStderrListener(sessionId, proc)

    // 监听进程退出
    this.attachExitListener(sessionId, proc)

    return session
  }

  /**
   * 终止指定会话
   *
   * kill 进程并从活跃映射中移除。
   */
  async killSession(sessionId: string): Promise<void> {
    const entry = this.activeSessions.get(sessionId)
    if (!entry) {
      return
    }

    // 终止进程（检查 exitCode/signalCode 判断进程是否已退出，
    // 而非依赖 .killed 标志 — 它只表示 kill() 是否被调用过）
    if (entry.process.exitCode === null && entry.process.signalCode === null) {
      // 先关闭 stdin，让 Claude 进程感知到 EOF 并准备退出
      try { entry.process.stdin?.end() } catch { /* 忽略 */ }
      await killProcessCrossPlatform(entry.process)
    }

    // 清理该会话的 question dedup 缓存
    this.emittedQuestionToolUseIds.delete(sessionId)

    // 从活跃映射中移除
    this.activeSessions.delete(sessionId)
  }

  /**
   * 向已有会话发送新消息
   *
   * 快速路径：进程存活时直接写 stdin（毫秒级响应）。
   * 慢速路径：进程已退出时 respawn 并 --resume。
   */
  async sendMessage(sessionId: string, message: string, permissionMode?: PermissionMode, images?: ImageAttachment[]): Promise<void> {
    const entry = this.activeSessions.get(sessionId)
    if (!entry) {
      throw new Error(`Session ${sessionId} not found or already ended`)
    }

    // 权限模式是否发生变化（需要 respawn）
    const modeChanged = permissionMode != null && permissionMode !== (entry.permissionMode ?? 'default')

    // 快速路径：进程存活 且 权限模式未变，直接写 stdin
    if (
      !modeChanged &&
      entry.process.exitCode === null &&
      entry.process.signalCode === null &&
      !entry.process.stdin?.destroyed
    ) {
      entry.session.status = 'running'
      entry.session.lastActiveAt = Date.now()
      this.writeUserMessage(entry.process, message, sessionId, images)
      return
    }

    // 需要 respawn：权限模式变化 或 进程已退出
    if (modeChanged) {
      console.log(`[ProcessProvider] Session ${sessionId}: permission mode change ${entry.permissionMode ?? 'default'} → ${permissionMode}, respawn`)
      // 先关闭旧进程
      if (entry.process.exitCode === null && entry.process.signalCode === null) {
        try { entry.process.stdin?.end() } catch { /* 忽略 */ }
        killProcessCrossPlatform(entry.process)
      }
    } else {
      console.log(`[ProcessProvider] Session ${sessionId}: process exited, respawning`)
    }

    // 保存旧进程的 pendingQuestion（respawn 后迁移）
    const savedPendingQuestion = entry.pendingQuestion

    const newMode = permissionMode ?? entry.permissionMode
    const proc = this.spawnClaudeProcess(sessionId, entry.session.projectPath, true, entry.model, newMode, entry.effort)
    this.writeUserMessage(proc, message, sessionId, images)

    // 更新会话状态
    entry.session.status = 'running'
    entry.session.lastActiveAt = Date.now()
    entry.session.pid = proc.pid
    entry.process = proc
    entry.permissionMode = newMode
    entry.pendingQuestion = savedPendingQuestion

    // 监听进程错误
    proc.on('error', (err) => {
      console.error(`[ProcessProvider] Session ${sessionId} sendMessage process error:`, err.message)
      this.activeSessions.delete(sessionId)
      const syntheticResult: ClaudeStreamEvent = {
        type: 'result',
        subtype: 'error',
        result: `Failed to send message: ${err.message}`,
        session_id: sessionId,
        duration_ms: 0,
        is_error: true,
        num_turns: 0,
      }
      this.emitter.emit(this.getEventName(sessionId), syntheticResult)
    })

    this.attachStdoutListener(sessionId, proc)
    this.attachStderrListener(sessionId, proc)
    this.attachExitListener(sessionId, proc)
  }

  /**
   * 订阅指定会话的 Claude 事件流
   *
   * @returns 取消订阅函数
   */
  onEvent(sessionId: string, callback: (event: ClaudeStreamEvent) => void): () => void {
    const eventName = this.getEventName(sessionId)
    this.emitter.on(eventName, callback)

    // 返回取消订阅函数
    return () => {
      this.emitter.off(eventName, callback)
    }
  }

  /**
   * 获取当前所有活跃会话列表
   */
  getActiveSessions(): Session[] {
    return Array.from(this.activeSessions.values()).map((entry) => entry.session)
  }

  // ============================================
  // 私有方法
  // ============================================

  /**
   * 启动 claude CLI 进程（持久模式，stdin 保持开放接收多条消息）
   */
  private spawnClaudeProcess(
    sessionId: string,
    projectPath: string,
    resume = false,
    model?: string,
    permissionMode?: PermissionMode,
    effort?: EffortLevel,
  ): ChildProcess {
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ]

    if (resume) {
      // 恢复已有会话：--resume <session-id>
      args.push('--resume', sessionId)
    } else {
      // 创建新会话：--session-id <uuid>
      args.push('--session-id', sessionId)
    }

    if (model) {
      args.push('--model', model)
    }

    if (permissionMode && permissionMode !== 'default') {
      args.push('--permission-mode', permissionMode)
    }

    if (effort) {
      args.push('--effort', effort)
    }

    // 构建子进程环境变量
    // 移除 CLAUDECODE 以允许从 Claude Code 会话内启动独立的 Claude 实例
    const env: Record<string, string | undefined> = { ...process.env, SESSIX_SESSION_ID: sessionId }
    delete env.CLAUDECODE

    const proc = spawn(CLAUDE_PATH, args, {
      cwd: projectPath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    return proc
  }

  /**
   * 向持久进程的 stdin 写入一条用户消息（NDJSON 格式）
   *
   * 写入失败时合成 error result 事件，确保 SessionManager 能感知到失败。
   */
  private writeUserMessage(proc: ChildProcess, message: string, sessionId?: string, images?: ImageAttachment[]): void {
    const content: Array<Record<string, unknown>> = []
    if (images?.length) {
      for (const img of images) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.media_type, data: img.data },
        })
      }
    }
    content.push({ type: 'text', text: message })

    const payload = JSON.stringify({
      type: 'user',
      session_id: '',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    })

    if (!proc.stdin || proc.stdin.destroyed) {
      console.error(`[ProcessProvider] stdin unavailable, message lost`)
      if (sessionId) {
        this.emitWriteError(sessionId, 'Process stdin closed, message not delivered')
      }
      return
    }

    proc.stdin.write(payload + '\n', (err) => {
      if (err && sessionId) {
        console.error(`[ProcessProvider] Session ${sessionId} stdin write failed:`, err.message)
        this.emitWriteError(sessionId, `Failed to send message: ${err.message}`)
      }
    })
  }

  /**
   * 发出写入失败的合成错误事件
   */
  private emitWriteError(sessionId: string, message: string): void {
    const syntheticResult: ClaudeStreamEvent = {
      type: 'result',
      subtype: 'error',
      result: message,
      session_id: sessionId,
      duration_ms: 0,
      is_error: true,
      num_turns: 0,
    }
    this.emitter.emit(this.getEventName(sessionId), syntheticResult)
  }

  /**
   * 挂载 stdout 监听器，逐行解析 NDJSON
   */
  private attachStdoutListener(sessionId: string, proc: ChildProcess): void {
    if (!proc.stdout) {
      console.warn(`[ProcessProvider] Session ${sessionId}: stdout unavailable`)
      return
    }

    const rl = createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    })

    // 保存 rl 引用到 entry，进程退出时可关闭
    const entry = this.activeSessions.get(sessionId)
    if (entry) {
      entry.rl = rl
    }

    rl.on('line', (line) => {
      // 跳过空行
      const trimmed = line.trim()
      if (!trimmed) return

      // 尝试解析 JSON
      const result = this.parseLine(trimmed)
      if (result.ok) {
        const event = result.value

        // 检测 AskUserQuestion tool_use，发射内部事件通知 SessionManager
        // 注意：--include-partial-messages 会导致同一个 tool_use 在 partial 消息中多次出现，
        // input 可能为空或不完整。策略：跳过空 question，同 toolUseId 只在内容变更时更新。
        if (event.type === 'assistant') {
          for (const block of event.message.content) {
            if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
              const input = block.input as { question?: string; options?: string[] }
              const question = input.question ?? ''
              // 跳过空问题（partial message 中 input 尚未完整）
              if (!question) continue

              const prevKey = `${block.id}:${question}:${JSON.stringify(input.options ?? [])}`
              let sessionSet = this.emittedQuestionToolUseIds.get(sessionId)
              if (!sessionSet) {
                sessionSet = new Set()
                this.emittedQuestionToolUseIds.set(sessionId, sessionSet)
              }
              if (sessionSet.has(prevKey)) continue
              // 标记：用 "toolUseId:question:optionsCount" 作 key，内容变更时允许再次发射
              sessionSet.add(prevKey)

              this.emitter.emit(this.getQuestionEventName(sessionId), {
                toolUseId: block.id,
                question,
                options: input.options,
              })
            }
          }
        }

        // 更新会话状态
        this.updateSessionStatus(sessionId, event)

        // 发射事件
        this.emitter.emit(this.getEventName(sessionId), event)
      } else {
        console.warn(
          `[ProcessProvider] Session ${sessionId}: failed to parse line: ${trimmed.substring(0, 100)}`,
        )
      }
    })
  }

  /**
   * 挂载 stderr 监听器，记录日志
   */
  private attachStderrListener(sessionId: string, proc: ChildProcess): void {
    if (!proc.stderr) return

    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) {
        console.error(`[ProcessProvider] Session ${sessionId} stderr: ${text}`)
      }
    })
  }

  /**
   * 挂载进程退出监听器
   *
   * 当进程退出时发出合成的 result 事件，确保 SessionManager 能感知到退出。
   * 正常退出时 Claude 会先通过 stdout 发送真实 result 事件，
   * updateSessionStatus 会将 session.status 更新为 idle/error。
   * 此时合成事件会重复触发，导致手机端出现两张总结卡。
   * 修复：已收到真实 result（status 已为 idle/error）时跳过合成事件。
   * 异常退出时（crash/OOM/killed）没有真实 result 事件，合成事件确保状态正确广播。
   */
  private attachExitListener(sessionId: string, proc: ChildProcess): void {
    proc.once('exit', (code, signal) => {
      const entry = this.activeSessions.get(sessionId)
      if (!entry) return

      // 确保退出的是当前活跃进程（防止旧进程退出影响新进程）
      if (entry.process !== proc) return

      // 关闭 readline 接口
      if (entry.rl) {
        entry.rl.close()
        entry.rl = undefined
      }

      // 清除 PID
      entry.session.pid = undefined
      entry.session.lastActiveAt = Date.now()

      // 若 stdout 已传来真实 result 事件，session.status 已被设为 idle/error
      // Node.js 保证 readline line 事件先于 process exit 事件触发，此检查是安全的
      const alreadyHasResult = entry.session.status === 'idle' || entry.session.status === 'error'
      if (alreadyHasResult) return

      // code=143 = 128+SIGTERM：claude CLI 自己捕获 SIGTERM 并以此码退出
      const isNormal = isNormalExit(code, signal)

      entry.session.status = isNormal ? 'idle' : 'error'

      if (!isNormal) {
        console.error(
          `[ProcessProvider] Session ${sessionId}: process exited abnormally code=${code} signal=${signal}`,
        )
      }

      // 发出合成 result 事件，让 SessionManager 广播状态变化到手机端
      const syntheticResult: ClaudeStreamEvent = {
        type: 'result',
        subtype: isNormal ? 'success' : 'error',
        session_id: sessionId,
        is_error: !isNormal,
        result: isNormal ? '' : `Process exited code=${code} signal=${signal}`,
        duration_ms: 0,
        num_turns: 0,
      }
      this.emitter.emit(this.getEventName(sessionId), syntheticResult)
    })
  }

  /**
   * 解析一行 NDJSON 文本为 ClaudeStreamEvent
   */
  private parseLine(line: string): Result<ClaudeStreamEvent> {
    try {
      const parsed = JSON.parse(line) as ClaudeStreamEvent
      return { ok: true, value: parsed }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      }
    }
  }

  /**
   * 根据 Claude 事件更新会话状态
   */
  private updateSessionStatus(sessionId: string, event: ClaudeStreamEvent): void {
    const entry = this.activeSessions.get(sessionId)
    if (!entry) return

    entry.session.lastActiveAt = Date.now()

    switch (event.type) {
      case 'system':
        // init 事件表示 Claude 已启动
        if (event.subtype === 'init') {
          entry.session.status = 'running'
        }
        break

      case 'assistant':
        // 收到 assistant 消息，正在运行
        entry.session.status = 'running'
        break

      case 'result':
        // 任务结束
        entry.session.status = event.is_error ? 'error' : 'idle'
        break
    }
  }

  /**
   * 根据对话上下文生成下一步建议指令
   *
   * 使用 --output-format text 做一次性调用，返回纯文本结果。
   */
  async generateSuggestion(context: string): Promise<string> {
    const prompt = `You are an AI coding assistant. Based on the following Claude Code conversation context, suggest the most valuable next instruction for the user (give the instruction directly, no explanation, no quotes):\n\n${context}`

    return new Promise((resolve, reject) => {
      const env: Record<string, string | undefined> = { ...process.env }
      delete env.CLAUDECODE

      const proc = spawn(CLAUDE_PATH, ['-p', prompt, '--output-format', 'text'], {
        cwd: homedir(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      proc.stdin.end()

      let output = ''
      proc.stdout?.on('data', (data: Buffer) => {
        output += data.toString()
      })

      proc.once('exit', (code) => {
        if (code === 0) {
          resolve(output.trim())
        } else {
          reject(new Error(`generateSuggestion process exit code: ${code}`))
        }
      })

      proc.once('error', reject)
    })
  }

  /**
   * 向正在等待中的 AskUserQuestion 提供答案
   *
   * 将答案写入 Claude 进程的 stdin（作为 tool_result），
   * Claude 收到后继续执行。
   */
  async answerQuestion(sessionId: string, toolUseId: string, answer: string): Promise<void> {
    const entry = this.activeSessions.get(sessionId)
    if (!entry) {
      throw new Error(`Session ${sessionId} not found`)
    }

    if (!entry.process.stdin || entry.process.stdin.destroyed) {
      throw new Error(`Session ${sessionId} stdin unavailable`)
    }

    // 写入 tool_result NDJSON 行，让 Claude 继续执行
    const toolResult = JSON.stringify({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: answer,
    })

    await new Promise<void>((resolve, reject) => {
      entry.process.stdin!.write(toolResult + '\n', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    console.log(`[ProcessProvider] Session ${sessionId}: AskUserQuestion answered (toolUseId=${toolUseId})`)
  }

  /**
   * 订阅指定会话的 AskUserQuestion 事件
   *
   * @returns 取消订阅函数
   */
  onQuestion(
    sessionId: string,
    callback: (data: { toolUseId: string; question: string; options?: string[] }) => void,
  ): () => void {
    const eventName = this.getQuestionEventName(sessionId)
    this.emitter.on(eventName, callback)
    return () => {
      this.emitter.off(eventName, callback)
    }
  }

  /**
   * 生成事件名称
   */
  private getEventName(sessionId: string): string {
    return `claude:${sessionId}`
  }

  /**
   * 生成 AskUserQuestion 内部事件名称
   */
  private getQuestionEventName(sessionId: string): string {
    return `question:${sessionId}`
  }
}
