import chokidar, { type FSWatcher } from 'chokidar'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { ClaudeStreamEvent, ServerEvent } from '@sessix/shared'
import { t } from '../i18n/index.js'

/**
 * 监听 JSONL 会话文件的新增内容，推送到手机端。
 *
 * 使用场景：用户从 Sessix App 切到 VS Code（或其他客户端）继续会话后，
 * Sessix 不再管理该进程，但可以通过监听 JSONL 文件实时获取新消息。
 *
 * 轻度监听策略：
 * - 使用 chokidar 原生 FS 事件（非 polling），CPU 开销极低
 * - awaitWriteFinish 300ms 防抖，避免每次字节写入都触发
 * - 10 分钟无变化自动停止，不持续占用资源
 * - 只跟踪"字节偏移量"，每次仅读新增部分
 */
export class SessionFileWatcher {
  private watchers = new Map<string, WatchEntry>()
  private onEvent: (event: ServerEvent) => void

  /** 文件无变化后自动停止监听的超时时间（10 分钟） */
  private readonly IDLE_TIMEOUT_MS = 10 * 60 * 1000

  constructor(onEvent: (event: ServerEvent) => void) {
    this.onEvent = onEvent
  }

  /**
   * 开始监听指定会话的 JSONL 文件新增内容
   *
   * @param sessionId    会话 ID
   * @param filePath     JSONL 文件绝对路径
   * @param byteOffset   已读到的字节位置（跳过历史内容，只推送新行）
   */
  watch(sessionId: string, filePath: string, byteOffset: number): void {
    // 同一会话不重复启动
    if (this.watchers.has(sessionId)) return

    const watcher = chokidar.watch(filePath, {
      persistent: false,   // 不阻止进程退出
      usePolling: false,   // 使用原生 FS 事件，不轮询
      awaitWriteFinish: {
        stabilityThreshold: 300,  // 写入停止 300ms 后才触发
        pollInterval: 100,
      },
    })

    const entry: WatchEntry = {
      filePath,
      byteOffset,
      idleTimer: null,
      watcher,
    }

    watcher.on('change', () => {
      this.readNewLines(sessionId).catch((err) => {
        console.error(`[SessionFileWatcher] ${t('watcher.readError', { sessionId })}:`, err)
      })
      this.resetIdleTimer(sessionId)
    })

    this.watchers.set(sessionId, entry)
    this.resetIdleTimer(sessionId)

    console.log(`[SessionFileWatcher] ${t('watcher.startWatching')}: ${sessionId} (offset=${byteOffset})`)
  }

  /** 停止监听指定会话 */
  unwatch(sessionId: string): void {
    const entry = this.watchers.get(sessionId)
    if (!entry) return

    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    void entry.watcher.close()
    this.watchers.delete(sessionId)

    console.log(`[SessionFileWatcher] ${t('watcher.stopWatching')}: ${sessionId}`)
  }

  /** 停止所有监听（服务关闭时调用） */
  destroy(): void {
    for (const sessionId of [...this.watchers.keys()]) {
      this.unwatch(sessionId)
    }
  }

  // ============================================
  // 内部方法
  // ============================================

  private resetIdleTimer(sessionId: string): void {
    const entry = this.watchers.get(sessionId)
    if (!entry) return

    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      console.log(`[SessionFileWatcher] Idle timeout, stop watching: ${sessionId}`)
      this.unwatch(sessionId)
    }, this.IDLE_TIMEOUT_MS)
  }

  private async readNewLines(sessionId: string): Promise<void> {
    const entry = this.watchers.get(sessionId)
    if (!entry) return

    let fileHandle
    let rl: ReturnType<typeof createInterface> | undefined
    try {
      fileHandle = await open(entry.filePath, 'r')
      const fileStat = await fileHandle.stat()
      const newSize = fileStat.size

      // 文件没有变大（可能是 mtime 刷新但无新内容）
      if (newSize <= entry.byteOffset) return

      rl = createInterface({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input: fileHandle.createReadStream({ start: entry.byteOffset, encoding: 'utf-8' } as any),
        crlfDelay: Infinity,
      })

      const newEvents: ClaudeStreamEvent[] = []
      let isCompleted = false
      let isError = false

      for await (const line of rl) {
        if (!line.trim()) continue
        const parsed = parseJSONLLine(line, sessionId)
        if (parsed.type === 'event' && parsed.event) {
          newEvents.push(parsed.event)
        } else if (parsed.type === 'completed') {
          isCompleted = true
          isError = parsed.isError
        }
      }

      // 更新偏移量（标记为已读）
      entry.byteOffset = newSize

      // 推送新消息
      for (const event of newEvents) {
        this.onEvent({ type: 'claude_event', sessionId, event })
      }

      // 会话结束：推送状态变更并停止监听
      if (isCompleted) {
        this.onEvent({ type: 'status_change', sessionId, status: isError ? 'error' : 'idle' })
        this.unwatch(sessionId)
      }
    } finally {
      rl?.close()
      await fileHandle?.close()
    }
  }
}

// ============================================
// 类型与工具
// ============================================

interface WatchEntry {
  filePath: string
  byteOffset: number
  idleTimer: NodeJS.Timeout | null
  watcher: FSWatcher
}

type ParseResult =
  | { type: 'event'; event: ClaudeStreamEvent }
  | { type: 'completed'; isError: boolean }
  | { type: 'skip' }

/**
 * 解析一行 JSONL，转为 ClaudeStreamEvent（与 getSessionHistory 解析逻辑一致）
 */
function parseJSONLLine(line: string, sessionId: string): ParseResult {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = JSON.parse(line) as any

    if (obj.type === 'user' && obj.message) {
      const msgContent = obj.message.content

      // 过滤系统命令消息
      if (typeof msgContent === 'string') {
        if (msgContent.includes('<local-command') || msgContent.includes('<command-name>')) {
          return { type: 'skip' }
        }
      }

      const normalizedContent = typeof msgContent === 'string'
        ? [{ type: 'text' as const, text: msgContent }]
        : Array.isArray(msgContent)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? msgContent.filter((b: any) => b.type === 'text' && typeof b.text === 'string')
          : []

      if (normalizedContent.length === 0) return { type: 'skip' }

      return {
        type: 'event',
        event: {
          type: 'user',
          message: { ...obj.message, content: normalizedContent },
          session_id: sessionId,
        },
      }
    }

    if (obj.type === 'assistant' && obj.message) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const content = (obj.message.content ?? []).filter((b: any) => b.type === 'text' || b.type === 'tool_use')
      if (content.length === 0) return { type: 'skip' }

      return {
        type: 'event',
        event: {
          type: 'assistant',
          message: {
            id: obj.message.id ?? obj.uuid ?? 'unknown',
            model: obj.message.model ?? 'unknown',
            role: 'assistant',
            content,
            stop_reason: obj.message.stop_reason,
          },
          session_id: sessionId,
        },
      }
    }

    if (obj.type === 'result') {
      return { type: 'completed', isError: !!obj.is_error }
    }

    return { type: 'skip' }
  } catch {
    return { type: 'skip' }
  }
}
