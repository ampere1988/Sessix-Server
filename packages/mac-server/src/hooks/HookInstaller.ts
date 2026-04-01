import { readFile, writeFile, mkdir, chmod, access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Sessix hook 脚本存放目录 */
const SESSIX_HOOKS_DIR = join(homedir(), '.sessix', 'hooks')

/** Hook 脚本文件路径 */
const HOOK_SCRIPT_PATH = join(SESSIX_HOOKS_DIR, 'approval-hook.js')

/** PermissionRequest 兜底脚本路径 */
const PERMISSION_ACCEPT_PATH = join(SESSIX_HOOKS_DIR, 'permission-accept.js')

/** Claude Code settings.json 路径 */
const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')

/** hook 脚本命令（使用 ~ 前缀，Claude Code 会展开） */
const HOOK_COMMAND = 'node ~/.sessix/hooks/approval-hook.js'

/** PermissionRequest 兜底脚本命令 */
const PERMISSION_ACCEPT_COMMAND = 'node ~/.sessix/hooks/permission-accept.js'

/** 旧版 bash hook 命令（用于清理升级） */
const LEGACY_HOOK_COMMANDS = [
  '~/.sessix/hooks/approval-hook.sh',
  '~/.sessix/hooks/permission-accept.sh',
]

/**
 * approval-hook.js 脚本模板
 *
 * 仅在 Sessix 管理的会话中激活（检查 SESSIX_SESSION_ID 环境变量）。
 * 将 hook payload 发送到 Sessix HTTP 审批端点，等待用户决定。
 * 通过 exit code 向 Claude Code 报告批准结果：
 * - exit 0: 批准（用户同意或服务器超时自动批准）
 * - exit 1: 拒绝（用户明确拒绝）
 */
const HOOK_SCRIPT_TEMPLATE = `#!/usr/bin/env node
// Sessix Approval Hook
// 仅在 Sessix 管理的会话中激活

const sessionId = process.env.SESSIX_SESSION_ID
if (!sessionId) process.exit(0)

let payload = ''
process.stdin.on('data', (chunk) => { payload += chunk })
process.stdin.on('end', async () => {
  try {
    const res = await fetch('http://localhost:3746/hook/approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        projectPath: process.cwd(),
        payload: JSON.parse(payload),
      }),
      signal: AbortSignal.timeout(320000),
    })
    const data = await res.json()
    process.exit(data.decision === 'deny' ? 1 : 0)
  } catch {
    // Sessix 服务器不可用，默认放行
    process.exit(0)
  }
})
`

/**
 * permission-accept.js 脚本模板
 *
 * 仅在 Sessix 管理的会话中激活。
 * 当 Claude Code 弹出内置权限对话框（PermissionRequest）时，
 * 自动接受权限请求，避免 Sessix 会话因缺少终端 UI 而永久阻塞。
 * 不做任何 HTTP 调用，即时返回。
 */
const PERMISSION_ACCEPT_TEMPLATE = `#!/usr/bin/env node
// Sessix PermissionRequest 兜底
// 自动接受权限请求，避免 Sessix 会话阻塞

if (!process.env.SESSIX_SESSION_ID) process.exit(0)

process.stdout.write('{"decision":"allow"}\\n')
process.exit(0)
`

/**
 * Hook 安装器
 *
 * 负责将 Sessix 的审批 hook 脚本安装到 Claude Code 中：
 * 1. 创建 ~/.sessix/hooks/ 目录并写入 approval-hook.js 和 permission-accept.js
 * 2. 在 ~/.claude/settings.json 中注册 PreToolUse 和 PermissionRequest hook
 */
export class HookInstaller {
  /**
   * 安装 hook
   *
   * 1. 创建 ~/.sessix/hooks/ 目录
   * 2. 写入 approval-hook.js 脚本
   * 3. 赋予执行权限
   * 4. 更新 Claude Code settings.json 添加 hook 配置
   */
  async install(): Promise<void> {
    // 1. 创建 hooks 目录
    await mkdir(SESSIX_HOOKS_DIR, { recursive: true })

    // 2. 写入 hook 脚本
    await writeFile(HOOK_SCRIPT_PATH, HOOK_SCRIPT_TEMPLATE, 'utf-8')
    await writeFile(PERMISSION_ACCEPT_PATH, PERMISSION_ACCEPT_TEMPLATE, 'utf-8')

    // 3. 添加执行权限
    await chmod(HOOK_SCRIPT_PATH, 0o755)
    await chmod(PERMISSION_ACCEPT_PATH, 0o755)

    // 4. 更新 Claude Code settings.json
    await this.addHookToSettings()

    console.log('[HookInstaller] Hook installation complete')
  }

  /**
   * 卸载 hook
   *
   * 从 Claude Code settings.json 中移除 Sessix hook 配置。
   * 注意：不删除 hook 脚本文件（保持幂等性，避免误删）。
   */
  async uninstall(): Promise<void> {
    await this.removeHookFromSettings()
    console.log('[HookInstaller] Hook uninstalled')
  }

  /**
   * 检查 hook 是否已安装
   * 脚本文件和 settings.json 配置必须同时存在才算已安装
   */
  async isInstalled(): Promise<boolean> {
    // 检查两个脚本文件是否都存在
    let approvalScriptExists = false
    let permissionScriptExists = false
    try {
      await access(HOOK_SCRIPT_PATH)
      approvalScriptExists = true
    } catch { /* 不存在 */ }
    try {
      await access(PERMISSION_ACCEPT_PATH)
      permissionScriptExists = true
    } catch { /* 不存在 */ }

    // 检查 settings.json 中是否有 Sessix hook 配置
    const settings = await this.readClaudeSettings()
    const configExists = this.hasHookConfig(settings)

    // 所有组件都存在才算已安装
    return approvalScriptExists && permissionScriptExists && configExists
  }

  // ============================================
  // 内部方法
  // ============================================

  /**
   * 向 Claude Code settings.json 添加 Sessix hook 配置
   */
  private async addHookToSettings(): Promise<void> {
    let settings = await this.readClaudeSettings()
    let changed = false

    // 清理旧版 bash hook 配置（.sh → .js 升级）
    for (const cmd of LEGACY_HOOK_COMMANDS) {
      this.removeHookCommand(settings, 'PreToolUse', cmd)
      this.removeHookCommand(settings, 'PermissionRequest', cmd)
    }

    // 确保 hooks 结构存在
    if (!settings.hooks) {
      settings.hooks = {}
    }

    // PreToolUse: approval-hook.js
    if (!this.hasPreToolUseConfig(settings)) {
      if (!settings.hooks.PreToolUse) {
        settings.hooks.PreToolUse = []
      }
      settings.hooks.PreToolUse.push({
        matcher: '',
        hooks: [{ type: 'command', command: HOOK_COMMAND }],
      })
      changed = true
    }

    // PermissionRequest: permission-accept.js（兜底未知工具）
    if (!this.hasPermissionRequestConfig(settings)) {
      if (!settings.hooks.PermissionRequest) {
        settings.hooks.PermissionRequest = []
      }
      settings.hooks.PermissionRequest.push({
        matcher: '',
        hooks: [{ type: 'command', command: PERMISSION_ACCEPT_COMMAND }],
      })
      changed = true
    }

    if (changed) {
      await this.writeClaudeSettings(settings)
    } else {
      console.log('[HookInstaller] Hook config already exists, skipping')
    }
  }

  /**
   * 从 Claude Code settings.json 移除 Sessix hook 配置
   */
  private async removeHookFromSettings(): Promise<void> {
    let settings = await this.readClaudeSettings()
    if (!settings.hooks) return

    // 移除 PreToolUse 中的 approval-hook.js
    this.removeHookCommand(settings, 'PreToolUse', HOOK_COMMAND)
    // 移除 PermissionRequest 中的 permission-accept.js
    this.removeHookCommand(settings, 'PermissionRequest', PERMISSION_ACCEPT_COMMAND)

    // 如果 hooks 为空，删除它
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks
    }

    await this.writeClaudeSettings(settings)
  }

  /** 从指定 hook 事件数组中移除包含指定命令的条目 */
  private removeHookCommand(settings: any, event: string, command: string): void {
    if (!Array.isArray(settings.hooks?.[event])) return

    settings.hooks[event] = settings.hooks[event].filter(
      (entry: any) => !entry?.hooks?.some?.((h: any) => h.type === 'command' && h.command === command),
    )

    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event]
    }
  }

  /**
   * 读取 Claude Code settings.json
   */
  private async readClaudeSettings(): Promise<any> {
    try {
      const content = await readFile(CLAUDE_SETTINGS_PATH, 'utf-8')
      return JSON.parse(content)
    } catch {
      // 文件不存在或解析失败，返回空对象
      return {}
    }
  }

  /**
   * 写入 Claude Code settings.json
   */
  private async writeClaudeSettings(settings: any): Promise<void> {
    // 确保 .claude 目录存在
    await mkdir(join(homedir(), '.claude'), { recursive: true })
    await writeFile(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
  }

  /**
   * 检查 settings 中是否已包含所有 Sessix hook 配置
   */
  private hasHookConfig(settings: any): boolean {
    return this.hasPreToolUseConfig(settings) && this.hasPermissionRequestConfig(settings)
  }

  /** 检查 PreToolUse 中是否有 approval-hook.js */
  private hasPreToolUseConfig(settings: any): boolean {
    return this.hasHookEntry(settings?.hooks?.PreToolUse, HOOK_COMMAND)
  }

  /** 检查 PermissionRequest 中是否有 permission-accept.js */
  private hasPermissionRequestConfig(settings: any): boolean {
    return this.hasHookEntry(settings?.hooks?.PermissionRequest, PERMISSION_ACCEPT_COMMAND)
  }

  /** 检查 hook 数组中是否包含指定命令 */
  private hasHookEntry(hookArray: any, command: string): boolean {
    if (!Array.isArray(hookArray)) return false
    return hookArray.some((entry: any) =>
      entry?.hooks?.some?.((hook: any) => hook.type === 'command' && hook.command === command),
    )
  }
}
