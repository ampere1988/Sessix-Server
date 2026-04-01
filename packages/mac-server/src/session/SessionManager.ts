import { v4 as uuidv4 } from 'uuid'
import type { ExecutionProvider } from '../providers/ExecutionProvider.js'
import type {
  Session,
  SessionStats,
  SessionStatus,
  QuestionRequest,
  ClaudeStreamEvent,
  ServerEvent,
  PermissionMode,
  EffortLevel,
  ImageAttachment,
} from '@sessix/shared'

const BUFFER_MAX = 5000

/**
 * 会话管理器 — 后端核心协调模块
 *
 * 职责：
 * - 创建 / 终止 / 发送消息到 Claude 会话
 * - 监听 ExecutionProvider 的事件流，将 ClaudeStreamEvent 包装成 ServerEvent 转发
 * - 检测 status 变化（system init → running，result → completed/error）
 * - 维护 AskUserQuestion 问题映射，连接 ExecutionProvider 和 WsBridge
 */
export class SessionManager {
  private provider: ExecutionProvider

  /** 事件回调列表（事件会被转发到 WsBridge） */
  private eventCallbacks: Array<(event: ServerEvent) => void> = []

  /** 每个会话的事件流取消订阅函数 */
  private unsubscribeMap = new Map<string, () => void>()

  /** 每个会话的事件缓冲区（用于新订阅者重放）*/
  private sessionEventBuffers = new Map<string, ClaudeStreamEvent[]>()

  /** AskUserQuestion 问题映射：requestId → resolve 回调 + 原始问题内容 */
  private pendingQuestions = new Map<string, {
    sessionId: string
    toolUseId: string
    question: string
    options?: string[]
    createdAt: number
    resolve: (answer: string) => void
  }>()

  /**
   * 会话状态缓存（用于追踪 status 变化，检测 oldStatus !== newStatus 时广播）
   *
   * 这是 status 变化的唯一检测源。ProcessProvider 的 session.status 是实际值，
   * 这里只缓存上次广播的值，用于去重。
   */
  private lastBroadcastStatus = new Map<string, SessionStatus>()

  /** 每个会话的服务器端累计统计 */
  private sessionStats = new Map<string, SessionStats>()

  /** 每个会话进入 running 状态的 wall-clock 起始时间 */
  private runningStartedAt = new Map<string, number>()

  /** assistant 事件合并缓冲区（30ms 窗口内的 assistant 事件合并为一次发送） */
  private pendingAssistantEvents = new Map<string, { events: ClaudeStreamEvent[]; timer: ReturnType<typeof setTimeout> }>()

  /** 标记哪些会话的缓冲区曾被截断（溢出过 BUFFER_MAX） */
  private bufferTruncated = new Set<string>()

  /** sessionId → projectPath 映射，用于截断时从 JSONL 补全历史 */
  private sessionProjectPaths = new Map<string, string>()

  constructor(provider: ExecutionProvider) {
    this.provider = provider
  }

  // ============================================
  // 公开 API
  // ============================================

  /**
   * 创建新会话
   *
   * 调用 provider.startSession()，订阅事件流，
   * 将 ClaudeStreamEvent 包装为 ServerEvent 转发。
   */
  async createSession(
    projectPath: string,
    message: string,
    resumeSessionId?: string,
    newSessionId?: string,
    model?: string,
    permissionMode?: PermissionMode,
    effort?: EffortLevel,
    images?: ImageAttachment[],
  ): Promise<Session> {
    const session = await this.provider.startSession({
      projectPath,
      message,
      sessionId: resumeSessionId ?? newSessionId,
      resume: !!resumeSessionId,
      model,
      permissionMode,
      effort,
      images,
    })

    // 记录初始状态和项目路径
    this.lastBroadcastStatus.set(session.id, session.status)
    this.sessionProjectPaths.set(session.id, projectPath)

    // 取消旧订阅（resume 时 sessionId 可能已有旧监听器，不先取消会导致事件被处理两次）
    this.unsubscribeSession(session.id)

    // 订阅该会话的事件流
    this.subscribeToSession(session.id)

    console.log(`[SessionManager] Session created: ${session.id} (project: ${projectPath})`)
    return session
  }

  /**
   * 发送消息到已有会话
   */
  async sendMessage(sessionId: string, message: string, permissionMode?: PermissionMode, images?: ImageAttachment[]): Promise<void> {
    await this.provider.sendMessage(sessionId, message, permissionMode, images)
    this.updateSessionStatus(sessionId, 'running')
    console.log(`[SessionManager] Message sent to session: ${sessionId}`)
  }

