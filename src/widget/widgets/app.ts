// kbz.app — the OPEN tier (MCP Apps UI / mcp-ui). Unlike the bounded kinds, this renders THIRD-PARTY UI in a
// SANDBOXED IFRAME. It is OFF BY DEFAULT and author-allowlisted: a url is only accepted if its host is in
// VITE_WIDGET_APP_ORIGINS, and raw html only if VITE_WIDGET_APP_ALLOW_HTML=1. With neither set, sanitizeApp
// always returns null, so the kind is inert. See docs/widget-security.md for the full threat model + why this
// is gated. The frame runs with `sandbox` WITHOUT allow-same-origin (opaque origin) and talks to the host only
// over a narrow, validated postMessage bridge (resize/event/ready — never tool-calls). https only.

export interface AppConfig {
  /** Allowlisted host suffixes for a url-mode app. Empty ⇒ url mode disabled. */
  origins: string[]
  /** Whether raw-html (srcdoc) apps are allowed at all. */
  allowHtml: boolean
}

export interface AppData {
  mode: 'url' | 'html'
  /** The https url (url mode) or the html document (html mode). */
  src: string
  title?: string
  /** Initial pixel height (the app may request a resize over the bridge). */
  height: number
}

const env = (typeof import.meta !== 'undefined' && (import.meta as { env?: Record<string, string> }).env) || {}
const DEFAULT_CONFIG: AppConfig = {
  origins: (env.VITE_WIDGET_APP_ORIGINS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  allowHtml: String(env.VITE_WIDGET_APP_ALLOW_HTML || '') === '1',
}

/** Is the open tier enabled at all in this build? (Used to decide whether to even register the kind.) */
export const appTierEnabled = (cfg: AppConfig = DEFAULT_CONFIG): boolean => cfg.origins.length > 0 || cfg.allowHtml

/** Validate an untrusted app payload against the allowlist. `cfg` is injectable for tests; production uses the
 *  build-time env config. Returns null (⇒ nothing renders) unless explicitly allowlisted. */
export function sanitizeApp(raw: unknown, cfg: AppConfig = DEFAULT_CONFIG): AppData | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const height = Math.max(80, Math.min(1200, Number(d.height) || 360))
  const title = typeof d.title === 'string' && d.title.trim() ? d.title.slice(0, 120) : undefined

  if (typeof d.url === 'string') {
    let u: URL
    try {
      u = new URL(d.url)
    } catch {
      return null
    }
    if (u.protocol !== 'https:') return null // the open tier requires https
    const host = u.hostname.toLowerCase()
    if (!cfg.origins.some((h) => host === h || host.endsWith('.' + h))) return null // not allowlisted ⇒ inert
    return { mode: 'url', src: u.href.slice(0, 2000), title, height }
  }
  if (typeof d.html === 'string' && d.html.trim() && cfg.allowHtml) {
    return { mode: 'html', src: d.html.slice(0, 200000), title, height }
  }
  return null
}

/** Clamp a bridge-supplied resize height. */
export const clampAppHeight = (h: unknown): number | null => {
  const n = Number(h)
  return Number.isFinite(n) ? Math.max(80, Math.min(1200, n)) : null
}

/** Reduce a bridge `event` payload to a small, JSON-safe value (no functions, bounded) before it rides wevt. */
export function safeAppPayload(p: unknown): unknown {
  try {
    const s = JSON.stringify(p)
    if (typeof s !== 'string' || s.length > 8000) return null
    return JSON.parse(s)
  } catch {
    return null
  }
}
