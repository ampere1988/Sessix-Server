import { t } from './i18n'
import { v4 as uuidv4 } from 'uuid'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { ProcessProvider } from './providers/ProcessProvider.js'
import { SessionManager } from './session/SessionManager.js'
import { SessionFileWatcher } from './session/SessionFileWatcher.js'
import { WsBridge } from './ws/WsBridge.js'
import { ApprovalProxy } from './approval/ApprovalProxy.js'
import { MdnsService } from './mdns/MdnsService.js'
import { HookInstaller } from './hooks/HookInstaller.js'
import { NotificationService } from './notification/NotificationService.js'
import { DesktopNotificationChannel } from './notification/DesktopNotificationChannel.js'
import { ExpoNotificationChannel } from './notification/ExpoNotificationChannel.js'
import { ActivityPushChannel } from './notification/ActivityPushChannel.js'
import { getProjects, getHistoricalSessions, getSessionHistory, getSessionFilePath } from './session/ProjectReader.js'
import { PairingManager } from './pairing/PairingManager.js'
import { isWindows } from './utils/platform.js'
import { AuthManager } from './auth/AuthManager.js'
import { stat } from 'node:fs/promises'
import { TerminalExecutor } from './terminal/TerminalExecutor.js'
import type { ClientEvent, ServerEvent, Session } from '@sessix/shared'

// ============================================
// 端口和配置
// ============================================

const WS_PORT = 3745
const HTTP_PORT = 3746

// ============================================
// 端口冲突处理
// ============================================

const execAsync = promisify(exec)

/** 找到占用指定端口的进程并 kill，等待端口释放 */
async function killPortProcess(port: number): Promise<void> {
  try {
    if (isWindows) {
      const { stdout } = await execAsync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
      )
      const pids = new Set<string>()
      for (const line of stdout.trim().split('\n')) {
        const parts = line.trim().split(/\s+/)
        const pid = parts[parts.length - 1]
        if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid)
      }
      for (const pid of pids) {
        await execAsync(`taskkill /PID ${pid} /F`).catch(() => {})
      }
    } else {
      const { stdout } = await execAsync(`lsof -ti :${port}`)
      const pids = stdout.trim().split('\n').filter(p => p && /^\d+$/.test(p))
      if (pids.length > 0) {
        await execAsync(`kill -9 ${pids.join(' ')}`)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 600))
  } catch {
    // 端口已空闲或 kill 失败，忽略
  }
}

/** 创建服务，EADDRINUSE 时自动 kill 旧进程并重试一次 */
async function createWithRetry<T>(
  label: string,
  port: number,
  factory: () => Promise<T>,
): Promise<T> {
  try {
    return await factory()
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
      console.warn(`[Server] ${t('server.portInUse', { port })}`)
      await killPortProcess(port)
      console.log(`[Server] ${t('server.restarting', { label })}`)
      return await factory()
    }
    throw err
  }
}

// ============================================
// 公开接口
// ============================================

export interface ServerInstance {
  token: string
  wsPort: number
  httpPort: number
  getActiveSessions: () => Session[]
  getConnectionCount: () => number
  stop: () => Promise<void>
  /** 运行时切换本地 Mac 通知 */
  setMacNotification: (enabled: boolean) => void
  /** 运行时切换 Expo 远程推送 */
  setExpoPush: (enabled: boolean) => void
  /** 订阅所有 ServerEvent（供 Electron 内部使用，例如 Token 统计） */
  onServerEvent: (cb: (event: ServerEvent) => void) => () => void
  /** 运行时切换 mDNS 自动发现 */
  setAutoConnect: (enabled: boolean) => void
  /** 运行时开启配对窗口 */
  openPairing: (duration?: number) => void
  /** 运行时关闭配对窗口 */
  closePairing: () => void
  /** 重新生成 token（泄露后刷新），断开所有客户端并开启配对窗口 */
  regenerateToken: () => Promise<string>
}

export interface ServerOptions {
  /** 覆盖 token（默认读取 ~/.sessix/token 或自动生成） */
  token?: string
  enableMacNotification?: boolean
  enableExpoPush?: boolean
  /** ActivityKit Push 配置（可选，用于后台更新 Live Activity） */
  activityPush?: {
    teamId: string
    keyId: string
    authKeyPath: string
    sandbox?: boolean
  }
  /** 是否启用 mDNS 自动发现（默认 true） */
  enableAutoConnect?: boolean
  /** 是否启用配对模式（默认 true，Electron 传 false） */
  enablePairing?: boolean
}