  /**
   * 终止会话
   */
  async killSession(sessionId: string): Promise<void> {
    // 取消事件订阅
    this.unsubscribeSession(sessionId)

    // 清除该会话的待回答问题
    this.clearPendingQuestions(sessionId)

    // 清除状态缓存、事件缓冲区、统计和 assistant 合并缓冲
    this.lastBroadcastStatus.delete(sessionId)
    this.sessionEventBuffers.delete(sessionId)
    this.bufferTruncated.delete(sessionId)
    this.sessionProjectPaths.delete(sessionId)
    this.sessionStats.delete(sessionId)
    const pending = this.pendingAssistantEvents.get(sessionId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingAssistantEvents.delete(sessionId)
    }

    await this.provider.killSession(sessionId)

    console.log(`[SessionManager] Session killed: ${sessionId}`)
  }

  /**
   * 获取会话的缓冲事件（用于新订阅者重放）
   */
  getSessionEvents(sessionId: string): ClaudeStreamEvent[] {
    return this.sessionEventBuffers.get(sessionId) ?? []
  }

  /**
   * 检查会话的缓冲区是否曾被截断（溢出过 BUFFER_MAX）
   */
  isBufferTruncated(sessionId: string): boolean {
    return this.bufferTruncated.has(sessionId)
  }

  /**
   * 获取会话的项目路径（用于截断时从 JSONL 补全历史）
   */
  getSessionProjectPath(sessionId: string): string | undefined {
    return this.sessionProjectPaths.get(sessionId)
  }

  /**
   * 处理 AskUserQuestion 回答（从手机端传来）
   */
  handleQuestionResponse(requestId: string, answer: string): void {
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) {
      console.warn(`[SessionManager] Question request not found: ${requestId}`)
      return
    }

    this.pendingQuestions.delete(requestId)

    // 回答完成后，会话状态回到 running
    this.updateSessionStatus(pending.sessionId, 'running')

