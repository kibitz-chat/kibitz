import type { ChatItem } from './useCall'
import { sanitizeImg, type ImagePayload } from './imageAttach'

// The durable snapshot of the chat LEDGER (docs/chat-ledger.md): a serializable, ordered set of the room's PUBLIC
// chat items. A "durable member" (the agent, in Layer 2) seals + stores this when the room changes/empties, and
// contributes it back through the normal union path on rejoin — so history survives everyone leaving, WITHOUT the
// agent reconstructing chat from its private event log. Pure (serialize/deserialize) so it's unit-testable and has
// no engine coupling; useCall wraps it as exportLedger()/importLedger().

/** A durable attachment (a chunked upload — image or file). `data` is the base64 bytes, present only when the
 *  source RETAINED them (an in-RAM transfer under the cap); absent ⇒ a metadata-only "shared earlier" chip
 *  (the bytes were over-cap or streamed straight to disk — deferred to the Layer-3 blob store). */
export interface LedgerAttachment {
  kind: 'image' | 'file'
  mime: string
  name?: string
  size: number
  data?: string
}

/** One durable ledger entry. `id` is the stable merge key (mid for text, CONTENT id for image, widget id,
 *  the public mid — else the xid — for an attachment). */
export interface LedgerItem {
  kind: 'text' | 'image' | 'widget' | 'attachment'
  id: string
  ts: number
  from: string
  name: string
  text?: string
  image?: ImagePayload
  widget?: { id: string; kind: string; data: unknown }
  attachment?: LedgerAttachment
}

// A seeded/restored image is delivered via the chunked xfer (50MB cap), NOT the 256KB inline broadcast — so the
// snapshot may carry a full-res image. Bound it well under the xfer + media-replay budgets.
const IMG_MAX = 16 * 1024 * 1024
// Per-attachment RAW-byte cap for INLINE persistence: at or under this, the bytes ride the ledger (base64) and
// the upload re-downloads on rehydrate; over it (or a >50MB disk-streamed transfer), only metadata persists — a
// "shared earlier" chip. Kept modest so the sealed snapshot stays sane; the real home for large bytes is the
// Layer-3 blob store (content-hash refs), which supersedes inlining. base64 inflates ~4/3, so bound that too.
const ATTACH_BYTES_MAX = 8 * 1024 * 1024
const ATTACH_B64_MAX = Math.ceil((ATTACH_BYTES_MAX * 4) / 3) + 4
/** Cheap guard that a string looks like base64 (charset only — it's a merge payload, not a security boundary). */
const looksBase64 = (s: string): boolean => s.length > 0 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)

/** A stable CONTENT id for an image, so images are first-class ledger entries even though the live buffer stamps no
 *  mid on them — and so the SAME image (a produced painting fed back, a re-post) collapses to ONE entry. Not a
 *  security boundary (it's a merge/dedup key), so a fast sync FNV-1a over the base64 keeps serialize synchronous;
 *  the length prefix cuts collisions further. */
export function imageContentId(dataB64: string): string {
  const s = String(dataB64 || '')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `img:${s.length.toString(36)}:${(h >>> 0).toString(16).padStart(8, '0')}`
}

const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)
const str = (s: unknown, max: number): string => (typeof s === 'string' ? s.slice(0, max) : '')

/** The room's held PUBLIC chat → a durable snapshot: text (needs a mid), images (keyed by content id), widgets
 *  (keyed by widget id). DMs are never persisted. Deduped by `id` (a refreshed widget / a re-posted image collapse
 *  to one), ordered by `ts`, capped to the most-recent `keep`. Pure. */
