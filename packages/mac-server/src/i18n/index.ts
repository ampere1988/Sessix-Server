import { zh } from './locales/zh'
import { en } from './locales/en'

type DeepStringRecord = { readonly [key: string]: string | DeepStringRecord }

const locales: Record<string, DeepStringRecord> = { zh, en }

function detectLocale(): string {
  // SESSIX_LANG takes priority, then follow system locale.
  const explicit = process.env.SESSIX_LANG
  if (explicit && explicit in locales) return explicit
  try {
    const raw = process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || ''
    if (raw.startsWith('zh')) return 'zh'
  } catch {
    // detection failed
  }
  return 'en'
}

let currentLocale = detectLocale()
let currentMessages: DeepStringRecord = locales[currentLocale] ?? en

export function setLocale(locale: string): void {
  currentLocale = locale
  currentMessages = locales[locale] ?? (en as DeepStringRecord)
}

export function getLocale(): string {
  return currentLocale
}

/**
 * Translate a dot-separated key, with optional interpolation.
 * Falls back to English, then to the key itself.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const parts = key.split('.')
  let val: unknown = currentMessages
  for (const p of parts) {
    if (val && typeof val === 'object') {
      val = (val as Record<string, unknown>)[p]
    } else {
      val = undefined
      break
    }
  }
  // Fallback to English
  if (typeof val !== 'string') {
    let fallback: unknown = en
    for (const p of parts) {
      if (fallback && typeof fallback === 'object') {
        fallback = (fallback as Record<string, unknown>)[p]
      } else {
        fallback = undefined
        break
      }
    }
    val = typeof fallback === 'string' ? fallback : key
  }
  let result = val as string
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      result = result.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v))
    }
  }
  return result
}
