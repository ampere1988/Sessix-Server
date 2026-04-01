import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { v4 as uuidv4 } from 'uuid'
import type { ApprovalRequest, ApprovalDecision } from '@sessix/shared'
import type { PairingManager } from '../pairing/PairingManager.js'
import { t } from '../i18n'

/** ApprovalProxy 配置 */
interface ApprovalProxyOptions {
  port: number
  token: string
}

/** 外部注入的连接信息回调（用于 /health 端点） */
interface StatusInfo {
  connections: number
  activeSessions: number
}

/**
 * 审批代理 HTTP 服务
 *
 * 接收 Claude Code hook 发来的工具审批请求，通过长轮询机制
 * hold 住响应，等待手机端用户做出审批决策后再返回。
 */
export class ApprovalProxy {
  private server: http.Server
  private token: string
  private port: number
  private settingsPath = path.join(os.homedir(), '.claude', 'settings.json')

  /** 待处理的审批请求：requestId -> { resolve, timer, request } */
  private pendingApprovals = new Map<string, {
    resolve: (decision: ApprovalDecision) => void
    timer: NodeJS.Timeout
    request: ApprovalRequest
  }>()

  /** 审批请求回调（通知外部推送到手机） */
  private approvalRequestCallbacks: Array<(request: ApprovalRequest) => void> = []

  /** YOLO 模式状态：sessionId -> enabled */
  private yoloSessions = new Map<string, boolean>()

  /** 内存缓存：已被"始终允许"的工具名（避免每次读 settings.json） */
  private alwaysAllowedTools = new Set<string>()

  /** 获取状态信息的回调（由外部注入） */
  private statusInfoProvider: (() => StatusInfo) | null = null

  private pairingManager: PairingManager | null = null

