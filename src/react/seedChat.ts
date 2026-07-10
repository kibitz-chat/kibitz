import { sanitizeImg, type ImagePayload } from './imageAttach'
import type { ChatItem } from './useCall'

// One history line a resuming agent seeds into its own chat buffer to restore the VISIBLE conversation (text +
// produced images) it recovered from persistent memory. NOTE: since the late-joiner replay family was removed
// (2026-07-02), seeding only FILLS this peer's buffer — it is no longer re-broadcast to present peers. A line is
// EITHER text OR an image; both need a stable `mid` (the dedup/merge key) so a re-seed is idempotent and a live
// line with the same id is not doubled. `ts` is the ORIGINAL send time (the ordering key); `from`/`name` is the
// ORIGINAL author.
export interface SeedLine {
  text?: string
  image?: ImagePayload
  mid: string
  ts?: number
  from?: string
  name?: string
}

// The SEED may carry a full-res produced image (a few MB) — the 256KB inline-image cap would silently reject every
// real painting — so bind it well under the xfer budget instead.
const SEED_IMG_DATA_MAX = 16 * 1024 * 1024

/** Map a seed line to a held ChatItem (image OR text), or null if it isn't seedable — no stable `mid`, a text line
 *  with no body, or an image that fails sanitize. PURE (no Date/IO) so it's unit-testable; the caller supplies the
 *  render `id` and the text cap. A seeded item is `self:false` (it's restored history, not a fresh authored line). */
export function chatItemFromSeedLine(line: SeedLine, id: number, maxText: number): ChatItem | null {
  const mid = typeof line?.mid === 'string' && line.mid.trim() ? line.mid.trim().slice(0, 80) : ''
  if (!mid) return null
  const ts = typeof line?.ts === 'number' && Number.isFinite(line.ts) ? line.ts : 0
  const from = typeof line?.from === 'string' ? line.from.trim().slice(0, 80) : ''
  const name = typeof line?.name === 'string' && line.name.trim() ? line.name.trim().slice(0, 80) : from || 'Guest'
  if (line.image) {
    const clean = sanitizeImg(line.image, SEED_IMG_DATA_MAX) // allow a full-res image (delivered via xfer, not inline)
    if (!clean) return null
    return { from, name, text: '', image: clean, id, self: false, mid, ts }
  }
  const text = typeof line?.text === 'string' ? line.text.slice(0, maxText).trim() : ''
  if (!text) return null
  return { from, name, text, id, self: false, mid, ts }
}
