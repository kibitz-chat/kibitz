// Content-addressed blob store (docs/unified-room-sync.md, phase 0).
//
// Bytes live ONCE under their content hash; a chat/ledger entry references that hash instead of inlining the
// bytes. This is what lets the unified sync carry big media as a small ref and fetch the bytes on demand (the
// ~kbz.blob layer, phase 1) — with no 8MB/30MB replay caps, and automatic dedup (the same image posted twice,
// or re-shared by a second peer, is one blob).
//
// PURE core (blobHash + planEviction) is unit-tested in isolation; the byte backend is a pluggable async
// `BlobKV` (in-memory here for tests + a mem fallback; the OPFS backend lands with the wiring, phase 1, and is
// validated in the browser). Async KV so an OPFS/IndexedDB impl drops in unchanged — mirrors LedgerKV.

import { sha256Hex } from './sha256'

/** The content address for bytes — sha256 hex. Matches the chunked-xfer integrity hash (same algorithm), so a
 *  ref computed on the send side, the receive side, or from a restored ledger all agree. Synchronous (the
 *  pure-JS sha256), so it composes into the synchronous serialize path. */
export function blobHash(bytes: Uint8Array): string {
  return sha256Hex(bytes)
}

/** A stored blob's bookkeeping — the hash, its byte size, and `at` (store time, the GC/eviction order key). */
export interface BlobMeta {
  hash: string
  size: number
  at: number
}

/** Pluggable byte backend. Async so an OPFS/IndexedDB impl drops in unchanged (mirrors roomLedgerStore's
 *  LedgerKV). `at` is supplied by the caller (an injected clock) so the store is deterministic in tests. */
export interface BlobKV {
  get(hash: string): Promise<Uint8Array | null>
  put(hash: string, bytes: Uint8Array, at: number): Promise<void>
  has(hash: string): Promise<boolean>
  delete(hash: string): Promise<void>
  list(): Promise<BlobMeta[]>
}

/** In-memory BlobKV — the test backend AND the fallback when no OPFS is available. Bytes are copied on put so a
 *  caller mutating its buffer can't corrupt the store. */
export function memBlobKV(): BlobKV {
  const m = new Map<string, { bytes: Uint8Array; at: number }>()
  return {
    async get(hash) {
      const e = m.get(hash)
      return e ? e.bytes : null
    },
    async put(hash, bytes, at) {
      if (!m.has(hash)) m.set(hash, { bytes: bytes.slice(), at })
    },
    async has(hash) {
      return m.has(hash)
    },
    async delete(hash) {
      m.delete(hash)
    },
    async list() {
      return [...m.entries()].map(([hash, e]) => ({ hash, size: e.bytes.length, at: e.at }))
    },
  }
}

/**
 * PURE: which blobs to evict so the store fits `maxBytes` — oldest-first (by `at`, tie-broken by hash for
 * determinism), NEVER evicting a hash in `keep` (a blob still referenced by the live ledger must stay, even if
 * that leaves the store over cap — correctness beats the quota). Returns the hashes to delete, oldest-first.
 */
export function planEviction(entries: readonly BlobMeta[], maxBytes: number, keep?: ReadonlySet<string>): string[] {
  let total = 0
  for (const e of entries) total += e.size
  if (total <= maxBytes) return []
  const evictable = entries
    .filter((e) => !keep || !keep.has(e.hash))
    .sort((a, b) => a.at - b.at || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
  const out: string[] = []
  for (const e of evictable) {
    if (total <= maxBytes) break
    out.push(e.hash)
    total -= e.size
  }
  return out
}

/** Default quota — a generous local cache; the real ceiling is disk/quota, and a blob still referenced by the
 *  ledger is never evicted (see planEviction `keep`). */
export const DEFAULT_BLOB_MAX_BYTES = 256 * 1024 * 1024

/** A content-addressed byte store over a BlobKV: dedup on put (same bytes → one blob), fetch by hash, and
 *  quota-GC that spares live refs. The wiring layer (phase 1) hands it an OPFS-backed KV + the ledger's live
 *  ref set. */
export class BlobStore {
  private kv: BlobKV
  private maxBytes: number
  private now: () => number

  constructor(kv: BlobKV, opts: { maxBytes?: number; now?: () => number } = {}) {
    this.kv = kv
    this.maxBytes = opts.maxBytes ?? DEFAULT_BLOB_MAX_BYTES
    this.now = opts.now ?? (() => Date.now())
  }

  /** Store bytes (idempotent — a hash already present is left as-is) and return the content hash to reference. */
  async put(bytes: Uint8Array): Promise<string> {
    const hash = blobHash(bytes)
    if (!(await this.kv.has(hash))) await this.kv.put(hash, bytes, this.now())
    return hash
  }

  has(hash: string): Promise<boolean> {
    return this.kv.has(hash)
  }

  get(hash: string): Promise<Uint8Array | null> {
    return this.kv.get(hash)
  }

  /** Evict oldest blobs until under the quota, never dropping one still referenced by the live ledger (`keep`).
   *  Returns the evicted hashes (for logging — no silent truncation). */
  async gc(keep?: ReadonlySet<string>): Promise<string[]> {
    const evict = planEviction(await this.kv.list(), this.maxBytes, keep)
    for (const h of evict) await this.kv.delete(h)
    return evict
  }
}
