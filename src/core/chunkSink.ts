// Streamed large-transfer RECEIVE sink (docs/large-transfer.md). Instead of holding a whole incoming
// transfer in RAM (the 50MB `Reassembler` path), the receiver streams each ordered chunk into a `ChunkSink`,
// so a transfer is bounded by STORAGE, not heap. This module is the PURE contract: the interface, the in-RAM
// fallback (`MemSink`), the per-sink size tiers, and the (pure) sink-choice + free-space math. The browser-
// only disk sinks (OPFS / File System Access) live in `react/chunkSinkWeb.ts`. NO DOM here → unit-testable.

export type SinkKind = 'fsa' | 'opfs' | 'mem'

/** Where an incoming transfer's bytes accumulate. The data channel is reliable + ordered, so chunks arrive
 *  in sequence — `write` appends. `finish` yields the assembled payload (disk-backed for opfs/fsa). */
export interface ChunkSink {
  readonly kind: SinkKind
  /** The disk file name this sink writes to (OPFS only) — persisted so a reload can reopen + append to it. */
  readonly fileName?: string
  /** Append the next chunk (callers feed them in order). */
  write(chunk: Uint8Array): Promise<void>
  /** Once every chunk is written: the complete payload as a Blob/File (disk-backed for opfs/fsa). */
  finish(): Promise<Blob>
  /** Discard a partial transfer (cancel / stall) and free anything written so far. */
  abort(): Promise<void>
  /** Free a disk-backed temp (e.g. the OPFS file) AFTER the finished Blob's object URL is revoked — wired
   *  into the chat buffer's evict path. No-op for mem (GC) and fsa (the user owns the file). */
  cleanup?(): Promise<void>
}

/** Return `chunk` as a standalone, offset-0 Uint8Array — copying ONLY when it is a sub-view of a larger
 *  buffer (offset ≠ 0 or shorter than its backing ArrayBuffer). The disk sinks MUST funnel every write
 *  through this: iOS Safari's OPFS/FSA `FileSystemWritableFileStream.write()` ignores a typed-array view's
 *  `byteOffset`/`byteLength` and writes the WHOLE backing ArrayBuffer. An xfer.v2 chunk's payload is a VIEW
 *  past the 41-byte frame header (`decodeChunkFrame` → `buf.subarray(1 + idLen + 4)`), so on iOS the header
 *  leaked onto disk for every chunk — silently corrupting the file (+41 bytes/chunk; the SHA-256 gate passes
 *  because it hashes the correct in-memory view, not the bytes written). Handing write() a tight array makes
 *  the on-disk bytes exactly the chunk on every platform. Desktop Chromium honours the view, so a tight
 *  chunk is returned as-is (no copy). Pure → unit-testable. */
export function tightChunk(chunk: Uint8Array): Uint8Array {
  return chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength ? chunk : chunk.slice()
}

/** The in-RAM fallback — today's behavior, kept for browsers without OPFS/FSA and for tiny payloads. Pure
 *  (Blob is a standard global in both the browser and Node). */
export class MemSink implements ChunkSink {
  readonly kind = 'mem' as const
  private parts: Uint8Array[] = []
  private done = false
  constructor(private readonly mime: string) {}
  async write(chunk: Uint8Array): Promise<void> {
    if (this.done) throw new Error('chunk sink already finished')
    this.parts.push(chunk)
  }
  async finish(): Promise<Blob> {
    this.done = true
    const blob = new Blob(this.parts as BlobPart[], { type: this.mime || 'application/octet-stream' })
    this.parts = [] // the Blob owns the bytes now
    return blob
  }
  async abort(): Promise<void> {
    this.done = true
    this.parts = []
  }
}

const GB = 1024 * 1024 * 1024
const MB = 1024 * 1024

/** Per-sink hard ceiling (docs/large-transfer.md): FSA streams to the user's real disk (free-disk-bound — the
 *  desktop-unbounded download tier, with a high sanity ceiling so a typo/hostile xbegin can't ask for a
 *  petabyte), OPFS to a finite, evictable origin quota (incl. iOS — kept lower), MEM is still heap-bound. */
export const SINK_MAX_BYTES: Record<SinkKind, number> = {
  fsa: 50 * GB,
  opfs: 1 * GB,
  mem: 50 * MB,
}
/** The send-side boundary between today's read-whole in-RAM send and the lazy streaming send (= the in-RAM
 *  receive cap). Files at or below stay on the proven path. */
export const INRAM_MAX_BYTES = SINK_MAX_BYTES.mem

/** Where the SENDER routes a transfer of `size` bytes to one peer, given what that peer can do:
 *   inline   — ≤50MB, read-whole + send (today's path)
 *   stream   — 50MB..1GB, lazy slice → the peer's OPFS/in-RAM sink (Phase 1)
 *   download — >1GB, the PULL handshake → the peer streams to a chosen disk file (needs peerDownload)
 *   skip     — too big for what this peer supports (caller may use a legacy fallback for a non-xfer peer)
 *  Pure → unit-testable. */
export type SendRoute = 'inline' | 'stream' | 'download' | 'skip'
export function sendRouteFor(size: number, peer: { xfer: boolean; download: boolean }): SendRoute {
  if (!Number.isFinite(size) || size < 0) return 'skip'
  if (!peer.xfer) return 'skip'
  if (size <= INRAM_MAX_BYTES) return 'inline'
  if (size <= SINK_MAX_BYTES.opfs) return 'stream'
  if (peer.download && size <= SINK_MAX_BYTES.fsa) return 'download'
  return 'skip'
}

