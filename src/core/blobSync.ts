// Blob fetch-by-hash — the CONTROL plane for content-addressed bytes (docs/unified-room-sync.md, phase 1).
//
// The unified ledger carries media as a small ref { hash, mime, size, name }. A peer that holds a ref but not
// its bytes fetches them by content hash from whoever has them:
//
//   • want (broadcast) — "I need blob H."
//   • have (direct)    — a holder replies "I have H."
//   • get  (direct)    — the requester picks the FIRST replier and asks it to send (so N holders don't all send).
//   • bytes            — the holder streams H over the DATA plane (the existing chunked xfer, wired in phase 3);
//                        the requester content-verifies (blobHash(bytes)===H — a holder can't serve wrong bytes)
//                        and stores it.
//
// Transport-injected (a `BlobWire`) exactly like LedgerSync, so the protocol is unit-tested with an in-memory
// bus (blobSync.test.ts) and the engine adapter just maps it onto the data channel + the xfer. Dormant until
// wired. Bytes are content-addressed ⇒ self-verifying, so no signing is needed on this lane.

import { BlobStore, blobHash } from './blobStore'

/** The reserved ContentMsg kind these control messages ride (demuxed in useCall; opaque to the app). Distinct
 *  from LEDGER_KIND ('ledger'). */
export const BLOB_KIND = 'blob'

export type BlobMsg =
  | { v: 1; op: 'want'; hash: string } // broadcast: I need this blob
  | { v: 1; op: 'have'; hash: string } // reply: I hold it
  | { v: 1; op: 'get'; hash: string } // direct: please send it

/** The transport seam. Control messages ride `broadcast`/`send`; the BYTES ride `sendBytes`/`onBytes` (wired to
 *  the chunked xfer in phase 3 — resumable, backpressured, integrity-checked). */
export interface BlobWire {
  broadcast(msg: BlobMsg): void
  send(to: string, msg: BlobMsg): void
  sendBytes(to: string, hash: string, bytes: Uint8Array): void
  onMessage(cb: (from: string, msg: BlobMsg) => void): () => void
  onBytes(cb: (from: string, hash: string, bytes: Uint8Array) => void): () => void
}

interface Pending {
  resolvers: Array<(bytes: Uint8Array | null) => void>
  picked: boolean // a `get` was already sent to one holder → ignore later `have`s (no redundant sends)
  timer?: ReturnType<typeof setInterval> // re-broadcasts `want` until answered, then watches for a STALLED stream
  lastAt: number // last progress: the want start, the pick, or a chunk landing (noteProgress) — for stall detection
}

/** Fetch content-addressed bytes over a wire, backed by a BlobStore. `want(hash)` resolves with the bytes —
 *  from the local store, or fetched from a holding peer. Concurrent wants for the same hash coalesce to one
 *  broadcast + one transfer. */
export class BlobSync {
  private store: BlobStore
  private wire: BlobWire
  private offMsg: () => void
  private offBytes: () => void
  private pending = new Map<string, Pending>()
  private now: () => number

  constructor(store: BlobStore, wire: BlobWire, opts: { now?: () => number } = {}) {
    this.store = store
    this.wire = wire
    this.now = opts.now ?? (() => Date.now())
    this.offMsg = wire.onMessage((from, m) => void this.onMsg(from, m))
    this.offBytes = wire.onBytes((from, hash, bytes) => void this.onBytes(from, hash, bytes))
  }

  /** Ensure the bytes for `hash` are local: return them from the store, else broadcast a want and resolve when a
   *  holder streams them. Resolves null on timeout (nobody answered) or close. */
  async want(hash: string, opts: { timeoutMs?: number; retryMs?: number; stallMs?: number } = {}): Promise<Uint8Array | null> {
    const local = await this.store.get(hash)
    if (local) return local
    return new Promise<Uint8Array | null>((resolve) => {
      let p = this.pending.get(hash)
      const fresh = !p
      if (!p) {
        p = { resolvers: [], picked: false, lastAt: this.now() }
        this.pending.set(hash, p)
      }
      p.resolvers.push(resolve)
      if (fresh) {
        const entry = p
        const stallMs = opts.stallMs ?? 12000
        const bcast = () => this.wire.broadcast({ v: 1, op: 'want', hash })
        bcast()
        entry.timer = setInterval(() => {
          if (this.pending.get(hash) !== entry) return
          if (!entry.picked) {
            // Not yet answered — keep asking. An early want can be lost before a peer's data channel is open (a
            // fresh joiner fetching a ref the instant it arrives); a retry heals that without a full timeout.
            bcast()
          } else if (this.now() - entry.lastAt > stallMs) {
            // Picked a holder but its byte STREAM stalled (no chunk progress for stallMs — a 4G/relay blip dropped
            // the data channel and the holder's send bailed; the blob lane has no resume). Re-drive: un-pick and
            // re-want so a holder re-answers and RE-STREAMS from the start. A healthy (even slow) transfer keeps
            // lastAt fresh via noteProgress, so this fires ONLY on a genuine stall — not a slow-but-alive one.
            entry.picked = false
            entry.lastAt = this.now()
            bcast()
          }
        }, opts.retryMs ?? 1500)
        if (opts.timeoutMs) {
          setTimeout(() => {
            if (this.pending.get(hash) === entry) {
              this.clearPending(hash)
              for (const r of entry.resolvers) r(null)
            }
          }, opts.timeoutMs)
        }
      }
    })
  }

  /** The transport adapter reports byte-stream progress (a chunk of `hash` landed), keeping the stall clock fresh
   *  so the re-drive above fires only on a GENUINE stall, not a healthy-but-slow transfer. No-op if not pending. */
  noteProgress(hash: string): void {
    const p = this.pending.get(hash)
    if (p) p.lastAt = this.now()
  }

  private clearPending(hash: string): void {
    const p = this.pending.get(hash)
    if (p?.timer) clearInterval(p.timer)
    this.pending.delete(hash)
  }

  private async onMsg(from: string, m: BlobMsg): Promise<void> {
    if (!m || m.v !== 1) return
    if (m.op === 'want') {
      if (await this.store.has(m.hash)) this.wire.send(from, { v: 1, op: 'have', hash: m.hash })
      return
    }
    if (m.op === 'have') {
      const p = this.pending.get(m.hash)
      if (p && !p.picked) {
        p.picked = true // pick the FIRST holder to reply — later `have`s are ignored, so no duplicate transfers
        p.lastAt = this.now() // start the stall clock at the pick; the timer now watches the STREAM (not a missing holder)
        this.wire.send(from, { v: 1, op: 'get', hash: m.hash })
      }
      return
    }
    if (m.op === 'get') {
      const bytes = await this.store.get(m.hash)
      if (bytes) this.wire.sendBytes(from, m.hash, bytes)
      return
    }
  }

  private async onBytes(_from: string, hash: string, bytes: Uint8Array): Promise<void> {
    if (blobHash(bytes) !== hash) return // content-addressed: a holder cannot serve wrong bytes for a hash
    await this.store.put(bytes)
    const p = this.pending.get(hash)
    if (p) {
      this.clearPending(hash)
      for (const r of p.resolvers) r(bytes)
    }
  }

  close(): void {
    this.offMsg()
    this.offBytes()
    for (const p of this.pending.values()) {
      if (p.timer) clearInterval(p.timer)
      for (const r of p.resolvers) r(null)
    }
    this.pending.clear()
  }
}
