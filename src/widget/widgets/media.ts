// kbz.media — an image / video / audio by URL, behind a STRICT host allowlist (the security crux: an arbitrary
// agent-supplied URL is an SSRF / tracking / malicious-media vector). Default: Wikimedia/Wikipedia + the brand's
// own storefront; override via VITE_MEDIA_HOSTS (comma-separated host suffixes). http(s) only — never data:.
import type { WidgetExport } from './types'

export interface MediaData {
  type: 'image' | 'video' | 'audio'
  url: string
  caption?: string
  /** Poster image for a video (also allowlisted). */
  poster?: string
}

const DEFAULT_HOSTS = ['wikimedia.org', 'wikipedia.org', 'kibitz.chat', 'kibitz.chat']
const EXTRA = ((typeof import.meta !== 'undefined' && (import.meta as { env?: Record<string, string> }).env?.VITE_MEDIA_HOSTS) || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean)
const ALLOW = [...DEFAULT_HOSTS, ...EXTRA]

/** A URL is OK iff it's http(s) and its host equals or is a subdomain of an allowlisted host. */
export function allowedMediaUrl(u: unknown): string | null {
  if (typeof u !== 'string' || !u) return null
  let parsed: URL
  try {
    parsed = new URL(u)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase()
  return ALLOW.some((h) => host === h || host.endsWith('.' + h)) ? u.slice(0, 1000) : null
}

export function sanitizeMedia(raw: unknown): MediaData | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const url = allowedMediaUrl(d.url)
  if (!url) return null
  const t = String(d.type || '').toLowerCase()
  const type: MediaData['type'] = t === 'video' ? 'video' : t === 'audio' ? 'audio' : 'image'
  return {
    type,
    url,
    caption: typeof d.caption === 'string' && d.caption.trim() ? d.caption.slice(0, 200) : undefined,
    poster: allowedMediaUrl(d.poster) || undefined,
  }
}

const EXT_BY_TYPE: Record<MediaData['type'], string> = { image: 'png', video: 'mp4', audio: 'mp3' }

/** kbz.media → the media file ITSELF. Fetches the allowlisted url to a blob; the extension comes from the url
 *  path, else a per-type default. Returns null if the fetch fails (CORS / offline) → saveWidget falls back to the
 *  JSON (which still preserves the url). */
export async function exportMedia(data: MediaData): Promise<WidgetExport | null> {
  if (typeof fetch === 'undefined') return null
  try {
    const res = await fetch(data.url)
    if (!res.ok) return null
    const blob = await res.blob()
    const m = data.url.split(/[?#]/)[0].match(/\.([a-z0-9]{1,5})$/i)
    const ext = (m?.[1] || EXT_BY_TYPE[data.type] || 'bin').toLowerCase()
    return { blob, base: data.caption || data.type, ext }
  } catch {
    return null
  }
}
