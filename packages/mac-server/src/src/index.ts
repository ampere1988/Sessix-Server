import { networkInterfaces } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { start } from './server.js'
import qrcode from 'qrcode-terminal'
import { t } from './i18n'

// ============================================
// CLI 入口 — 直接运行时的包装层
// ============================================

/** 从 package.json 读取版本号（兼容 dev 和 dist） */
function getPackageVersion(): string {
  try {
    // dist/index.js → ../package.json; src/index.ts (dev) → ../package.json
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const PKG_VERSION = getPackageVersion()

/** 从 npm registry 查询最新版本，超时 5 秒 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    const res = await fetch('https://registry.npmjs.org/sessix-server/latest', {
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = await res.json() as { version: string }
    return data.version ?? null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  console.log('='.repeat(50))
  console.log(`${t('startup.banner')}  v${PKG_VERSION}`)
  console.log('='.repeat(50))
  console.log()

  const enableAutoConnect = process.env.SESSIX_AUTO_CONNECT !== 'false'
  const server = await start({ enableAutoConnect })

  // 打印启动信息
  const localIp = getLocalIp()
  console.log('-'.repeat(50))
  console.log(t('startup.wsPort', { port: server.wsPort }))
  console.log(t('startup.httpPort', { port: server.httpPort }))
  if (server.token === '') {
    console.log(t('startup.tokenDisabled'))
    console.log()
    console.log(t('startup.wsAddress', { ip: localIp, port: server.wsPort }))
  } else {
    console.log(t('startup.token', { token: server.token }))
    console.log()
    console.log(t('startup.wsAddressWithToken', { ip: localIp, port: server.wsPort, token: server.token }))
  }
  console.log(t('startup.healthCheck', { port: server.httpPort }))
  console.log('-'.repeat(50))
  if (server.token === '') {
    console.log()
    console.log(t('startup.devMode'))
  }
  console.log()
  // 打印 QR 码（small 模式，适合终端显示）
  const qrUrl = buildQrUrl(localIp, server.wsPort, server.token)
  console.log(t('startup.scanToPair'))
  qrcode.generate(qrUrl, { small: true }, (qr) => {
    // 每行缩进 2 个空格，保持与其他输出对齐
    qr.split('\n').forEach((line) => console.log(`  ${line}`))
  })
  console.log()
  if (enableAutoConnect) {
    console.log(t('startup.autoDiscoveryOn'))
    console.log(t('startup.autoDiscoveryHint'))
  } else {
    console.log(t('startup.autoDiscoveryOff'))
  }
  console.log()
  console.log(t('startup.waitingConnection'))
  console.log()

  // 配对状态提示 + 快捷键
  console.log(t('startup.pairingOpen'))
  console.log(t('startup.pressT'))
  console.log()

  // 异步检查新版本（不阻塞启动）
  fetchLatestVersion().then((latest) => {
    if (!latest || latest === PKG_VERSION) return
    console.log()
    console.log(`  📦 ${t('startup.updateAvailable', { current: PKG_VERSION, latest })}`)
    console.log(`     npx sessix-server@latest`)
    console.log()
  })

  // 注册信号处理（仅 CLI 模式，Electron 不走这里）
  const shutdown = async (signal: string) => {
    console.log(`\n[Main] ${t('startup.receivedSignal', { signal })}`)
    try {
      await server.stop()
      console.log(`[Main] ${t('startup.goodbye')}`)
      process.exit(0)
    } catch (err) {
      console.error(`[Main] ${t('startup.shutdownError')}`, err)
      process.exit(1)
    }
  }

  // 监听按键：p 切换配对，Ctrl+C 退出
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (key: string) => {
      if (key === 'p' || key === 'P') {
        server.openPairing()
        console.log(`\n${t('startup.pairingReopened')}`)
      }
      if (key === 't' || key === 'T') {
        server.regenerateToken().then((newToken) => {
          console.log()
          console.log(`  ${t('startup.tokenRegenerated')}`)
          console.log(t('startup.token', { token: newToken }))
          console.log()
          const newQrUrl = buildQrUrl(getLocalIp(), server.wsPort, newToken)
          console.log(t('startup.scanToPair'))
          qrcode.generate(newQrUrl, { small: true }, (qr) => {
            qr.split('\n').forEach((line) => console.log(`  ${line}`))
          })
          console.log()
        }).catch((err) => {
          console.error(`\n  ${t('startup.tokenRegenerateFailed')}`, err)
        })
      }
      // Ctrl+C
      if (key === '\u0003') {
        shutdown('SIGINT')
      }
    })
  } else {
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    // Windows 关闭控制台窗口时触发 SIGHUP
    process.on('SIGHUP', () => shutdown('SIGHUP'))
  }
}

function getLocalIp(): string {
  const interfaces = networkInterfaces()
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address
      }
    }
  }
  return '<your-ip>'
}

function buildQrUrl(ip: string, wsPort: number, token: string): string {
  const base = `sessix://${ip}:${wsPort}`
  return token ? `${base}?token=${token}` : base
}

// 启动
main().catch((err) => {
  console.error(`[Main] ${t('startup.startFailed')}`, err)
  process.exit(1)
})
