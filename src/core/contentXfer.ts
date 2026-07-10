// Unified chunked CONTENT TRANSFER — the framing under chat / images / files. Every piece of content
// is sent over the reliable+ordered P2P data mesh as a `xbegin` → `xchunk`… → `xend` sequence
// (protocol.ts). The channel guarantees delivery + order, so this layer only needs to: split bytes
// into bounded chunks, reassemble them, and bound everything against a hostile peer (size cap, chunk
// sanity, per-peer concurrency). Pure + environment-agnostic (Uint8Array + a cross-env base64), so it
// unit-tests in node and runs in the browser unchanged. NO DOM, NO transport here.

export const XFER_KINDS = ['text', 'image', 'file'] as const
export type XferKind = (typeof XFER_KINDS)[number]

export const XFER = {
  /** Raw bytes per chunk. Base64 inflates ~4/3, so a chunk message is ~64KB — well under the 256KB
   *  per-message ceiling and friendly to the data channel. */
  CHUNK_BYTES: 48 * 1024,
  /** Hard ceiling on a single transfer — the whole thing buffers in RAM on both ends (no streaming to
   *  disk), so this bounds memory. Rejected on receive above it. */
  MAX_BYTES: 50 * 1024 * 1024,
  /** Max simultaneous INCOMING transfers from one peer — so a peer can't open thousands to exhaust us. */
  MAX_CONCURRENT_IN: 4,
  /** Drop a partial transfer that goes quiet this long (a peer vanished mid-send; no resume → reclaim). */
  STALL_MS: 30_000,
  /** Clamp a transfer's declared file name. */
  NAME_MAX: 120,
} as const

export interface XferBegin {
  id: string
  kind: XferKind
  size: number
  n: number
  mime?: string
  name?: string
  /** TEXT transfers only: the stable chat id (`${fromMediaId}#${senderSeq}`) so a received text line can be
   *  merged/deduped in the reconciled public chat exactly like a `k:'chat'` line. */
  mid?: string
  /** TEXT transfers only: the sender's wall-clock ms, so the public chat union orders by send time. */
  ts?: number
  /** TEXT replayed-history only: the ORIGINAL author's media id when the sender re-broadcast someone else's line
   *  (an agent vouching the persisted transcript). DISPLAY-ONLY + UNVERIFIED — never a verified badge. */
  author?: string
  /** TEXT replayed-history only: the original author's display name (paired with `author`). */
  authorName?: string
}

/** Number of chunks a payload of `size` bytes needs. */
export function chunkCount(size: number, chunkBytes: number = XFER.CHUNK_BYTES): number {
  return size <= 0 ? 0 : Math.ceil(size / chunkBytes)
}

// ── sender-side progress aggregation (broadcast = one file streamed to N peers, one progress bar) ──────
/** The fraction to show on the SENDER's single progress bar across the peers a transfer is streaming to:
 *  the MIN (slowest receiver) — the file is only as delivered as its slowest peer, so the bar hits 100%
 *  exactly when EVERY recipient has the whole thing. 0 when no peer is tracked yet. Clamped to [0,1]. Pure. */
export function minSendProgress(fracs: Iterable<number>): number {
  let min = Infinity
  for (const f of fracs) min = Math.min(min, f)
  return Number.isFinite(min) ? Math.max(0, Math.min(1, min)) : 0
}

/** True once every tracked peer holds the whole file (all fractions ≥ 1) and there's at least one — the
 *  signal to flip the sender's attachment from `active` to `done`. Pure. */
export function allSendsComplete(fracs: readonly number[]): boolean {
  return fracs.length > 0 && fracs.every((f) => f >= 1)
}