    pending.resolve(answer)
    console.log(`[SessionManager] Question answered: ${requestId}`)
  }

  /**
   * 获取指定会话的所有待回答问题（用于重连时恢复）
   */
  getPendingQuestionsForSession(sessionId: string): QuestionRequest[] {
    const result: QuestionRequest[] = []
    for (const [requestId, pending] of this.pendingQuestions) {
      if (pending.sessionId === sessionId) {
        result.push({
          id: requestId,
          sessionId,
          toolUseId: pending.toolUseId,
          question: pending.question,
          options: pending.options,
          createdAt: pending.createdAt,
        })
      }
    }
    return result
  }

  /** 检查某个问题是否仍在等待回答 */
  isQuestionPending(requestId: string): boolean {
    return this.pendingQuestions.has(requestId)
  }

  /**
   * 获取所有待回答问题（用于客户端重连时恢复状态）
   */
  getAllPendingQuestions(): QuestionRequest[] {
    const result: QuestionRequest[] = []
    for (const [requestId, pending] of this.pendingQuestions) {
      result.push({
        id: requestId,
        sessionId: pending.sessionId,
        toolUseId: pending.toolUseId,
        question: pending.question,
        options: pending.options,
        createdAt: pending.createdAt,
      })
    }
    return result
  }

  /**
   * 获取所有活跃会话（含服务器端统计）
   */
  getActiveSessions(): Session[] {
    return this.provider.getActiveSessions().map((session) => {
      const stats = this.getSessionStats(session.id)
      return stats ? { ...session, stats } : session
    })
  }

  /**
   * 注册事件回调（事件会被转发到 WsBridge）
   *
   * @returns 取消注册的函数
   */
  onEvent(callback: (event: ServerEvent) => void): () => void {
    this.eventCallbacks.push(callback)

    return () => {
      const index = this.eventCallbacks.indexOf(callback)
      if (index !== -1) {
        this.eventCallbacks.splice(index, 1)
      }
    }
  }

  /**
   * 清理所有资源
   */
  destroy(): void {
    // 取消所有事件订阅
    for (const [, unsub] of this.unsubscribeMap) {
      unsub()
    }
    this.unsubscribeMap.clear()
    this.sessionEventBuffers.clear()
    this.bufferTruncated.clear()
    this.sessionProjectPaths.clear()
    this.sessionStats.clear()

    // 清理 assistant 事件合并定时器
    for (const [, pending] of this.pendingAssistantEvents) {
      clearTimeout(pending.timer)
    }
    this.pendingAssistantEvents.clear()

    // 清除所有待回答问题
    this.pendingQuestions.clear()
    this.lastBroadcastStatus.clear()
    this.eventCallbacks.length = 0

    console.log('[SessionManager] Destroyed')
  }

  // ============================================
  // 内部方法
  // ============================================

  /**
   * 订阅指定会话的事件流（包括 AskUserQuestion 问题事件）
   */
  private subscribeToSession(sessionId: string): void {
    const unsubscribeEvent = this.provider.onEvent(sessionId, (event) => {
      this.handleClaudeEvent(sessionId, event)
    })

    const unsubscribeQuestion = this.provider.onQuestion(
      sessionId,
      ({ toolUseId, question, options }) => {
        this.handleAskUserQuestion(sessionId, toolUseId, question, options)
      },
    )

    this.unsubscribeMap.set(sessionId, () => {
      unsubscribeEvent()
      unsubscribeQuestion()
    })
  }

  /**
   * 取消指定会话的事件订阅
   */
  private unsubscribeSession(sessionId: string): void {
    const unsub = this.unsubscribeMap.get(sessionId)
    if (unsub) {
      unsub()
      this.unsubscribeMap.delete(sessionId)
    }
  }

  /**
   * 处理来自 provider 的 Claude 事件
   *
   * - 包装为 ServerEvent 转发
   * - assistant 事件在 30ms 窗口内合并后批量发送（减少 WebSocket 帧数）
   * - 检测 status 变化
   */
  private handleClaudeEvent(sessionId: string, event: ClaudeStreamEvent): void {
    // 1. 缓冲事件（供新订阅者重放）
    const buffer = this.sessionEventBuffers.get(sessionId) ?? []
    buffer.push(event)
    // 限制缓冲区大小（最多保留最新事件）
    if (buffer.length > BUFFER_MAX) {
      buffer.splice(0, buffer.length - BUFFER_MAX)
      this.bufferTruncated.add(sessionId)
    }
    this.sessionEventBuffers.set(sessionId, buffer)

    // 2. 根据事件类型处理
    // DEBUG: 检测 thinking 内容块
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      const thinkingBlocks = event.message.content.filter((b: any) => b.type === 'thinking')
      if (thinkingBlocks.length > 0) {
        console.log(`[SessionManager] 🧠 thinking block detected in ${sessionId}: msgId=${event.message.id}, blocks=${thinkingBlocks.length}, len=${thinkingBlocks.map((b: any) => (b.thinking || '').length).join(',')}`)
      }
    }

    switch (event.type) {
      case 'assistant':
        // 合并 assistant 事件：30ms 窗口内累积后一次性发送
        this.bufferAssistantEvent(sessionId, event)
        break

      case 'system':
        // 非 assistant 事件：先 flush 已缓冲的 assistant 事件（保证顺序），再立即转发
        this.flushPendingAssistant(sessionId)
        this.emit({ type: 'claude_event', sessionId, event })
        if (event.subtype === 'init') {
          this.updateSessionStatus(sessionId, 'running')
        }
        break

      case 'user':
        this.flushPendingAssistant(sessionId)
        this.emit({ type: 'claude_event', sessionId, event })
        break

      case 'result': {
        this.flushPendingAssistant(sessionId)
        this.emit({ type: 'claude_event', sessionId, event })

        // 累计会话统计（来自 result 事件的权威数据）
        const stats = this.sessionStats.get(sessionId) ?? {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalDurationMs: 0,
        }
        // duration 由 wall-clock 跟踪（updateSessionStatus），不使用 CLI 的 duration_ms
        if (event.usage) {
          stats.totalInputTokens += event.usage.input_tokens ?? 0
          stats.totalOutputTokens += event.usage.output_tokens ?? 0
        }
        if (event.total_cost_usd != null) {
          stats.totalCostUsd = (stats.totalCostUsd ?? 0) + event.total_cost_usd
        }
        this.sessionStats.set(sessionId, stats)

        if (event.is_error) {
          this.updateSessionStatus(sessionId, 'error')
        } else {
          this.updateSessionStatus(sessionId, 'idle')
        }
        break
      }
    }
  }

  /**
   * 缓冲 assistant 事件到 30ms 窗口
   */
  private bufferAssistantEvent(sessionId: string, event: ClaudeStreamEvent): void {
    let pending = this.pendingAssistantEvents.get(sessionId)
    if (!pending) {
      pending = {
        events: [],
        timer: setTimeout(() => this.flushPendingAssistant(sessionId), 30),
      }
      this.pendingAssistantEvents.set(sessionId, pending)
    }
    pending.events.push(event)
  }

  /**
   * 刷新缓冲的 assistant 事件，批量发送
   * Public：subscribe 时需要在读取缓冲区前先刷出，避免事件同时出现在 session_history 和广播中
   */
  flushPendingAssistant(sessionId: string): void {
    const pending = this.pendingAssistantEvents.get(sessionId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingAssistantEvents.delete(sessionId)

    if (pending.events.length === 1) {
      // 只有一条事件，不用批量包装
      this.emit({ type: 'claude_event', sessionId, event: pending.events[0] })
    } else if (pending.events.length > 1) {
      // 多条事件，用 claude_events（复数）批量发送
      this.emit({ type: 'claude_events', sessionId, events: pending.events })
    }
  }

  /**
   * 更新会话状态，如果状态发生变化则广播通知
   *
   * 使用 lastBroadcastStatus 去重，只在状态实际变化时广播。
   */
  private updateSessionStatus(sessionId: string, newStatus: SessionStatus): void {
    const lastStatus = this.lastBroadcastStatus.get(sessionId)

    if (lastStatus !== newStatus) {
      // wall-clock 时长跟踪：离开 running 时累加，进入 running 时记录起点
      if (lastStatus === 'running') {
        const startedAt = this.runningStartedAt.get(sessionId)
        if (startedAt) {
          const stats = this.sessionStats.get(sessionId) ?? {
            totalInputTokens: 0, totalOutputTokens: 0, totalDurationMs: 0,
          }
          stats.totalDurationMs += Date.now() - startedAt
          this.sessionStats.set(sessionId, stats)
          this.runningStartedAt.delete(sessionId)
        }
      }
      if (newStatus === 'running') {
        this.runningStartedAt.set(sessionId, Date.now())
      }

      this.lastBroadcastStatus.set(sessionId, newStatus)

      // 附带最新 stats（含 runningStartedAt）
      const stats = this.getSessionStats(sessionId)

      this.emit({
        type: 'status_change',
        sessionId,
        status: newStatus,
        stats,
      })

      console.log(`[SessionManager] Session ${sessionId} status change: ${lastStatus ?? '(none)'} → ${newStatus}`)
    }
  }

  /** 获取会话统计（含 runningStartedAt） */
  private getSessionStats(sessionId: string): SessionStats | undefined {
    const runningStartedAt = this.runningStartedAt.get(sessionId)
    const stats = this.sessionStats.get(sessionId)
    // running 状态下即使还没收到 result 也返回初始 stats（带 runningStartedAt）
    if (!stats && !runningStartedAt) return undefined
    const base = stats ?? { totalInputTokens: 0, totalOutputTokens: 0, totalDurationMs: 0 }
    return runningStartedAt ? { ...base, runningStartedAt } : base
  }

  /**
   * 处理 AskUserQuestion 事件：广播问题请求到手机，等待用户回答
   */
  private handleAskUserQuestion(
    sessionId: string,
    toolUseId: string,
    question: string,
    options?: string[],
  ): void {
    // 检查是否已有同 toolUseId 的 pending question（partial → final 更新场景）
    const existingEntry = Array.from(this.pendingQuestions.entries()).find(
      ([, v]) => v.toolUseId === toolUseId,
    )

    if (existingEntry) {
      // 同 toolUseId 再次触发：更新问题内容（options 可能变更），重新广播
      const [existingRequestId] = existingEntry
      const updatedRequest: QuestionRequest = {
        id: existingRequestId,
        sessionId,
        toolUseId,
        question,
        options,
        createdAt: Date.now(),
      }
      this.emit({ type: 'question_request', request: updatedRequest })
      console.log(`[SessionManager] Session ${sessionId}: AskUserQuestion updated (requestId=${existingRequestId})`)
      return
    }

    const requestId = uuidv4()

    const request: QuestionRequest = {
      id: requestId,
      sessionId,
      toolUseId,
      question,
      options,
      createdAt: Date.now(),
    }

    // 更新会话状态为等待回答
    this.updateSessionStatus(sessionId, 'waiting_question')

    // 广播问题请求到手机端
    this.emit({ type: 'question_request', request })

    // 等待用户回答，然后通过 provider.answerQuestion 写入 stdin
    const answerPromise = new Promise<string>((resolve) => {
      this.pendingQuestions.set(requestId, { sessionId, toolUseId, question, options, createdAt: request.createdAt, resolve })
    })

    answerPromise.then(async (answer) => {
      try {
        await this.provider.answerQuestion(sessionId, toolUseId, answer)
      } catch (err) {
        console.error(`[SessionManager] answerQuestion failed (${sessionId}):`, err)
      }
    }).catch((err) => console.error('[SessionManager] answerPromise rejected:', err))

    console.log(`[SessionManager] Session ${sessionId}: AskUserQuestion pushed (requestId=${requestId})`)
  }

  /**
   * 清除指定会话的所有待回答问题
   */
  private clearPendingQuestions(sessionId: string): void {
    const toRemove: string[] = []
    for (const [requestId, pending] of this.pendingQuestions) {
      if (pending.sessionId === sessionId) {
        toRemove.push(requestId)
      }
    }
    for (const requestId of toRemove) {
      this.pendingQuestions.delete(requestId)
    }
  }

  /**
   * 发出 ServerEvent 到所有已注册的回调
   */
  private emit(event: ServerEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event)
      } catch (err) {
        console.error('[SessionManager] Event callback error:', err)
      }
    }
  }
}
