import type { Session, SessionStatus, SessionStats, EffortLevel, ApprovalRequest, QuestionRequest, HistoricalSession } from './session.js'
import type { Project } from './project.js'

// ============================================
// Claude Code stream-json 事件类型
// ============================================

/** Claude CLI stream-json 输出的系统事件 */
export interface ClaudeSystemEvent {
  type: 'system'
  subtype: 'init' | 'hook_started' | 'hook_response'
  session_id: string
  [key: string]: unknown
}

/** Claude CLI stream-json 输出的 assistant 消息事件 */
export interface ClaudeAssistantEvent {
  type: 'assistant'
  message: {
    id: string
    model: string
    role: 'assistant'
    content: ClaudeContentBlock[]
    stop_reason?: string
    usage?: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  session_id: string
}

export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'thinking'; thinking: string }

export type UserContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string | Array<{ type: 'text'; text: string }>
      is_error?: boolean
    }

/** Claude CLI stream-json 输出的 user 消息事件（工具结果等） */
export interface ClaudeUserEvent {
  type: 'user'
  message: {
    role: 'user'
    content: string | UserContentBlock[]
  }
  session_id: string
}

/** Claude CLI stream-json 输出的结果事件 */
export interface ClaudeResultEvent {
  type: 'result'
  subtype: 'success' | 'error'
  is_error: boolean
  duration_ms: number
  num_turns: number
  result: string
  session_id: string
  total_cost_usd?: number
  usage?: {
    input_tokens: number
    output_tokens: number
  }
}

/** 所有 Claude CLI stream-json 事件的联合类型 */
export type ClaudeStreamEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent

// ============================================
// Sessix WebSocket 事件类型
// ============================================

/** 后端 → 手机 */
export type ServerEvent =
  | { type: 'claude_event'; sessionId: string; event: ClaudeStreamEvent }
  | { type: 'claude_events'; sessionId: string; events: ClaudeStreamEvent[] }
  | { type: 'status_change'; sessionId: string; status: SessionStatus; stats?: SessionStats }
  | { type: 'approval_request'; request: ApprovalRequest }
  | { type: 'question_request'; request: QuestionRequest }
  | { type: 'session_list'; sessions: Session[] }
  | { type: 'project_list'; projects: Project[] }
  | { type: 'project_sessions'; projectPath: string; sessions: HistoricalSession[] }
  | { type: 'session_history'; sessionId: string; events: ClaudeStreamEvent[] }
  | { type: 'prompt_suggestion'; sessionId: string; suggestion: string }
  | { type: 'unread_sessions'; sessionIds: string[] }
  | { type: 'error'; code: 'SESSION_CREATE_ERROR' | 'SEND_MESSAGE_ERROR' | 'KILL_SESSION_ERROR' | 'APPROVE_ERROR' | 'REJECT_ERROR' | 'ANSWER_QUESTION_ERROR' | 'PROJECT_LIST_ERROR' | 'PROJECT_SESSIONS_ERROR' | 'SESSION_HISTORY_ERROR' | 'SUGGEST_PROMPT_ERROR' | 'UNKNOWN_EVENT' | 'INVALID_MESSAGE' | 'INTERNAL_ERROR' | 'TERMINAL_EXEC_ERROR'; message: string; sessionId?: string }
  | { type: 'auth_status'; loggedIn: boolean; email?: string; authMethod?: string }
  | { type: 'auth_login_url'; url: string }
  | { type: 'auth_login_result'; success: boolean; error?: string }
  | { type: 'heartbeat'; timestamp: number }
  | { type: 'terminal_output'; sessionId: string; execId: string; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'terminal_exit'; sessionId: string; execId: string; code: number | null; signal: string | null }

/** Claude Code 权限模式 */
export type PermissionMode = 'default' | 'plan'

/** 图片附件（base64 编码） */
export interface ImageAttachment {
  /** base64 编码的图片数据（不含 data:image/... 前缀） */
  data: string
  /** MIME 类型 */
  media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
}

/** 通知音效偏好（每种通知类型可独立设置） */
export interface NotificationSoundPreferences {
  /** 审批请求音效 */
  approval?: string
  /** 任务完成音效 */
  taskComplete?: string
  /** 任务错误音效 */
  taskError?: string
}

/** 手机 → 后端 */
export type ClientEvent =
  | { type: 'send_message'; sessionId: string; message: string; images?: ImageAttachment[]; permissionMode?: PermissionMode }
  | { type: 'approve'; requestId: string }
  | { type: 'reject'; requestId: string; reason?: string }
  | { type: 'answer_question'; requestId: string; answer: string }
  | { type: 'create_session'; projectPath: string; message: string; images?: ImageAttachment[]; resumeSessionId?: string; newSessionId?: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel }
  | { type: 'kill_session'; sessionId: string }
  | { type: 'subscribe'; sessionId: string }
  | { type: 'list_projects' }
  | { type: 'list_sessions'; projectPath: string }
  | { type: 'list_project_sessions'; projectPath: string }
  | { type: 'load_session_history'; projectPath: string; sessionId: string }
  | { type: 'suggest_next_prompt'; sessionId: string; projectPath: string }
  | { type: 'register_push_token'; token: string }
  | { type: 'unregister_push_token'; token: string }
  | { type: 'register_activity_push_token'; sessionId: string; token: string }
  | { type: 'unregister_activity_push_token'; sessionId: string }
  | { type: 'set_yolo_mode'; sessionId: string; enabled: boolean }
  | { type: 'always_allow_tool'; sessionId: string; projectPath: string; toolName: string }
  | { type: 'viewing_session'; sessionId: string }
  | { type: 'left_session'; sessionId: string }
  | { type: 'check_auth' }
  | { type: 'start_auth_login' }
  | { type: 'submit_auth_code'; code: string }
  | { type: 'update_notification_sounds'; preferences: NotificationSoundPreferences }
  | { type: 'terminal_exec'; sessionId: string; command: string }
  | { type: 'terminal_kill'; sessionId: string; execId: string }
