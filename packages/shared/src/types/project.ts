export interface Project {
  /** URL-encoded 路径作为 ID */
  id: string
  /** 解码后的实际路径 */
  path: string
  /** 项目名称（路径最后一段） */
  name: string
  /** 该项目下的会话数量 */
  sessionCount: number
  /** 最近一次会话文件的修改时间（ms since epoch），无会话时为 0 */
  lastActiveAt: number
}