// ============================================
// start 函数
// ============================================

export async function start(opts: ServerOptions = {}): Promise<ServerInstance> {
  // 1. Token 设置
  const configDir = join(homedir(), '.sessix')
  const tokenFile = join(configDir, 'token')

  let token: string
  if (opts.token !== undefined) {
    token = opts.token
  } else {
    const envToken = process.env.SESSIX_TOKEN
    if (envToken !== undefined) {
      token = envToken
    } else {
      try {
        token = (await readFile(tokenFile, 'utf8')).trim()
      } catch {
        token = uuidv4()
        await mkdir(configDir, { recursive: true })
        await writeFile(tokenFile, token, 'utf8')
      }
    }
  }

  // 2. 实例化核心模块
  const provider = new ProcessProvider()
  const sessionManager = new SessionManager(provider)
  const terminalExecutor = new TerminalExecutor()

  // 3. WebSocket 服务（提前创建，unread tracking 依赖它）
  const wsBridge = await createWithRetry('WsBridge', WS_PORT, () =>
    WsBridge.create({ port: WS_PORT, token }),
  )

  // 3.1 未读会话追踪：完成（idle/error）但用户未查看的会话
  // 必须在 NotificationService 之前注册，确保推送的 badge 数包含刚完成的会话
  const unreadSessionIds = new Set<string>()
  sessionManager.onEvent((event) => {
    if (event.type === 'status_change' && (event.status === 'idle' || event.status === 'error')) {
      if (!wsBridge.isViewingSession(event.sessionId)) {
        unreadSessionIds.add(event.sessionId)
      }
    }
  })

  // 4. 通知服务（订阅事件在 unread tracking 之后，badge 计数准确）
  const expoChannel = new ExpoNotificationChannel()
  const notificationService = new NotificationService(sessionManager, expoChannel)
  notificationService.addChannel('expo', expoChannel, opts.enableExpoPush !== false)
  notificationService.addChannel('mac', new DesktopNotificationChannel(), opts.enableMacNotification !== false)

  // 4.1 ActivityKit Push（可选，需要 APNs 认证配置）
  if (opts.activityPush) {
    try {
      const activityChannel = new ActivityPushChannel(opts.activityPush)
      notificationService.setActivityPushChannel(activityChannel)
      console.log(`[Server] ${t('server.activityPushEnabled')}`)
    } catch (err) {
      console.warn(`[Server] ${t('server.activityPushFailed')}`, err)
      console.log(`[Server] ${t('server.activityPushContinue')}`)
    }
  }

  // 5. SessionFileWatcher
  const sessionFileWatcher = new SessionFileWatcher((event) => {
    wsBridge.broadcast(event)
  })

  // 6. ApprovalProxy
  const approvalProxy = await createWithRetry('ApprovalProxy', HTTP_PORT, () =>
    ApprovalProxy.create({ port: HTTP_PORT, token }),
  )

  // 6.5 配对管理器
  let mdnsService: MdnsService | null = null
  const pairingManager = new PairingManager({
    token,
    serverName: hostname(),
    version: '0.2.0',
    onStateChange: (state) => mdnsService?.updatePairingState(state),
  })
  approvalProxy.setPairingManager(pairingManager)

  // 6.6 认证管理器
  const authManager = new AuthManager()
  authManager.on('login_url', (url: string) => {
    wsBridge.broadcast({ type: 'auth_login_url', url })
  })
  authManager.on('login_result', (result: { success: boolean; error?: string }) => {
    wsBridge.broadcast({ type: 'auth_login_result', success: result.success, error: result.error })
    if (result.success) {
      authManager.checkAuth().then((status) => {
        wsBridge.broadcast({ type: 'auth_status', loggedIn: status.loggedIn, email: status.email, authMethod: status.authMethod })
      })
    }
  })

  // 6.1 注册全局 badge 数提供者（pending approvals + questions + 未读会话数）
  notificationService.setGlobalPendingCountProvider(
    () => approvalProxy.getPendingCount() + sessionManager.getAllPendingQuestions().length + unreadSessionIds.size,
  )

  /** 广播未读会话列表到所有客户端 */
  const broadcastUnreadSessions = () => {
    wsBridge.broadcast({ type: 'unread_sessions', sessionIds: Array.from(unreadSessionIds) })
  }

  // 7. 新客户端连接时推送初始数据（含所有 pending requests + 未读会话，恢复红点/角标）
  wsBridge.onConnection(async (ws) => {
    const result = await getProjects()
    if (result.ok) {
      wsBridge.send(ws, { type: 'project_list', projects: result.value })
    }
    wsBridge.send(ws, {
      type: 'session_list',
      sessions: sessionManager.getActiveSessions(),
    })

    // 重发所有 pending approval requests（重连后恢复 HomeScreen 红点）
    for (const req of approvalProxy.getAllPendingRequests()) {
      wsBridge.send(ws, { type: 'approval_request', request: req })
    }
    // 重发所有 pending question requests
    for (const req of sessionManager.getAllPendingQuestions()) {
      wsBridge.send(ws, { type: 'question_request', request: req })
    }
    // 推送未读会话列表
    if (unreadSessionIds.size > 0) {
      wsBridge.send(ws, { type: 'unread_sessions', sessionIds: Array.from(unreadSessionIds) })
    }
  })

  // 8. ClientEvent 处理
  wsBridge.onClientEvent(async (event: ClientEvent, ws) => {
    try {
      switch (event.type) {
        case 'create_session': {
          await mkdir(event.projectPath, { recursive: true })
          // 停止该会话的 JSONL 文件监听器（如果有）。
          // 场景：用户进入历史会话时 load_session_history 启动了 watcher，
          // 随后用户发消息恢复会话 → ProcessProvider 通过 stdout 实时推送事件，
          // 如果 watcher 不停止，它也会检测到 JSONL 变化并广播相同事件，
          // 导致客户端收到双重广播，第一条 AI 回复显示两次。
          const resumeId = event.resumeSessionId ?? event.newSessionId
          if (resumeId) sessionFileWatcher.unwatch(resumeId)
          await sessionManager.createSession(
            event.projectPath,
            event.message,
            event.resumeSessionId,
            event.newSessionId,
            event.model,
            event.permissionMode,
            event.effort,
            event.images,
          )
          wsBridge.broadcast({
            type: 'session_list',
            sessions: sessionManager.getActiveSessions(),
          })
          break
        }

        case 'send_message': {
          // 同 create_session：停止 JSONL watcher 防止双重广播
          // （send_message 慢路径会 respawn 进程，同样会写 JSONL）
          sessionFileWatcher.unwatch(event.sessionId)
          await sessionManager.sendMessage(event.sessionId, event.message, event.permissionMode, event.images)
          wsBridge.broadcast({
            type: 'session_list',
            sessions: sessionManager.getActiveSessions(),
          })
          break
        }

        case 'kill_session': {
          // 立即广播停止状态，让手机端 UI 即时反馈（不等待进程退出的 3 秒）
          wsBridge.broadcast({ type: 'status_change', sessionId: event.sessionId, status: 'idle' })
          // 清理该会话的待处理审批（让 hook 脚本不再阻塞）
          approvalProxy.clearPendingForSession(event.sessionId)
          await sessionManager.killSession(event.sessionId)
          wsBridge.broadcast({
            type: 'session_list',
            sessions: sessionManager.getActiveSessions(),
          })
          break
        }

        case 'approve': {
          approvalProxy.resolveApproval(event.requestId, { decision: 'allow' })
          break
        }

        case 'reject': {
          const decision = { decision: 'deny' as const, reason: event.reason }
          approvalProxy.resolveApproval(event.requestId, decision)
          break
        }

        case 'answer_question': {
          sessionManager.handleQuestionResponse(event.requestId, event.answer)
          break
        }

        case 'subscribe': {
          wsBridge.send(ws, {
            type: 'session_list',
            sessions: sessionManager.getActiveSessions(),
          })

          // 先刷出 30ms 窗口内尚未发送的 assistant 事件批次。
          // 这些事件已经在 sessionEventBuffers 中，但还没有被 broadcast。
          // 如果不刷出，session_history 会包含它们，30ms 后 broadcast 又会再发一次，
          // 客户端聚合器会把相同 delta 追加两次，导致最后一条消息文本重复。
          // 刷出后 broadcast 先于 session_history 到达（WebSocket 保序），
          // 客户端收到 session_history 时会 clear pendingClaudeEvents 并全量重置。
          sessionManager.flushPendingAssistant(event.sessionId)

          // 快照缓冲区（浅拷贝），防止后续 await 期间新事件追加到同一数组引用，
          // 导致 session_history 包含 await 期间才到达的事件（这些事件也会被 broadcast，造成重复）
          const bufferedEvents = [...sessionManager.getSessionEvents(event.sessionId)]

          if (sessionManager.isBufferTruncated(event.sessionId)) {
            // 缓冲区曾溢出：从 JSONL 文件读取完整历史，再拼接 buffer 最近事件
            // 确保用户能滚动查看全部历史消息
            const projectPath = sessionManager.getSessionProjectPath(event.sessionId)
            if (projectPath) {
              const historyResult = await getSessionHistory(projectPath, event.sessionId)
              if (historyResult.ok && historyResult.value.length > 0) {
                // JSONL 提供完整历史基础，buffer 补充最近的实时事件
                const merged = [...historyResult.value, ...bufferedEvents]
                wsBridge.send(ws, {
                  type: 'session_history',
                  sessionId: event.sessionId,
                  events: merged,
                })
              } else if (bufferedEvents.length > 0) {
                // JSONL 读取失败，退回 buffer
                wsBridge.send(ws, {
                  type: 'session_history',
                  sessionId: event.sessionId,
                  events: bufferedEvents,
                })
              }
            } else if (bufferedEvents.length > 0) {
              wsBridge.send(ws, {
                type: 'session_history',
                sessionId: event.sessionId,
                events: bufferedEvents,
              })
            }
          } else if (bufferedEvents.length > 0) {
            // 缓冲区完整，直接发送（快速路径）
            wsBridge.send(ws, {
              type: 'session_history',
              sessionId: event.sessionId,
              events: bufferedEvents,
            })
          }

          // 重发该会话所有 pending approval_requests（移动端重连恢复审批状态）
          for (const req of approvalProxy.getPendingRequestsForSession(event.sessionId)) {
            wsBridge.send(ws, { type: 'approval_request', request: req })
          }
          // 重发该会话所有 pending question_requests（移动端重连恢复问题状态）
          for (const req of sessionManager.getPendingQuestionsForSession(event.sessionId)) {
            wsBridge.send(ws, { type: 'question_request', request: req })
          }
          break
        }

        case 'list_projects': {
          const result = await getProjects()
          if (result.ok) {
            wsBridge.send(ws, { type: 'project_list', projects: result.value })
          } else {
            wsBridge.send(ws, {
              type: 'error',
              message: t('server.listProjectsFailed', { error: result.error.message }),
              code: 'PROJECT_LIST_ERROR',
            })
          }
          // 同时推送最新会话列表（首页刷新时一次请求更新全部数据）
          wsBridge.send(ws, {
            type: 'session_list',
            sessions: sessionManager.getActiveSessions(),
          })
          break
        }

        case 'list_sessions': {
          wsBridge.send(ws, {
            type: 'session_list',
            sessions: sessionManager.getActiveSessions().filter(
              (s) => s.projectPath === event.projectPath,
            ),
          })
          break
        }

        case 'list_project_sessions': {
          const histResult = await getHistoricalSessions(event.projectPath)
          if (histResult.ok) {
            wsBridge.send(ws, {
              type: 'project_sessions',
              projectPath: event.projectPath,
              sessions: histResult.value,
            })
          } else {
            wsBridge.send(ws, {
              type: 'error',
              message: t('server.listSessionsFailed', { error: histResult.error.message }),
              code: 'PROJECT_SESSIONS_ERROR',
            })
          }
          break
        }

        case 'load_session_history': {
          const historyResult = await getSessionHistory(event.projectPath, event.sessionId)
          if (!historyResult.ok) {
            wsBridge.send(ws, {
              type: 'error',
              message: t('server.readHistoryFailed', { error: historyResult.error.message }),
              code: 'SESSION_HISTORY_ERROR',
              sessionId: event.sessionId,
            })
          } else if (historyResult.value.length > 0) {
            wsBridge.send(ws, {
              type: 'session_history',
              sessionId: event.sessionId,
              events: historyResult.value,
            })

            const activeSession = sessionManager.getActiveSessions().find((s) => s.id === event.sessionId)
            const isStreaming = activeSession?.status === 'running' || activeSession?.status === 'waiting_approval'
            if (!isStreaming) {
              const filePath = getSessionFilePath(event.projectPath, event.sessionId)
              try {
                const fileStat = await stat(filePath)
                sessionFileWatcher.watch(event.sessionId, filePath, fileStat.size)
              } catch {
                // 文件不存在时跳过
              }
            }
          }
          break
        }

        case 'suggest_next_prompt': {
          const historyResult = await getSessionHistory(event.projectPath, event.sessionId)
          let context = t('server.noHistory')
          if (historyResult.ok && historyResult.value.length > 0) {
            const recent = historyResult.value.slice(-10)
            context = recent
              .map((e) => {
                if (e.type === 'assistant') {
                  const text = e.message.content
                    .filter((b) => b.type === 'text')
                    .map((b) => (b as { type: 'text'; text: string }).text)
                    .join('')
                  return `Assistant: ${text.substring(0, 300)}`
                }
                if (e.type === 'user') {
                  const content = e.message.content
                  const text = typeof content === 'string'
                    ? content
                    : (content as Array<{ type: string; text?: string }>)
                        .filter((b) => b.type === 'text' && !!b.text)
                        .map((b) => b.text!)
                        .join('')
                  return text ? `User: ${text.substring(0, 300)}` : null
                }
                return null
              })
              .filter(Boolean)
              .join('\n')
          }
          const suggestion = await provider.generateSuggestion(context)
          wsBridge.send(ws, {
            type: 'prompt_suggestion',
            sessionId: event.sessionId,
            suggestion,
          })
          break
        }

        case 'register_push_token': {
          notificationService.addPushToken(event.token, ws)
          break
        }

        case 'unregister_push_token': {
          notificationService.removePushToken(event.token)
          break
        }

        case 'update_notification_sounds': {
          notificationService.setSoundPreferences(event.preferences)
          break
        }

        case 'terminal_exec': {
          const activeSession = sessionManager.getActiveSessions().find((s) => s.id === event.sessionId)
          const cwd = activeSession?.projectPath ?? sessionManager.getSessionProjectPath(event.sessionId)
          if (!cwd) {
            wsBridge.send(ws, { type: 'error', code: 'TERMINAL_EXEC_ERROR', message: 'Session not found or no project path', sessionId: event.sessionId })
            break
          }
          terminalExecutor.exec(event.sessionId, event.command, cwd)
          break
        }

        case 'terminal_kill': {
          terminalExecutor.kill(event.execId)
          break
        }

        case 'register_activity_push_token': {
          notificationService.addActivityPushToken(event.sessionId, event.token)
          break
        }

        case 'unregister_activity_push_token': {
          notificationService.removeActivityPushToken(event.sessionId)
          break
        }

        case 'set_yolo_mode': {
          notificationService.setYoloMode(event.sessionId, event.enabled)
          approvalProxy.setYoloMode(event.sessionId, event.enabled)
          break
        }

        case 'viewing_session': {
          wsBridge.setViewingSession(ws, event.sessionId)
          // 标记会话为已读
          if (unreadSessionIds.delete(event.sessionId)) {
            broadcastUnreadSessions()
          }
          break
        }

        case 'left_session': {
          wsBridge.clearViewingSession(ws)
          break
        }

        case 'always_allow_tool': {
          approvalProxy.addToClaudeSettings(event.projectPath, event.toolName)
          break
        }

        case 'check_auth': {
          const status = await authManager.checkAuth()
          wsBridge.send(ws, { type: 'auth_status', loggedIn: status.loggedIn, email: status.email, authMethod: status.authMethod })
          break
        }

        case 'start_auth_login': {
          await authManager.startLogin()
          break
        }

        case 'submit_auth_code': {
          const submitted = authManager.submitCode(event.code)
          if (!submitted) {
            wsBridge.send(ws, { type: 'auth_login_result', success: false, error: t('server.noActiveLoginProcess') })
          }
          break
        }

        default: {
          wsBridge.send(ws, {
            type: 'error',
            message: t('server.unknownEvent', { type: (event as any).type }),
            code: 'UNKNOWN_EVENT',
          })
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[Server] ${t('server.clientEventError')}:`, message)
      type ErrorCode = Extract<ServerEvent, { type: 'error' }>['code']
      const errorCodeMap: Partial<Record<ClientEvent['type'], ErrorCode>> = {
        create_session: 'SESSION_CREATE_ERROR',
        send_message: 'SEND_MESSAGE_ERROR',
        kill_session: 'KILL_SESSION_ERROR',
        approve: 'APPROVE_ERROR',
        reject: 'REJECT_ERROR',
        answer_question: 'ANSWER_QUESTION_ERROR',
        suggest_next_prompt: 'SUGGEST_PROMPT_ERROR',
      }
      const code = errorCodeMap[event.type] ?? 'INTERNAL_ERROR'
      wsBridge.send(ws, { type: 'error', message, code })
    }
  })

  // 9. SessionManager 事件 → WsBridge 广播 + 未读会话广播
  // 注意：unreadSessionIds.add() 已在步骤 3.1 的 handler 中完成（先于 NotificationService）
  sessionManager.onEvent((event) => {
    wsBridge.broadcast(event)

    // 会话完成（idle/error）→ 广播未读列表（add 已在前置 handler 完成）
    if (event.type === 'status_change' && (event.status === 'idle' || event.status === 'error')) {
      if (unreadSessionIds.has(event.sessionId)) {
        broadcastUnreadSessions()
      }
    }
  })

  // 9.1 TerminalExecutor 事件 → WsBridge 广播
  terminalExecutor.onEvent((event) => {
    wsBridge.broadcast(event)
  })

  // 10. 手机端全部断开时自动允许所有待审批（避免任务因无人审批而卡死）
  wsBridge.onDisconnect(() => {
    if (wsBridge.getConnectionCount() === 0 && approvalProxy.getPendingCount() > 0) {
      approvalProxy.approveAll(t('server.phoneDisconnected'))
    }
  })

  // 11. ApprovalProxy 审批请求 → WsBridge 广播 + 推送通知
  approvalProxy.onApprovalRequest((request) => {
    wsBridge.broadcast({ type: 'approval_request', request })

    // 首次推送：5 秒延迟（给 WebSocket + App 内操作更大窗口）
    setTimeout(() => {
      if (!approvalProxy.isPending(request.id)) return
      if (wsBridge.isViewingSession(request.sessionId)) return
      // WS 连接中 → 客户端 liveActivityController 已本地更新实时活动，跳过 APNs push 避免重复
      if (wsBridge.getConnectionCount() > 0) return
      const pendingCount = approvalProxy.getPendingRequestsForSession(request.sessionId).length
      notificationService.notifyApproval(request, pendingCount)
    }, 5_000)

    // 重试推送：60 秒后仍未处理（覆盖首次推送被 iOS 静默的情况）
    setTimeout(() => {
      if (!approvalProxy.isPending(request.id)) return
      if (wsBridge.isViewingSession(request.sessionId)) return
      // WS 连接中 → 客户端已在本地处理通知
      if (wsBridge.getConnectionCount() > 0) return
      console.log(`[Server] ${t('server.approvalRetry', { id: request.id })}`)
      const pendingCount = approvalProxy.getPendingRequestsForSession(request.sessionId).length
      notificationService.notifyApproval(request, pendingCount)
    }, 60_000)
  })

  // 11.5. Question 提问推送通知（与审批通知同样的延迟策略）
  sessionManager.onEvent((event) => {
    if (event.type !== 'question_request') return
    const { request } = event

    // 首次推送：5 秒延迟（给 WebSocket + App 内操作窗口）
    setTimeout(() => {
      if (!sessionManager.isQuestionPending(request.id)) return
      if (wsBridge.isViewingSession(request.sessionId)) return
      if (wsBridge.getConnectionCount() > 0) return
      notificationService.notifyQuestion(request)
    }, 5_000)

    // 重试推送：60 秒后仍未回答
    setTimeout(() => {
      if (!sessionManager.isQuestionPending(request.id)) return
      if (wsBridge.isViewingSession(request.sessionId)) return
      if (wsBridge.getConnectionCount() > 0) return
      console.log(`[Server] Question ${request.id} not answered in 60s, retrying push`)
      notificationService.notifyQuestion(request)
    }, 60_000)
  })

  // 12. ApprovalProxy 状态信息
  approvalProxy.setStatusInfoProvider(() => ({
    connections: wsBridge.getConnectionCount(),
    activeSessions: sessionManager.getActiveSessions().length,
  }))

  // 13. mDNS 广播（支持运行时动态开关）
  const startMdns = () => {
    if (mdnsService) return
    try {
      mdnsService = new MdnsService({
        wsPort: WS_PORT,
        httpPort: HTTP_PORT,
        pairing: pairingManager.state,
      })
      mdnsService.start()
    } catch (err) {
      console.warn(`[Server] mDNS failed to start (non-fatal): ${(err as Error).message}`)
      mdnsService = null
    }
  }
  const stopMdns = () => {
    if (!mdnsService) return
    mdnsService.stop()
    mdnsService = null
  }
  // 先 open pairing 再 start mDNS，这样初次发布就带 pairing:'open'，
  // 避免启动时 publish('closed') 紧接 updatePairingState('open') 导致 name 冲突
  if (opts.enablePairing !== false) {
    pairingManager.open()
  }
  if (opts.enableAutoConnect !== false) {
    startMdns()
  }

  // 14. 安装 hook
  const hookInstaller = new HookInstaller()
  try {
    const installed = await hookInstaller.isInstalled()
    if (!installed) {
      await hookInstaller.install()
      console.log(`[Server] ${t('server.hookInstalled')}`)
    } else {
      console.log(`[Server] ${t('server.hookExists')}`)
    }
  } catch (err) {
    console.error(`[Server] ${t('server.hookInstallFailed')}`, err)
    console.log(`[Server] ${t('server.hookContinue')}`)
  }

  // 15. 优雅关闭函数（不调用 process.exit，由调用方控制）
  // 每个步骤独立 try/catch，确保即使某步失败也能继续清理其他资源
  const stop = async (): Promise<void> => {
    console.log(`[Server] ${t('server.shuttingDown')}`)
    const errors: unknown[] = []

    const attempt = async (fn: () => unknown, label: string) => {
      try {
        await fn()
      } catch (err) {
        console.error(`[Server] ${t('server.shutdownComponentError', { label })}:`, err)
        errors.push(err)
      }
    }

    await attempt(() => authManager.destroy(), 'AuthManager')
    await attempt(() => stopMdns(), 'mDNS')
    await attempt(() => pairingManager.destroy(), 'PairingManager')
    await attempt(() => wsBridge.close(), 'WebSocket')
    await attempt(() => approvalProxy.close(), 'ApprovalProxy')
    await attempt(() => sessionManager.destroy(), 'SessionManager')
    await attempt(() => terminalExecutor.destroy(), 'TerminalExecutor')
    await attempt(() => notificationService.destroy(), 'NotificationService')
    await attempt(() => sessionFileWatcher.destroy(), 'SessionFileWatcher')

    if (errors.length > 0) {
      console.error(`[Server] ${t('server.shutdownWithErrors', { count: errors.length })}`)
      throw errors[0] // 抛出第一个错误，但所有资源都已尝试清理
    }
    console.log(`[Server] ${t('server.shutdownComplete')}`)
  }

  const instance: ServerInstance = {
    token,
    wsPort: WS_PORT,
    httpPort: HTTP_PORT,
    getActiveSessions: () => sessionManager.getActiveSessions(),
    getConnectionCount: () => wsBridge.getConnectionCount(),
    stop,
    setMacNotification: (enabled) => notificationService.setChannelEnabled('mac', enabled),
    setExpoPush: (enabled) => notificationService.setChannelEnabled('expo', enabled),
    onServerEvent: (cb) => sessionManager.onEvent(cb),
    setAutoConnect: (enabled) => {
      if (enabled) {
        startMdns()
      } else {
        stopMdns()
      }
    },
    openPairing: (duration) => pairingManager.open(duration),
    closePairing: () => pairingManager.close(),
    regenerateToken: async () => {
      const newToken = uuidv4()
      await mkdir(configDir, { recursive: true })
      await writeFile(tokenFile, newToken, 'utf8')
      instance.token = newToken
      wsBridge.updateToken(newToken)
      approvalProxy.updateToken(newToken)
      pairingManager.updateToken(newToken)
      pairingManager.open()
      console.log(`[Server] ${t('server.tokenRegenerated', { token: newToken })}`)
      return newToken
    },
  }

  return instance
}