// ── base64 (cross-env: browser btoa/atob, else node Buffer) ────────────────────────────────────────
type WithBuffer = { Buffer?: { from(s: string | Uint8Array, enc?: string): { toString(enc: string): string } } & { from(b: Uint8Array): Uint8Array } }
const g = globalThis as unknown as { btoa?: (s: string) => string; atob?: (s: string) => string } & WithBuffer

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof g.btoa === 'function') {
    let bin = ''
    const STEP = 0x8000 // chunk the String.fromCharCode to avoid arg-count limits on big arrays
    for (let i = 0; i < bytes.length; i += STEP) bin += String.fromCharCode(...bytes.subarray(i, i + STEP))
    return g.btoa(bin)
  }
  return (g.Buffer as NonNullable<WithBuffer['Buffer']>).from(bytes).toString('base64')
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof g.atob === 'function') {
    const bin = g.atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  return new Uint8Array((g.Buffer as NonNullable<WithBuffer['Buffer']>).from(b64, 'base64') as unknown as Uint8Array)
}

export const textToBytes = (s: string): Uint8Array => new TextEncoder().encode(s)
export const bytesToText = (b: Uint8Array): string => new TextDecoder().decode(b)

/** Split bytes into ordered chunks of at most `chunkBytes`. */
export function splitChunks(bytes: Uint8Array, chunkBytes: number = XFER.CHUNK_BYTES): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let off = 0; off < bytes.length; off += chunkBytes) out.push(bytes.subarray(off, Math.min(off + chunkBytes, bytes.length)))
  return out
}

/** base64 sanity for an incoming chunk's `data` (reject junk before we decode it). */
export const isBase64 = (s: string): boolean => typeof s === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(s)

// ── xfer.v2 binary chunk frame ───────────────────────────────────────────────────────────────────────
// Send a chunk as a RAW binary mesh message instead of a base64 JSON `xchunk` — no 4/3 base64 inflation, no
// intermediate base64 string, no encode/decode CPU. A binary mesh message and a JSON control message are
// distinguishable on receive (ArrayBuffer/typed-array vs object), so the control messages (xbegin/xend/…)
// stay JSON and only the high-volume chunk goes binary. Negotiated via the `xfer.v2` feature tag; a peer
// without it is sent base64 `xchunk` (xfer.v1) instead. Pure (Uint8Array only) → unit-testable.
//   layout: [idLen:u8][id:idLen utf8][i:u32 LE][payload bytes…]
const XFRAME_ID_MAX = 64 // the transfer id is already sliced to ≤64 (validateBegin)

export function encodeChunkFrame(id: string, i: number, payload: Uint8Array): Uint8Array {
  const idBytes = new TextEncoder().encode(id).subarray(0, XFRAME_ID_MAX)
  const out = new Uint8Array(1 + idBytes.length + 4 + payload.length)
  out[0] = idBytes.length
  out.set(idBytes, 1)
  new DataView(out.buffer).setUint32(1 + idBytes.length, i >>> 0, true) // little-endian chunk index
  out.set(payload, 1 + idBytes.length + 4)
  return out
}

/** Parse a binary chunk frame; null if it's too short / malformed. The payload is a VIEW into `buf`. */
export function decodeChunkFrame(buf: Uint8Array): { id: string; i: number; bytes: Uint8Array } | null {
  if (!(buf instanceof Uint8Array) || buf.length < 5) return null
  const idLen = buf[0]
  if (idLen === 0 || idLen > XFRAME_ID_MAX || buf.length < 1 + idLen + 4) return null
  const id = bytesToText(buf.subarray(1, 1 + idLen))
  const i = new DataView(buf.buffer, buf.byteOffset + 1 + idLen, 4).getUint32(0, true)
  return { id, i, bytes: buf.subarray(1 + idLen + 4) }
}

/** Normalize any binary mesh message (ArrayBuffer / typed-array) to a Uint8Array, or null if it isn't one. */
export function asBytes(msg: unknown): Uint8Array | null {
  if (msg instanceof Uint8Array) return msg
  if (msg instanceof ArrayBuffer) return new Uint8Array(msg)
  if (ArrayBuffer.isView(msg)) return new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength)
  return null
}

