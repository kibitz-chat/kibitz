// Chat ↔ room-state ledger adapter (docs/unified-room-sync.md, phase 2).
//
// Maps the chat BUFFER onto the roomLedger CRDT so the room's transcript rides the SAME convergence machinery
// as room state (RoomLedger + LedgerSync + LedgerStore) — one mechanism for "catch a peer up", replacing the
// separate live re-broadcast (useChat/Media/WidgetSync) and durable seal (export/importLedger).
//
// Each public chat line is an OWNED key (`key = mid`, `author = from`, `seq = ts`) — immutable, so the LWW
// merge never actually conflicts (same mid ⇒ identical value); the union is just the keyspace ordered by ts.
// Values are SMALL: text, a widget payload, or a media REF { hash, mime, size } — bytes NEVER ride the ledger;
// they live in the content-addressed blob store and are fetched by hash (blobSync). Pure + unit-tested; the
// wiring (feed through LedgerSync, reconstruct ChatItems, fetch bytes) is the next, flag-gated step.

import type { LedgerState } from '../core/roomLedger'
import { blobHash } from '../core/blobStore'
import { base64ToBytes } from '../core/contentXfer'
import type { ChatItem } from './useCall'

/** Chat lines outlive the resumable-hint but shouldn't linger forever on a dead room's local copy; a generous
 *  default TTL bounds at-rest growth (the agent's Layer-2 store is the durable copy). Caller-overridable. */
export const DEFAULT_CHAT_TTL_MS = 7 * 24 * 60 * 60 * 1000

type Base = { from: string; name: string; ts: number }
/** The value stored under a chat key — small metadata only (media is a hash REF, never bytes). */
export type ChatEntryValue =
  | ({ t: 'text'; text: string } & Base)
  | ({ t: 'widget'; wid: string; kind: string; data: unknown } & Base)
  | ({ t: 'media'; media: 'image' | 'file'; mime: string; fileName?: string; size: number; hash?: string } & Base)

/** A reconstructed chat line from the ledger (ordered by ts). The wiring maps this back to a ChatItem — text
 *  directly, media into an attachment whose bytes are fetched by `hash` via blobSync. */
export interface ChatLedgerLine {
  key: string
  value: ChatEntryValue
}

const str = (s: unknown, max: number): string => (typeof s === 'string' ? s.slice(0, max) : '')
const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)

/** Content hash of inline base64 (for a media ref), or undefined if absent/undecodable. Sync (pure-JS sha256). */
function hashOf(b64: string | undefined): string | undefined {
  if (!b64) return undefined
  try {
    return blobHash(base64ToBytes(b64))
  } catch {
    return undefined
  }
}

/** The cross-peer-stable merge key for a line: the public `mid` first (so two peers' copies of the same line
 *  converge), then a type-stable id, so legacy items without a mid still key deterministically. */
function keyOf(it: ChatItem): string {
  const mid = (it.mid || '').trim()
  if (mid) return mid
  if (it.widget?.id) return it.widget.id
  if (it.attachment?.xid) return it.attachment.xid
  if (it.image) return hashOf(it.image.data) || ''
  return ''
}

/** One chat line → its ledger value (small; media becomes a ref), or null if it's not a persistable public line. */
function valueOf(it: ChatItem): ChatEntryValue | null {
  const base: Base = { from: it.from || '', name: it.name || it.from || 'Guest', ts: num(it.ts) }
  if (it.widget) return it.widget.id ? { t: 'widget', wid: it.widget.id, kind: it.widget.kind, data: it.widget.data, ...base } : null
  if (it.attachment) {
    const a = it.attachment
    const hash = a.hash || hashOf(a.data) // a precomputed ref (a reconstructed line) wins; else hash the inline bytes
    return { t: 'media', media: a.kind === 'image' ? 'image' : 'file', mime: a.mime || 'application/octet-stream', ...(a.name ? { fileName: a.name } : {}), size: num(a.size), ...(hash ? { hash } : {}), ...base }
  }
  if (it.image) return { t: 'media', media: 'image', mime: it.image.mime || 'image/png', size: Math.floor(((it.image.data?.length || 0) * 3) / 4), ...(hashOf(it.image.data) ? { hash: hashOf(it.image.data) } : {}), ...base }
  if ((it.text || '').trim()) return { t: 'text', text: it.text, ...base }
  return null
}

/** The held PUBLIC chat → a roomLedger state: each line an owned key (mid), value small, media as a hash ref.
 *  DMs are never persisted. `now`/`ttlMs` set each entry's expireAt (TTL-GC). Pure. */
export function chatToLedger(chat: readonly ChatItem[], opts: { now: number; ttlMs?: number }): LedgerState {
  const ttl = opts.ttlMs ?? DEFAULT_CHAT_TTL_MS
  const out: LedgerState = {}
  for (const it of chat) {
    if (it.dm) continue
    const key = keyOf(it)
    if (!key) continue
    const value = valueOf(it)
    if (!value) continue
    // Immutable line ⇒ seq = ts; on the off chance two lines share a key, higher ts (then author) wins — same
    // deterministic LWW as any owned key, so the merge stays commutative.
    out[key] = { kind: 'owned', value, author: value.from, seq: value.ts, expireAt: opts.now + ttl }
  }
  return out
}

const VALID_MEDIA = new Set(['image', 'file'])
/** Validate one untrusted ledger value back into a ChatEntryValue (drop malformed), clamping strings. */
function parseValue(v: unknown): ChatEntryValue | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const base: Base = { from: str(r.from, 80), name: str(r.name, 80) || str(r.from, 80) || 'Guest', ts: num(r.ts) }
  if (r.t === 'text') return (r.text as string)?.trim?.() ? { t: 'text', text: r.text as string, ...base } : null
  if (r.t === 'widget') {
    const kind = str(r.kind, 40).trim()
    const wid = str(r.wid, 120).trim()
    return kind && wid ? { t: 'widget', wid, kind, data: r.data, ...base } : null
  }
  if (r.t === 'media' && VALID_MEDIA.has(r.media as string)) {
    const hash = str(r.hash, 128).trim()
    const fileName = str(r.fileName, 200).trim()
    return { t: 'media', media: r.media as 'image' | 'file', mime: str(r.mime, 100).trim() || 'application/octet-stream', ...(fileName ? { fileName } : {}), size: num(r.size), ...(hash ? { hash } : {}), ...base }
  }
  return null
}

/** A ledger state → ordered chat lines (live owned entries only, ascending ts, malformed dropped). Pure. The
 *  reverse of chatToLedger for the union a peer converges to. */
export function ledgerToChat(state: LedgerState, now: number): ChatLedgerLine[] {
  const lines: ChatLedgerLine[] = []
  for (const key of Object.keys(state)) {
    const e = state[key]
    if (!e || e.kind !== 'owned' || !(e.expireAt > now)) continue
    const value = parseValue(e.value)
    if (value) lines.push({ key, value })
  }
  lines.sort((a, b) => a.value.ts - b.value.ts || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return lines
}
