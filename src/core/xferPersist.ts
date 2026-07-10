// Cross-reload resume bookkeeping (docs/large-transfer.md). A disk-tier (OPFS) receive writes its bytes to a
// file that SURVIVES a reload; this persists the small METADATA needed to find + continue that file after the
// tab reopens (the sink's file name, the sender + transfer ids, the begin header). Pure: storage is injected
// (a `KV`), so it unit-tests with a Map and runs on `localStorage` in the browser. The bytes live in OPFS,
// never here — only a tiny JSON record per in-flight transfer.

/** The minimal key/value surface we need (localStorage-shaped). */
export interface KV {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
  key(i: number): string | null
  readonly length: number
}

/** What we need on reopen to reconstruct + continue an OPFS receive. `sinkName` is the OPFS file to reopen
 *  (append mode); `n`/`size` bound it; `from` is the sender to ask for a resume (still valid if it stayed). */
export interface PartialReceive {
  xid: string
  room: string
  from: string
  fromName: string
  sinkName: string
  kind: 'image' | 'file'
  mime?: string
  name?: string
  size: number
  n: number
  dm: boolean
}

const PREFIX = 'kbz.xfer.v1.'
const keyFor = (room: string, xid: string): string => `${PREFIX}${encodeURIComponent(room)}.${xid}`

/** Record an in-flight disk receive so a reload can find it. Best-effort (storage may be full/blocked). */
export function savePartial(kv: KV, rec: PartialReceive): void {
  try {
    kv.setItem(keyFor(rec.room, rec.xid), JSON.stringify(rec))
  } catch {
    /* storage full / disabled — resume just won't be available, not an error */
  }
}

/** Forget a transfer (completed, failed, or declined). */
export function deletePartial(kv: KV, room: string, xid: string): void {
  try {
    kv.removeItem(keyFor(room, xid))
  } catch {
    /* ignore */
  }
}

const isPartial = (v: unknown): v is PartialReceive => {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    typeof r.xid === 'string' &&
    typeof r.room === 'string' &&
    typeof r.from === 'string' &&
    typeof r.sinkName === 'string' &&
    (r.kind === 'image' || r.kind === 'file') &&
    typeof r.size === 'number' &&
    typeof r.n === 'number'
  )
}

/** Every persisted partial-receive for `room` (to restore on reopen). Skips/parses tolerantly. */
export function loadPartials(kv: KV, room: string): PartialReceive[] {
  const want = `${PREFIX}${encodeURIComponent(room)}.`
  const out: PartialReceive[] = []
  for (let i = 0; i < kv.length; i++) {
    const k = kv.key(i)
    if (!k || !k.startsWith(want)) continue
    try {
      const rec = JSON.parse(kv.getItem(k) || 'null')
      if (isPartial(rec)) out.push(rec)
    } catch {
      /* a corrupt record — ignore it */
    }
  }
  return out
}

/** Find a retained outgoing transfer by its xid across ANY peer key (`${peerId}/${xid}`) — a reloaded
 *  receiver returns with a NEW peer id, so the sender matches a resume by the stable xid, not the peer.
 *  Returns the map key (so the caller can re-key it to the requesting peer) or null. Pure. */
export function findSendKeyByXid(keys: Iterable<string>, xid: string): string | null {
  const suffix = `/${xid}`
  for (const k of keys) if (k.endsWith(suffix)) return k
  return null
}