  constructor(options: ApprovalProxyOptions) {
    this.token = options.token
    this.port = options.port

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res)
    })

    this.server.listen(options.port, () => {
      console.log(`[ApprovalProxy] ${t('approval.httpStarted', { port: options.port })}`)
    })
  }

  /**
   * 异步工厂方法：等待端口监听成功后 resolve，端口占用等错误时 reject。
   */
  static async create(options: ApprovalProxyOptions): Promise<ApprovalProxy> {
    return new Promise<ApprovalProxy>((resolve, reject) => {
      const proxy = new ApprovalProxy(options)
      proxy.server.once('listening', () => {
        proxy.server.on('error', (err) => console.error(`[ApprovalProxy] ${t('approval.serverError')}:`, err))
        resolve(proxy)
      })
      proxy.server.once('error', reject)
    })
  }

  // ============================================
  // 公开 API
  // ============================================

  /** 注册审批请求回调（当有新的审批请求时触发） */
  onApprovalRequest(callback: (request: ApprovalRequest) => void): void {
    this.approvalRequestCallbacks.push(callback)
  }

  /** 设置状态信息提供者（用于 /health 端点） */
  setStatusInfoProvider(provider: () => StatusInfo): void {
    this.statusInfoProvider = provider
  }

  /** 设置配对管理器 */
  setPairingManager(manager: PairingManager): void {
    this.pairingManager = manager
  }

  /** 设置会话的 YOLO 模式（服务端拦截，即使手机断连也生效） */
  setYoloMode(sessionId: string, enabled: boolean): void {
    this.yoloSessions.set(sessionId, enabled)
    console.log(`[ApprovalProxy] ${t('approval.yoloMode', { status: enabled ? t('approval.yoloEnabled') : t('approval.yoloDisabled') })}: ${sessionId}`)
  }

  /** 检查会话是否处于 YOLO 模式 */
  isYoloMode(sessionId: string): boolean {
    return this.yoloSessions.get(sessionId) ?? false
  }

  /**
   * 注入审批结果
   *
   * 从 pendingApprovals 中取出对应请求，resolve promise，
   * 让长轮询的 HTTP 响应返回审批结果给 Claude Code hook。
   */
  resolveApproval(requestId: string, decision: ApprovalDecision): boolean {
    const pending = this.pendingApprovals.get(requestId)
    if (!pending) {
      console.warn(`[ApprovalProxy] ${t('approval.requestNotFound', { id: requestId })}`)
      return false
    }

    // 清除超时定时器
    clearTimeout(pending.timer)
    // resolve promise，长轮询响应将返回
    pending.resolve(decision)
    // 从 map 中移除
    this.pendingApprovals.delete(requestId)

    console.log(`[ApprovalProxy] ${t('approval.requestProcessed', { id: requestId })}: ${decision.decision}`)
    return true
  }

  /** 获取当前待处理的审批数量 */
  getPendingCount(): number {
    return this.pendingApprovals.size
  }

  /** 检查指定审批请求是否仍在等待用户决策 */
  isPending(requestId: string): boolean {
    return this.pendingApprovals.has(requestId)
  }

  /** 清理指定会话的所有待处理审批（会话被 kill 时调用，默认放行避免阻塞 hook 脚本） */
  clearPendingForSession(sessionId: string): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.request.sessionId === sessionId) {
        clearTimeout(pending.timer)
        pending.resolve({ decision: 'allow' })
        this.pendingApprovals.delete(requestId)
        console.log(`[ApprovalProxy] Session ${sessionId} killed, auto-allowed pending approval ${requestId}`)
      }
    }
  }

  /** 检查工具是否已被"始终允许"（内存缓存 + settings.json 双重检查） */
  private isToolAlwaysAllowed(toolName: string, projectPath?: string): boolean {
    // 1. 内存缓存（最快路径）
    if (this.alwaysAllowedTools.has(toolName)) return true

    // 2. settings.json 检查
    return this.isToolInClaudeSettings(toolName, projectPath)
  }

  /** 检查工具是否已在 settings.json permissions.allow 中（检查项目级和全局） */
  private isToolInClaudeSettings(toolName: string, projectPath?: string): boolean {
    const checkPath = (filepath: string): boolean => {
      try {
        const raw = fs.readFileSync(filepath, 'utf-8')
        const settings = JSON.parse(raw) as Record<string, unknown>
        const allow = (settings?.permissions as Record<string, unknown>)?.allow as string[] | undefined ?? []
        return allow.some(entry => {
          // 精确匹配: "Edit" === "Edit"
          if (entry === toolName) return true
          // 通配符匹配: "Edit(*)" 表示允许该工具的所有调用
          if (entry === `${toolName}(*)`) return true
          // MCP 服务器级匹配: 条目 "mcp__pencil" 覆盖 "mcp__pencil__batch_design"
          if (toolName.startsWith(`${entry}__`)) return true
          return false
        })
      } catch {
        return false
      }
    }

    // 优先检查项目级（若提供）
    if (projectPath) {
      const projectSettingsPath = path.join(projectPath, '.claude', 'settings.json')
      if (checkPath(projectSettingsPath)) return true
    }
    // 再检查全局
    return checkPath(this.settingsPath)
  }

  /** 将工具写入 settings.json permissions.allow（项目级或全局） */
  addToClaudeSettings(projectPath: string | undefined, toolName: string): void {
    const targetPath = projectPath
      ? path.join(projectPath, '.claude', 'settings.json')
      : this.settingsPath

    try {
      // 确保目录存在
      if (projectPath) {
        const dir = path.dirname(targetPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
      }

      let settings: Record<string, unknown> = {}
      try {
        settings = JSON.parse(fs.readFileSync(targetPath, 'utf-8'))
      } catch {
        // 文件不存在时从空对象开始
      }
      if (!settings.permissions) {
        settings.permissions = {}
      }
      const perms = settings.permissions as Record<string, unknown>
      if (!Array.isArray(perms.allow)) {
        perms.allow = []
      }
      const allow = perms.allow as string[]
      const entry = `${toolName}(*)`
      if (!allow.includes(entry)) {
        allow.push(entry)
        fs.writeFileSync(targetPath, JSON.stringify(settings, null, 2), 'utf-8')
        const label = projectPath ? `${projectPath}/.claude/settings.json` : '~/.claude/settings.json'
        console.log(`[ApprovalProxy] ${t('approval.alwaysAllowWritten', { entry, label })}`)
      }
      // 同步更新内存缓存
      this.alwaysAllowedTools.add(toolName)
    } catch (err) {
      console.error(`[ApprovalProxy] ${t('approval.settingsWriteFailed')}:`, err)
    }
  }

  /** 获取指定会话的所有 pending approval requests（用于 subscribe 重发） */
  getPendingRequestsForSession(sessionId: string): ApprovalRequest[] {
    const result: ApprovalRequest[] = []
    for (const { request } of this.pendingApprovals.values()) {
      if (request.sessionId === sessionId) {
        result.push(request)
      }
    }
    return result
  }

  /** 获取所有 pending approval requests（用于客户端重连时恢复状态） */
  getAllPendingRequests(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values()).map(({ request }) => request)
  }

  /**
   * 批量允许所有待处理的审批请求（手机端断线时调用）
   */
  approveAll(reason?: string): void {
    const entries = Array.from(this.pendingApprovals.entries())
    for (const [requestId, pending] of entries) {
      clearTimeout(pending.timer)
      pending.resolve({ decision: 'allow' })
      this.pendingApprovals.delete(requestId)
      console.log(`[ApprovalProxy] ${t('approval.autoAllowed', { id: requestId, reason: reason ? `（${reason}）` : '' })}`)
    }
  }

  /** 优雅关闭 HTTP 服务 */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 清理所有待处理的审批（默认放行）
      // 先收集再清理，避免迭代中删除
      const pendingEntries = Array.from(this.pendingApprovals.entries())
      for (const [, pending] of pendingEntries) {
        clearTimeout(pending.timer)
        pending.resolve({ decision: 'deny', reason: t('approval.serverClosed') })
      }
      this.pendingApprovals.clear()

      this.server.close((err) => {
        if (err) {
          reject(err)
        } else {
          console.log(`[ApprovalProxy] ${t('approval.httpClosed')}`)
          resolve()
        }
      })
    })
  }

  // ============================================
  // 内部方法
  // ============================================

  /** 路由请求 */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS 支持（局域网跨域）
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    // 预检请求直接返回
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const pathname = url.pathname

    if (req.method === 'POST' && pathname === '/hook/approval') {
      this.handleApprovalHook(req, res)
    } else if (req.method === 'POST' && pathname === '/pair') {
      this.handlePair(req, res)
    } else if (req.method === 'GET' && pathname === '/health') {
      this.handleHealth(req, res)
    } else if (req.method === 'GET' && pathname === '/token') {
      this.handleToken(req, res)
    } else {
      this.sendJson(res, 404, { error: 'Not Found' })
    }
  }

  /**
   * 核心端点：处理 Claude Code hook 的审批请求
   *
   * 长轮询实现：
   * 1. 解析请求 body
   * 2. 创建 ApprovalRequest 对象
   * 3. 通知外部（推到手机）
   * 4. 创建 Promise 并 hold 住 response
   * 5. 等待 resolveApproval() 被调用或超时
   */
  private async handleApprovalHook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      // 手动解析 JSON body
      const body = await this.parseJsonBody(req)

      // 构建 ApprovalRequest 对象
      // hook 脚本发送格式: { sessionId, projectPath, payload: { tool_name, tool_input, ... } }
      const payload = (body.payload as Record<string, unknown>) ?? body
      const requestId = uuidv4()
      const projectPath = String(body.projectPath ?? 'unknown')
      const toolName = String(payload.tool_name ?? body.tool_name ?? 'unknown')
      const toolInput = (payload.tool_input as Record<string, unknown>) ?? (body.tool_input as Record<string, unknown>) ?? {}
      const approvalRequest: ApprovalRequest = {
        id: requestId,
        sessionId: String(body.sessionId ?? 'unknown'),
        projectPath,
        toolName,
        toolInput,
        description: String(payload.description ?? body.description ?? `${toolName} tool call request`),
        createdAt: Date.now(),
      }

      console.log(`[ApprovalProxy] ${t('approval.received')}: ${requestId} (${approvalRequest.toolName})`)

      // 检查工具是否已被"始终允许"（内存缓存 + settings.json），直接放行不发通知
      if (this.isToolAlwaysAllowed(approvalRequest.toolName, projectPath !== 'unknown' ? projectPath : undefined)) {
        console.log(`[ApprovalProxy] ${t('approval.alwaysAllowPassThrough', { tool: approvalRequest.toolName })}`)
        this.sendJson(res, 200, { decision: 'allow' })
        return
      }

      // YOLO 模式：服务端直接放行（即使手机断连也生效）
      if (this.yoloSessions.get(approvalRequest.sessionId)) {
        console.log(`[ApprovalProxy] ${t('approval.yoloAutoAllow')}: ${approvalRequest.toolName}`)
        this.sendJson(res, 200, { decision: 'allow' })
        return
      }

      // 通知外部（会被推送到手机端）
      this.notifyApprovalRequest(approvalRequest)

      // 长轮询：创建 Promise，等待审批结果或超时
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        // 5 分钟超时，默认允许（手机端可能已断线，不应阻塞任务）
        const timer = setTimeout(() => {
          console.log(`[ApprovalProxy] ${t('approval.timeout', { id: requestId })}`)
          this.pendingApprovals.delete(requestId)
          resolve({ decision: 'allow' })
        }, 325_000)

        // 存入待处理 map（包含完整的 request 对象用于 subscribe 重发）
        this.pendingApprovals.set(requestId, { resolve, timer, request: approvalRequest })
      })

      // 返回审批结果给 Claude Code hook
      this.sendJson(res, 200, decision)
    } catch (err) {
      console.error(`[ApprovalProxy] ${t('approval.processingFailed')}:`, err)
      // 出错时默认拒绝（安全优先）
      this.sendJson(res, 200, { decision: 'deny', reason: 'Server failed to process request' })
    }
  }

  /** 健康检查端点 */
  private handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
    const info = this.statusInfoProvider?.() ?? { connections: 0, activeSessions: 0 }
    this.sendJson(res, 200, {
      status: 'ok',
      connections: info.connections,
      activeSessions: info.activeSessions,
    })
  }

  /** 配对端点：配对窗口开放时返回 token */
  private handlePair(_req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.pairingManager) {
      this.sendJson(res, 503, { error: 'pairing_unavailable' })
      return
    }
    const result = this.pairingManager.tryPair()
    if (result) {
      console.log('[ApprovalProxy] Device paired successfully')
      this.sendJson(res, 200, result)
    } else {
      this.sendJson(res, 403, {
        error: 'pairing_closed',
        message: 'Pairing window is closed. Restart server or press p to reopen.',
      })
    }
  }

  /** 更新 token（token 刷新时调用） */
  updateToken(newToken: string): void {
    this.token = newToken
  }

  /** 返回连接 token（仅本机访问） */
  private handleToken(req: http.IncomingMessage, res: http.ServerResponse): void {
    // 检查是否为本机访问
    const remoteAddress = req.socket.remoteAddress
    const isLocal = remoteAddress === '127.0.0.1'
      || remoteAddress === '::1'
      || remoteAddress === '::ffff:127.0.0.1'

    if (!isLocal) {
      this.sendJson(res, 403, { error: t('approval.forbidden') })
      return
    }

    this.sendJson(res, 200, { token: this.token })
  }

  /** 通知所有注册的审批请求回调 */
  private notifyApprovalRequest(request: ApprovalRequest): void {
    for (const callback of this.approvalRequestCallbacks) {
      try {
        callback(request)
      } catch (err) {
        console.error('[ApprovalProxy] Approval request callback error:', err)
      }
    }
  }

  /** 手动解析请求的 JSON body（限制最大 1MB 防止滥用） */
  private parseJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const MAX_BODY_SIZE = 1024 * 1024 // 1MB
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let totalSize = 0

      let destroyed = false

      req.on('data', (chunk: Buffer) => {
        if (destroyed) return
        totalSize += chunk.length
        if (totalSize > MAX_BODY_SIZE) {
          destroyed = true
          req.destroy()
          return reject(new Error(t('approval.bodyTooLarge')))
        }
        chunks.push(chunk)
      })

      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8')
          const parsed = JSON.parse(raw) as Record<string, unknown>
          resolve(parsed)
        } catch {
          reject(new Error(t('approval.invalidJson')))
        }
      })

      req.on('error', (err) => {
        reject(err)
      })
    })
  }

  /** 发送 JSON 响应的辅助方法 */
  private sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
    const body = JSON.stringify(data)
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  }
}