/** Validate + normalize an incoming `xbegin` against the limits, or null if it's malformed/over-budget.
 *  The receive-side trust boundary: id present, kind allowlisted, size within 0..max, n consistent with
 *  the size/chunk arithmetic (so a peer can't claim 1 chunk for a 50MB file, or 10^9 empty chunks). */
export function validateBegin(
  m: { id?: unknown; kind?: unknown; size?: unknown; n?: unknown; mime?: unknown; name?: unknown; mid?: unknown; ts?: unknown; author?: unknown; authorName?: unknown },
  max: number = XFER.MAX_BYTES,
  chunkBytes: number = XFER.CHUNK_BYTES,
): XferBegin | null {
  const id = typeof m.id === 'string' && m.id ? m.id.slice(0, 64) : ''
  if (!id) return null
  if (typeof m.kind !== 'string' || !(XFER_KINDS as readonly string[]).includes(m.kind)) return null
  const size = m.size
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0 || size > max) return null
  const n = m.n
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null
  // n must match the declared size: exactly ceil(size/chunk), and 0 only for an empty payload.
  if (n !== chunkCount(size, chunkBytes)) return null
  const mime = typeof m.mime === 'string' && m.mime ? m.mime.slice(0, 100) : undefined
  const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, XFER.NAME_MAX) : undefined
  // Optional stable chat id + send time (TEXT only) — bounded like any other received string/number.
  const mid = typeof m.mid === 'string' && m.mid ? m.mid.slice(0, 80) : undefined
  const ts = typeof m.ts === 'number' && Number.isFinite(m.ts) ? m.ts : undefined
  // Optional ORIGINAL-author override (TEXT replayed history only) — DISPLAY-ONLY + UNVERIFIED, bounded.
  const author = typeof m.author === 'string' && m.author.trim() ? m.author.trim().slice(0, 80) : undefined
  const authorName = typeof m.authorName === 'string' && m.authorName.trim() ? m.authorName.trim().slice(0, 80) : undefined
  return { id, kind: m.kind as XferKind, size, n, ...(mime ? { mime } : {}), ...(name ? { name } : {}), ...(mid ? { mid } : {}), ...(ts !== undefined ? { ts } : {}), ...(author ? { author } : {}), ...(authorName ? { authorName } : {}) }
}

/** Accumulates the chunks of ONE incoming transfer in order-independent slots, bounded by the begin
 *  header (chunk index in range, no dupes, total bytes ≤ declared size). Pure + DOM-free. */
export class Reassembler {
  private parts: (Uint8Array | undefined)[]
  private got = 0
  private bytes = 0
  /** Epoch-ms of the last accepted chunk — the caller uses it to reap a stalled transfer. */
  lastAt: number

  constructor(
    readonly begin: XferBegin,
    startedAt: number,
  ) {
    this.parts = new Array(Math.max(0, begin.n))
    this.lastAt = startedAt
  }

  /** Add chunk `i`; false if rejected (out of range, duplicate, or would exceed the declared size). */
  add(i: number, chunk: Uint8Array, atMs: number): boolean {
    if (!Number.isInteger(i) || i < 0 || i >= this.begin.n || this.parts[i]) return false
    if (this.bytes + chunk.length > this.begin.size) return false
    this.parts[i] = chunk
    this.got++
    this.bytes += chunk.length
    this.lastAt = atMs
    return true
  }

  get complete(): boolean {
    return this.got === this.begin.n
  }
  /** 0..1 — for a progress bar. */
  get progress(): number {
    return this.begin.n ? this.got / this.begin.n : 1
  }
  /** Concatenate the received chunks into the full payload (call once complete). */
  assemble(): Uint8Array {
    const out = new Uint8Array(this.bytes)
    let off = 0
    for (const p of this.parts) {
      if (p) {
        out.set(p, off)
        off += p.length
      }
    }
    return out
  }
}
