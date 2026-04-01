import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { ServerEvent, ClientEvent } from '@sessix/shared'
import { t } from '../i18n'

/** WsBridge 配置 */
interface WsBridgeOptions {
  port: number
  token: string
}

/**
 * WebSocket 桥接服务
 *
 * 负责与手机端建立 WebSocket 连接，完成事件的收发。
 * - 连接鉴权（URL 参数 token）
 * - 心跳保活 & 死连接检测
 * - 事件广播 / 单播
 */
export class WsBridge {
  private wss: WebSocketServer
  private token: string
  private heartbeatTimer: NodeJS.Timeout | null = null
  private clientEventCallbacks: Array<(event: ClientEvent, ws: WebSocket) => void> = []
  private connectionCallbacks: Array<(ws: WebSocket) => void> = []
  private disconnectCallbacks: Array<() => void> = []

  /** 每个连接的最后一次 pong 时间 */
  private lastPongMap = new Map<WebSocket, number>()

  /** 每个连接当前正在查看的会话 ID */
  private viewingSessions = new Map<WebSocket, string>()

  /** 每个连接的消息处理队列（串行化 async handler，防止 create_session/subscribe 竞态） */
  private messageQueues = new Map<WebSocket, Promise<void>>()

  constructor(options: WsBridgeOptions) {
    this.token = options.token

    this.wss = new WebSocketServer({
      port: options.port,
      verifyClient: (info, callback) => {
        const authorized = this.verifyToken(info.req)
        if (!authorized) {
          callback(false, 401, 'Unauthorized')
        } else {
          callback(true)
        }
      },
    })

    this.wss.on('connection', (ws) => this.handleConnection(ws))

    // 启动心跳定时器
    this.startHeartbeat()

    console.log(`[WsBridge] ${t('ws.started', { port: options.port })}`)
  }

  /**
   * 异步工厂方法：等待端口监听成功后 resolve，端口占用等错误时 reject。
   * 使用此方法代替 new WsBridge()，确保 EADDRINUSE 等错误能被调用方的 try-catch 捕获。
   */
  static async create(options: WsBridgeOptions): Promise<WsBridge> {
    return new Promise<WsBridge>((resolve, reject) => {
      const bridge = new WsBridge(options)
      bridge.wss.once('listening', () => {
        // 启动成功后注册持久错误处理器，防止运行时错误变成 Uncaught Exception
        bridge.wss.on('error', (err) => console.error(`[WsBridge] ${t('ws.serverError')}:`, err))
        resolve(bridge)
      })
      bridge.wss.once('error', reject)
    })
  }

  // ============================================
  // 公开 API
  // ============================================

  /** 注册客户端事件回调 */
  onClientEvent(callback: (event: ClientEvent, ws: WebSocket) => void): void {
    this.clientEventCallbacks.push(callback)
  }

  /** 注册新连接回调（用于自动推送初始数据） */
  onConnection(callback: (ws: WebSocket) => void): void {
    this.connectionCallbacks.push(callback)
  }

  /** 注册断开连接回调（任意客户端断开时触发，可通过 getConnectionCount() 判断是否全部断开） */
  onDisconnect(callback: () => void): void {
    this.disconnectCallbacks.push(callback)
  }

