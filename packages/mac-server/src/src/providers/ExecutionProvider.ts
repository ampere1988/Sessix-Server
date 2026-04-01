import type { Session, ClaudeStreamEvent, PermissionMode, EffortLevel, ImageAttachment } from '@sessix/shared'

// ============================================
// 执行提供者接口定义
// ============================================

/** 启动会话的选项 */
export interface StartSessionOptions {
  /** 项目的绝对路径 */
  projectPath: string
  /** 发送给 Claude 的消息 */
  message: string
  /** 恢复已有会话时传入该会话的 ID（使用 --resume） */
  sessionId?: string
  /** true = --resume（恢复）；false = --session-id（新建但指定 ID）；默认跟随 sessionId 是否存在 */
  resume?: boolean
  /** 使用的模型别名（haiku / sonnet / opus），不传则用 claude 默认 */
  model?: string
  /** 权限模式（plan = 先规划再执行） */
  permissionMode?: PermissionMode
  /** 思考等级 */
  effort?: EffortLevel
  /** 图片附件 */
  images?: ImageAttachment[]
}

/**
 * 执行提供者接口
 *
 * 所有控制 Claude CLI 进程的操作必须通过此接口，
 * 当前实现为 ProcessProvider（直接 spawn 进程），
 * 未来可替换为 DockerProvider 等其他实现。
 */
export interface ExecutionProvider {
  /** 启动新会话或恢复已有会话 */
  startSession(opts: StartSessionOptions): Promise<Session>

  /** 终止指定会话 */
  killSession(sessionId: string): Promise<void>

  /** 向已有会话发送新消息（会重启进程并携带相同 session-id） */
  sendMessage(sessionId: string, message: string, permissionMode?: PermissionMode, images?: ImageAttachment[]): Promise<void>

  /** 订阅指定会话的 Claude 事件流，返回取消订阅函数 */
  onEvent(sessionId: string, callback: (event: ClaudeStreamEvent) => void): () => void

  /** 获取当前所有活跃会话列表 */
  getActiveSessions(): Session[]

  /**
   * 根据对话上下文生成下一步建议指令（一次性调用，不关联任何会话）
   *
   * @param context 最近的对话内容（格式化为纯文本）
   * @returns 建议的指令文本
   */
  generateSuggestion(context: string): Promise<string>

  /**
   * 向正在等待中的 AskUserQuestion 提供答案
   *
   * 通过 stdin 写入 tool_result 让 Claude 继续执行。
   * @param sessionId 会话 ID
   * @param toolUseId AskUserQuestion tool_use 块的 id
   * @param answer 用户的答案文本
   */
  answerQuestion(sessionId: string, toolUseId: string, answer: string): Promise<void>

  /**
   * 订阅指定会话的 AskUserQuestion 事件
   *
   * @returns 取消订阅函数
   */
  onQuestion(
    sessionId: string,
    callback: (data: { toolUseId: string; question: string; options?: string[] }) => void,
  ): () => void
}
