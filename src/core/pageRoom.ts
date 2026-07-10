import { normalizeRoom } from './transport'

/**
 * Deterministic room for a URL — the extension's whole magic: two friends on
 * the same page land in the same room with zero coordination.
 *
 * Canonical form: hostname (www stripped) + pathname (trailing slashes
 * stripped, lowercased). Query strings and fragments are deliberately ignored —
 * they carry tracking junk far more often than identity. The room reads as
 * `host-slug-tag` so people can still say it out loud, with an FNV-1a tag of
 * the full canonical URL carrying the uniqueness.
 */
export function roomForUrl(href: string): string {
  const u = new URL(href)
  const host = u.hostname.replace(/^www\./, '')
  const path = u.pathname.replace(/\/+$/, '').toLowerCase()
  const key = `${host}${path}`

  // FNV-1a, 32-bit — tiny, fast, good enough spread for room names.
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const tag = (h >>> 0).toString(36)

  const hostSlug = normalizeRoom(host).slice(0, 38 - tag.length)
  return normalizeRoom(`${hostSlug}-${tag}`)
}