/** The absolute ceiling any sink could accept — the receive-side anti-DoS bound for `validateBegin`, so a
 *  hostile peer can't claim an absurd size. (The chosen sink's own tier is enforced too, below.) */
export const MAX_XFER_BYTES = SINK_MAX_BYTES.fsa

/** Pick the best available sink, best-first (FSA → OPFS → MEM). Pure — the caller passes detected caps. */
export function chooseSinkKind(caps: { fsa?: boolean; opfs?: boolean }): SinkKind {
  if (caps.fsa) return 'fsa'
  if (caps.opfs) return 'opfs'
  return 'mem'
}

/** Will a `size`-byte transfer fit a sink of `kind`? Bounded by the sink's tier AND, for disk sinks, the
 *  receiver's REAL free storage `(quota − usage) × factor` — so we refuse up front instead of half-writing
 *  then failing at 90%. Pure: the storage estimate is passed in (the browser module measures it). */
export function fitsTransfer(
  size: number,
  kind: SinkKind,
  est?: { quota?: number; usage?: number },
  factor = 0.8,
): boolean {
  if (!Number.isFinite(size) || size < 0 || size > SINK_MAX_BYTES[kind]) return false
  if (kind !== 'mem' && est && typeof est.quota === 'number' && est.quota > 0) {
    const free = est.quota - (est.usage || 0)
    if (size > free * factor) return false
  }
  return true
}

/** A soft threshold above which the UI warns "large — may take a few minutes; keep the tab open" (Phase 1
 *  has no resume, so a dropped transfer restarts). */
export const WARN_BYTES = 500 * MB

/**
 * The streamed counterpart to `Reassembler`: a SYNC `add()` (so it drops into the synchronous receive
 * handler unchanged) that ENQUEUES each chunk's (async) write to a `ChunkSink`, in order, on an internal
 * promise chain. The data channel is reliable + ordered, so chunks must arrive sequentially — a gap fails
 * the transfer (a streamed sink can't reorder). The sink is passed as a PROMISE so the handler can create
 * it asynchronously (storage probe / picker) without racing the first chunks — writes queue behind it.
 * Pure (DOM-free): the sink is injected, so this unit-tests with MemSink or a fake.
 */
export class DiskReassembler {
  private q: Promise<void> = Promise.resolve()
  private readonly sinkP: Promise<ChunkSink>
  private got = 0
  private nextI = 0
  private bytes = 0
  private failed = false
  /** Set once the sink resolves — lets the caller wire cleanup() of the disk temp on eviction. */
  sink: ChunkSink | null = null
  /** Epoch-ms of the last accepted chunk — the stall reaper reads it. */
  lastAt: number

  /**
   * `resume` reconstructs a partial transfer recovered from disk (cross-reload): `at` chunks (= `bytes`
   * already on the sink, e.g. the OPFS file's current length) are treated as ALREADY received, so the next
   * expected index is `at` and `complete`/`progress` count them. The injected sink MUST append (open the
   * existing file with keepExistingData), not truncate.
   */
  constructor(
    readonly begin: { n: number; size: number },
    sinkP: Promise<ChunkSink>,
    startedAt: number,
    resume?: { at: number; bytes: number },
  ) {
    this.lastAt = startedAt
    if (resume && resume.at > 0) {
      this.nextI = resume.at
      this.got = resume.at
      this.bytes = resume.bytes
    }
    this.sinkP = sinkP.then((s) => {
      this.sink = s
      return s
    })
    this.sinkP.catch(() => {
      this.failed = true // sink creation / fit check rejected → the transfer can't proceed
    })
  }

  /** Like Reassembler.add: validate order + bounds, enqueue the ordered async write. Returns false to drop
   *  a duplicate / out-of-order / over-size chunk (the caller then ignores it). */
  add(i: number, chunk: Uint8Array, atMs: number): boolean {
    if (this.failed || i !== this.nextI || this.bytes + chunk.length > this.begin.size) return false
    this.nextI++
    this.got++
    this.bytes += chunk.length
    this.lastAt = atMs
    this.q = this.q
      .then(() => this.sinkP)
      .then((s) => s.write(chunk))
      .catch(() => {
        this.failed = true // a disk write (or the sink) failed → mark; assembleBlob() will throw
      })
    return true
  }

  get complete(): boolean {
    return this.got === this.begin.n
  }
  get progress(): number {
    return this.begin.n ? this.got / this.begin.n : 1
  }
  /** Chunks received so far (= the next expected index, since the channel is ordered) — the resume point a
   *  receiver reports in `xresume {have}` so the sender re-streams from here. */
  get received(): number {
    return this.nextI
  }

  /** Await every queued write, then finalize to the disk-backed Blob. Throws if any write/sink failed. */
  async assembleBlob(): Promise<Blob> {
    await this.q
    if (this.failed) throw new Error('transfer failed')
    const s = await this.sinkP
    return s.finish()
  }

  /** Discard a partial transfer + free anything written (cancel / stall). */
  async abort(): Promise<void> {
    this.failed = true
    try {
      const s = await this.sinkP
      await s.abort()
    } catch {
      /* the sink never opened — nothing to free */
    }
  }
}