  /** 广播事件到所有已连接的客户端 */
  broadcast(event: ServerEvent): void {
    const data = JSON.stringify(event)
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    }
  }

  /** 发送事件到指定客户端 */
  send(ws: WebSocket, event: ServerEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event))
    }
  }

  /** 设置指定连接当前正在查看的会话 */
  setViewingSession(ws: WebSocket, sessionId: string): void {
    this.viewingSessions.set(ws, sessionId)
  }

  /** 清除指定连接的查看状态 */
  clearViewingSession(ws: WebSocket): void {
    this.viewingSessions.delete(ws)
  }

  /** 检查是否有任意连接正在查看指定会话 */
  isViewingSession(sessionId: string): boolean {
    for (const sid of this.viewingSessions.values()) {
      if (sid === sessionId) return true
    }
    return false
  }

  /** 获取当前活跃连接数 */
  getConnectionCount(): number {
    return this.wss.clients.size
  }

  /** 更新 token 并断开所有现有连接（token 刷新后需重新配对） */
  updateToken(newToken: string): void {
    this.token = newToken
    for (const ws of this.wss.clients) {
      ws.close(4001, 'Token regenerated')
    }
  }

  /** 优雅关闭 WebSocket 服务 */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 停止心跳
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
      }

      // 关闭所有连接
      for (const ws of this.wss.clients) {
        ws.terminate()
      }

      this.wss.close((err) => {
        if (err) {
          reject(err)
        } else {
          console.log('[WsBridge] WebSocket server closed')
          resolve()
        }
      })
    })
  }

  // ============================================
  // 内部方法
  // ============================================

  /** 验证连接 token（token 为空字符串时跳过验证） */
  private verifyToken(req: IncomingMessage): boolean {
    // 空 token = 开发模式，跳过验证
    if (this.token === '') return true
    try {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`)
      const clientToken = url.searchParams.get('token')
      return clientToken === this.token
    } catch {
      return false
    }
  }

  /** 处理新的 WebSocket 连接 */
  private handleConnection(ws: WebSocket): void {
    // 记录初始 pong 时间（连接建立即视为活跃）
    this.lastPongMap.set(ws, Date.now())

    console.log(`[WsBridge] New client connected, connections: ${this.getConnectionCount()}`)

    // 触发连接回调（自动推送初始数据）
    for (const callback of this.connectionCallbacks) {
      try {
        callback(ws)
      } catch (err) {
        console.error('[WsBridge] Connection callback error:', err)
      }
    }

    // 监听 pong 回应
    ws.on('pong', () => {
      this.lastPongMap.set(ws, Date.now())
    })

    // 监听消息
    ws.on('message', (raw) => {
      try {
        const event = JSON.parse(raw.toString()) as ClientEvent
        this.dispatchClientEvent(event, ws)
      } catch (err) {
        console.error('[WsBridge] Message parse error:', err)
        this.send(ws, {
          type: 'error',
          message: 'Invalid message format',
          code: 'INVALID_MESSAGE',
        })
      }
    })

    // 监听关闭
    // 注意：close 事件时 ws 可能尚未从 wss.clients 移除，延迟到下一 tick 获取准确的连接数
    ws.on('close', () => {
      this.lastPongMap.delete(ws)
      this.viewingSessions.delete(ws)
      this.messageQueues.delete(ws)
      setTimeout(() => {
        console.log(`[WsBridge] Client disconnected, connections: ${this.getConnectionCount()}`)
        for (const cb of this.disconnectCallbacks) {
          try { cb() } catch (err) { console.error('[WsBridge] Disconnect callback error:', err) }
        }
      }, 0)
    })

    // 监听错误
    ws.on('error', (err) => {
      console.error('[WsBridge] Connection error:', err.message)
    })
  }

  /**
   * 分发客户端事件到所有注册的回调
   *
   * 使用 per-connection 队列串行化处理，确保 async 回调（如 create_session）
   * 完成后才处理下一条消息（如 subscribe），避免竞态条件。
   */
  private dispatchClientEvent(event: ClientEvent, ws: WebSocket): void {
    const prev = this.messageQueues.get(ws) ?? Promise.resolve()
    const next = prev.then(async () => {
      for (const callback of this.clientEventCallbacks) {
        try {
          await callback(event, ws)
        } catch (err) {
          console.error('[WsBridge] Event callback error:', err)
        }
      }
    })
    this.messageQueues.set(ws, next)
  }

  /** 启动心跳机制 */
  private startHeartbeat(): void {
    // 每 15 秒发送一次心跳（更快检测半死连接，减少审批等待时间）
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now()

      // 广播心跳事件给所有客户端
      this.broadcast({ type: 'heartbeat', timestamp: now })

      // 检查每个连接是否存活
      for (const ws of this.wss.clients) {
        const lastPong = this.lastPongMap.get(ws) ?? 0

        // 超过 45 秒未收到 pong，视为死连接（15s 间隔 × 3 次未响应）
        if (now - lastPong > 45_000) {
          console.log('[WsBridge] Dead connection detected, terminating')
          ws.terminate()
          continue
        }

        // 发送 ping 帧
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping()
        }
      }
    }, 15_000)
  }
}
