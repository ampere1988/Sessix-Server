import { execSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isWindows } from './platform.js'

/** 查找 claude CLI 的完整路径 */
export function findClaudePath(): string {
  // 1. 尝试系统 PATH 查找
  try {
    const cmd = isWindows ? 'where claude' : 'which claude'
    return execSync(cmd, { encoding: 'utf-8' }).trim().split('\n')[0]
  } catch { /* 继续 */ }

  // 2. 尝试已知候选路径
  const candidates = isWindows
    ? [
        join(process.env.LOCALAPPDATA ?? '', 'Programs', 'claude', 'claude.exe'),
        join(homedir(), 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
        join(homedir(), '.claude', 'local', 'claude.exe'),
      ]
    : [
        join(homedir(), '.local', 'bin', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
      ]

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch { /* 继续 */ }
  }

  // 3. 兜底：返回 'claude'，交给 PATH 解析
  return 'claude'
}
