/** Claude Code 思考等级 */
export type EffortLevel = 'low' | 'medium' | 'high'

export type SessionStatus =
  | 'idle'              // 空闲，等待用户输入
  | 'running'           // Claude 正在执行
  | 'waiting_approval'  // 等待用户审批工具调用
  | 'waiting_question'  // Claude 提问，等待用户回答（AskUserQuestion）
  | 'completed'         // 本轮任务完成
  | 'error'             // 出错

/** 服务器端统计的会话累计指标 */
export interface SessionStats {
  /** 累计输入 token 数 */
  totalInputTokens: number
  /** 累计输出 token 数 */
  totalOutputTokens: number
  /** 累计费用（USD） */
  totalCostUsd?: number
  /** 累计执行时长（ms），wall-clock 时间 */
  totalDurationMs: number
  /** 当前 running 状态的起始时间戳（仅 running 时有值，用于客户端实时计时） */
  runningStartedAt?: number
}

export interface Session {
  id: string
  projectId: string
  projectPath: string
  status: SessionStatus
  createdAt: number
  lastActiveAt: number
  /** 活跃进程的 PID（仅当 status 为 running/waiting_approval 时有值） */
  pid?: number
  /** 服务器统计的会话累计指标 */
  stats?: SessionStats
  /** 会话名称（创建会话时用户发送的第一条消息，截取前 80 字符） */
  summary?: string
}

export interface ApprovalRequest {
  id: string
  sessionId: string
  /** 项目路径（用于写入项目级 .claude/settings.json） */
  projectPath: string
  /** Claude Code 工具名（Write, Edit, Bash, etc.） */
  toolName: string
  /** 工具的输入参数 */
  toolInput: Record<string, unknown>
  /** 人类可读描述 */
  description: string
  createdAt: number
}

export type ApprovalDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason?: string }

/** Claude Code AskUserQuestion 工具调用请求 */
export interface QuestionRequest {
  id: string
  sessionId: string
  /** AskUserQuestion tool_use 的 id（用于写入 tool_result） */
  toolUseId: string
  /** Claude 提出的问题文本 */
  question: string
  /** 可选的预设选项列表（有时 Claude 会提供选项让用户选择） */
  options?: string[]
  createdAt: number
}

/** Claude Code 历史会话（来自 sessions-index.json 或 .jsonl 文件扫描） */
export interface HistoricalSession {
  sessionId: string
  lastModified: number
  /** Claude Code 自动生成的会话摘要 */
  summary?: string
  /** 用户的第一条提示词 */
  firstPrompt?: string
  /** 该会话的消息数量 */
  messageCount?: number
}