export function serializeLedger(chat: readonly ChatItem[], keep: number): LedgerItem[] {
  const byId = new Map<string, LedgerItem>()
  for (const it of chat) {
    if (it.dm) continue
    let li: LedgerItem | null = null
    if (it.widget) {
      const id = (it.widget.id || '').trim()
      if (id) li = { kind: 'widget', id, ts: num(it.ts), from: it.from || '', name: it.name || it.from || 'Guest', widget: it.widget }
    } else if (it.image) {
      li = { kind: 'image', id: imageContentId(it.image.data), ts: num(it.ts), from: it.from || '', name: it.name || it.from || 'Guest', image: it.image }
    } else if (it.attachment) {
      // A chunked upload (image or file). Key by the PUBLIC mid (so a restored entry dedups against the LIVE
      // line by mid) — xid as a fallback. Inline the bytes when the source retained them under the cap; else
      // persist metadata only (a "shared earlier" chip — bytes deferred to Layer 3).
      const a = it.attachment
      const id = (it.mid || a.xid || '').trim()
      if (id) {
        const data = typeof a.data === 'string' && a.data.length <= ATTACH_B64_MAX && looksBase64(a.data) ? a.data : undefined
        li = {
          kind: 'attachment',
          id,
          ts: num(it.ts),
          from: it.from || '',
          name: it.name || it.from || 'Guest',
          attachment: {
            kind: a.kind === 'image' ? 'image' : 'file',
            mime: (a.mime || 'application/octet-stream').slice(0, 100),
            ...(a.name ? { name: String(a.name).slice(0, 200) } : {}),
            size: num(a.size),
            ...(data ? { data } : {}),
          },
        }
      }
    } else if ((it.text || '').trim()) {
      const id = (it.mid || '').trim()
      if (id) li = { kind: 'text', id, ts: num(it.ts), from: it.from || '', name: it.name || it.from || 'Guest', text: it.text }
    }
    if (li) byId.set(li.id, li) // last write wins (a refreshed widget / re-synced item)
  }
  const uniq = [...byId.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return uniq.length > keep ? uniq.slice(uniq.length - keep) : uniq
}

/** Parse an untrusted snapshot (loaded blob) back into valid LedgerItems — a stable id + a well-formed body per
 *  kind; images re-sanitized (large cap, since delivery is via xfer). Malformed entries are dropped. Pure. */
export function deserializeLedger(snapshot: unknown): LedgerItem[] {
  if (!Array.isArray(snapshot)) return []
  const out: LedgerItem[] = []
  for (const r of snapshot as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue
    const id = (str(r.id, 120) || '').trim()
    if (!id) continue
    const ts = num(r.ts)
    const from = str(r.from, 80).trim()
    const name = str(r.name, 80).trim() || from || 'Guest'
    if (r.kind === 'text' && typeof r.text === 'string' && r.text.trim()) {
      out.push({ kind: 'text', id, ts, from, name, text: r.text })
    } else if (r.kind === 'image' && r.image) {
      const clean = sanitizeImg(r.image as Record<string, unknown>, IMG_MAX)
      if (clean) out.push({ kind: 'image', id, ts, from, name, image: clean })
    } else if (r.kind === 'widget' && r.widget && typeof r.widget === 'object') {
      const w = r.widget as Record<string, unknown>
      const wkind = str(w.kind, 40).trim()
      if (wkind) out.push({ kind: 'widget', id, ts, from, name, widget: { id: str(w.id, 120).trim() || id, kind: wkind, data: w.data } })
    } else if (r.kind === 'attachment' && r.attachment && typeof r.attachment === 'object') {
      const a = r.attachment as Record<string, unknown>
      const akind = a.kind === 'image' ? 'image' : a.kind === 'file' ? 'file' : ''
      if (akind) {
        const nm = str(a.name, 200).trim()
        const data = typeof a.data === 'string' && a.data.length <= ATTACH_B64_MAX && looksBase64(a.data) ? a.data : undefined
        out.push({
          kind: 'attachment',
          id,
          ts,
          from,
          name,
          attachment: { kind: akind, mime: str(a.mime, 100).trim() || 'application/octet-stream', ...(nm ? { name: nm } : {}), size: num(a.size), ...(data ? { data } : {}) },
        })
      }
    }
  }
  return out
}
