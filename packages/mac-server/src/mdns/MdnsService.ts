import { spawn, type ChildProcess } from 'node:child_process'
import { platform } from 'node:os'
import { t } from '../i18n'

/** mDNS 服务配置 */
interface MdnsServiceOptions {
  /** WebSocket 端口 */
  wsPort: number
  /** HTTP 审批端口 */
  httpPort: number
  /** 服务版本 */
  version?: string
  /** 当前配对状态 */
  pairing?: 'open' | 'closed'
}

/**
 * 构建 dns-sd TXT record 参数列表
 */
function buildTxtArgs(txt: Record<string, string>): string[] {
  return Object.entries(txt).map(([k, v]) => `${k}=${v}`)
}

/**
 * mDNS 局域网广播服务
 *
 * macOS: 使用系统原生 dns-sd 命令通过 mDNSResponder 注册服务，
 *        避免与 mDNSResponder 抢占端口 5353，确保 resolve 正常工作。
 * 其他平台: 回退到 bonjour-service（用户态 mDNS）。
 *
 * 广播协议：_sessix._tcp
 * TXT 记录包含版本号和 HTTP 端口信息。
 */
export class MdnsService {
  private proc: ChildProcess | null = null
  private bonjourInstance: any = null
  private bonjourService: any = null
  private wsPort: number
  private httpPort: number
  private version: string
  private pairing: 'open' | 'closed'
  private useDnsSd: boolean

  constructor(options: MdnsServiceOptions) {
    this.wsPort = options.wsPort
    this.httpPort = options.httpPort
    this.version = options.version ?? '0.1.0'
    this.pairing = options.pairing ?? 'closed'
    this.useDnsSd = platform() === 'darwin'
  }

  private getTxt(): Record<string, string> {
    return {
      version: this.version,
      httpPort: String(this.httpPort),
      wsPort: String(this.wsPort),
      pairing: this.pairing,
    }
  }

  /**
   * 启动 mDNS 广播
   */
  start(): void {
    if (this.useDnsSd) {
      this.startDnsSd()
    } else {
      this.startBonjour()
    }
  }

  private startDnsSd(): void {
    if (this.proc) {
      console.warn(`[MdnsService] ${t('mdns.alreadyRunning')}`)
      return
    }

    const args = [
      '-R', 'Sessix',
      '_sessix._tcp', 'local',
      String(this.wsPort),
      ...buildTxtArgs(this.getTxt()),
    ]

    this.proc = spawn('dns-sd', args, { stdio: 'ignore' })

    this.proc.on('error', (err) => {
      console.warn(`[MdnsService] dns-sd failed, falling back to bonjour-service: ${err.message}`)
      this.proc = null
      this.useDnsSd = false
      this.startBonjour()
    })

    this.proc.on('exit', (code) => {
      // dns-sd 被 stop() 主动 kill 时 code 为 null，不需要警告
      if (code !== null && code !== 0) {
        console.warn(`[MdnsService] dns-sd exited with code ${code}`)
      }
      this.proc = null
    })

    console.log(`[MdnsService] ${t('mdns.started', { port: this.wsPort })} (dns-sd)`)
  }

  private async startBonjour(): Promise<void> {
    if (this.bonjourInstance) {
      console.warn(`[MdnsService] ${t('mdns.alreadyRunning')}`)
      return
    }

    try {
      const { default: Bonjour } = await import('bonjour-service')
      const { networkInterfaces } = await import('node:os')

      const lanAddrs = getLanAddresses(networkInterfaces)
      const opts = lanAddrs.length > 0 ? { interface: lanAddrs[0] } : {}

      const onError = (err: Error & { code?: string }) => {
        if (err.code === 'EADDRINUSE') return
        console.warn(`[MdnsService] mDNS error (non-fatal): ${err.message}`)
      }

      this.bonjourInstance = new Bonjour(opts as any, onError)
      ;(this.bonjourInstance as any).server?.mdns?.on('error', onError)

      if (lanAddrs.length > 0) {
        console.log(`[MdnsService] ${t('mdns.boundInterface', { ip: lanAddrs[0] })}`)
      }

      this.bonjourService = this.bonjourInstance.publish({
        name: 'Sessix',
        type: 'sessix',
        port: this.wsPort,
        txt: this.getTxt(),
      })

      console.log(`[MdnsService] ${t('mdns.started', { port: this.wsPort })} (bonjour-service)`)
    } catch (err) {
      console.warn(`[MdnsService] bonjour-service failed: ${(err as Error).message}`)
    }
  }

  /**
   * 停止 mDNS 广播
   */
  stop(): void {
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }

    if (this.bonjourService) {
      this.bonjourService.stop?.(() => {
        console.log(`[MdnsService] ${t('mdns.stopped')}`)
      })
      this.bonjourService = null
    }

    if (this.bonjourInstance) {
      this.bonjourInstance.destroy()
      this.bonjourInstance = null
    }

    console.log(`[MdnsService] ${t('mdns.closed')}`)
  }

  /**
   * 更新配对状态（重新发布 mDNS 服务）
   */
  updatePairingState(state: 'open' | 'closed'): void {
    this.pairing = state

    if (this.useDnsSd) {
      // dns-sd 不支持动态更新 TXT，需要重启进程
      if (this.proc) {
        this.proc.kill()
        this.proc = null
      }
      this.startDnsSd()
      return
    }

    if (!this.bonjourInstance) return
    const republish = () => {
      if (!this.bonjourInstance) return
      this.bonjourService = this.bonjourInstance.publish({
        name: 'Sessix',
        type: 'sessix',
        port: this.wsPort,
        txt: this.getTxt(),
      })
    }
    if (this.bonjourService) {
      const old = this.bonjourService
      this.bonjourService = null
      old.stop?.(() => republish())
    } else {
      republish()
    }
  }
}

/** 获取所有非回环 IPv4 地址 */
function getLanAddresses(networkInterfacesFn: typeof import('node:os').networkInterfaces): string[] {
  const results: string[] = []
  for (const [name, addrs] of Object.entries(networkInterfacesFn())) {
    if (name.startsWith('utun') || name === 'lo') continue
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        results.push(addr.address)
      }
    }
  }
  return results
}
