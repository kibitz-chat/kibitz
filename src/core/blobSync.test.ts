import { describe, it, expect } from 'vitest'
import { BlobSync, type BlobWire, type BlobMsg } from './blobSync'
import { BlobStore, memBlobKV, blobHash } from './blobStore'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null)

// An in-memory mesh bus: broadcast → all others; send/sendBytes → one peer. Counts control ops so we can
// assert "only one holder streams".
function makeBus() {
  const peers = new Map<string, { msg?: (from: string, m: BlobMsg) => void; bytes?: (from: string, hash: string, b: Uint8Array) => void }>()
  const counts = { wantBroadcasts: 0, get: 0, byteSends: 0 }
  const wireFor = (id: string): BlobWire => ({
    broadcast(msg) {
      if (msg.op === 'want') counts.wantBroadcasts++
      for (const [pid, p] of peers) if (pid !== id) p.msg?.(id, { ...msg })
    },
    send(to, msg) {
      if (msg.op === 'get') counts.get++
      peers.get(to)?.msg?.(id, { ...msg })
    },
    sendBytes(to, hash, bytes) {
      counts.byteSends++
      peers.get(to)?.bytes?.(id, hash, bytes.slice())
    },
    onMessage(cb) {
      peers.get(id)!.msg = cb
      return () => {
        const p = peers.get(id)
        if (p) p.msg = undefined
      }
    },
    onBytes(cb) {
      peers.get(id)!.bytes = cb
      return () => {
        const p = peers.get(id)
        if (p) p.bytes = undefined
      }
    },
  })
  return {
    peer(id: string) {
      peers.set(id, {})
      return wireFor(id)
    },
    injectBytes(to: string, hash: string, bytes: Uint8Array) {
      peers.get(to)?.bytes?.('rogue', hash, bytes)
    },
    counts,
  }
}

const store = () => new BlobStore(memBlobKV(), { now: () => 1 })

describe('BlobSync — fetch content-addressed bytes over a mesh', () => {
  it('a locally-held blob resolves immediately, with no want broadcast', async () => {
    const bus = makeBus()
    const s = store()
    const hash = await s.put(enc('local blob'))
    const a = new BlobSync(s, bus.peer('A'))
    expect(dec(await a.want(hash))).toBe('local blob')
    expect(bus.counts.wantBroadcasts).toBe(0)
    a.close()
  })

  it('fetches a blob a peer holds (want → have → get → bytes) and stores it', async () => {
    const bus = makeBus()
    const aStore = store()
    const bStore = store()
    const hash = await bStore.put(enc('the shared file bytes'))
    const a = new BlobSync(aStore, bus.peer('A'))
    new BlobSync(bStore, bus.peer('B'))
    const got = await a.want(hash, { timeoutMs: 500 })
    expect(dec(got)).toBe('the shared file bytes')
    expect(await aStore.has(hash)).toBe(true) // now cached locally
    a.close()
  })

  it('with two holders, only ONE is asked to send (no duplicate transfers)', async () => {
    const bus = makeBus()
    const payload = enc('a blob two peers hold')
    const bStore = store()
    const cStore = store()
    const hash = await bStore.put(payload)
    await cStore.put(payload)
    const a = new BlobSync(store(), bus.peer('A'))
    new BlobSync(bStore, bus.peer('B'))
    new BlobSync(cStore, bus.peer('C'))
    expect(dec(await a.want(hash, { timeoutMs: 500 }))).toBe('a blob two peers hold')
    expect(bus.counts.get).toBe(1) // picked the first holder to reply
    expect(bus.counts.byteSends).toBe(1)
    a.close()
  })

  it('resolves null when nobody has the blob (timeout)', async () => {
    const bus = makeBus()
    const a = new BlobSync(store(), bus.peer('A'))
    new BlobSync(store(), bus.peer('B')) // B holds nothing
    expect(await a.want(blobHash(enc('missing')), { timeoutMs: 30 })).toBeNull()
    a.close()
  })

  it('rejects wrong bytes for a hash (content-addressed integrity) — stays unresolved', async () => {
    const bus = makeBus()
    const aStore = store()
    const a = new BlobSync(aStore, bus.peer('A'))
    const wantHash = blobHash(enc('the real bytes'))
    const p = a.want(wantHash, { timeoutMs: 40 })
    bus.injectBytes('A', wantHash, enc('EVIL substituted bytes')) // hash mismatch → must be rejected
    expect(await p).toBeNull()
    expect(await aStore.has(wantHash)).toBe(false)
    a.close()
  })

  it('re-broadcasts want until a LATE holder appears (survives a not-yet-open peer channel)', async () => {
    const bus = makeBus()
    const a = new BlobSync(store(), bus.peer('A'))
    const hash = blobHash(enc('late blob'))
    const p = a.want(hash, { timeoutMs: 1000, retryMs: 30 }) // first want reaches nobody
    await new Promise((r) => setTimeout(r, 60)) // ...then a holder shows up
    const bStore = store()
    await bStore.put(enc('late blob'))
    new BlobSync(bStore, bus.peer('B'))
    expect(dec(await p)).toBe('late blob') // a retry re-broadcast reached B
    a.close()
  })

  it('re-drives a STALLED pick: a holder that stops streaming triggers a re-want that recovers', async () => {
    // A wants a blob. A holder answers `have` → A `get`s and PICKS it, but its byte stream never lands (a 4G/relay
    // blip). After stallMs with no progress the fetch un-picks and re-wants; the holder re-answers and this time
    // the bytes arrive. Drives the real retry interval with an injected clock so the stall is deterministic.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    let clock = 0
    const payload = enc('bytes that only land on the second try')
    const hash = blobHash(payload)
    let msgCb: ((from: string, m: BlobMsg) => void) | undefined
    let bytesCb: ((from: string, hash: string, b: Uint8Array) => void) | undefined
    let gets = 0
    const wire: BlobWire = {
      broadcast: (m) => {
        if (m.op === 'want') msgCb?.('B', { v: 1, op: 'have', hash }) // a holder always answers a want
      },
      send: (_to, m) => {
        if (m.op === 'get') gets++
      },
      sendBytes: () => {},
      onMessage: (cb) => {
        msgCb = cb
        return () => {}
      },
      onBytes: (cb) => {
        bytesCb = cb
        return () => {}
      },
    }
    const a = new BlobSync(store(), wire, { now: () => clock })
    const p = a.want(hash, { timeoutMs: 100000, retryMs: 5, stallMs: 50 })
    await sleep(15)
    expect(gets).toBe(1) // want → have → get: picked a holder, asked once
    clock = 100 // ...no bytes arrived; jump past stallMs so the next retry tick sees a stall
    await sleep(25)
    expect(gets).toBe(2) // re-driven: un-picked + re-wanted → a holder re-answered and was asked again
    bytesCb?.('B', hash, payload) // the re-driven stream lands
    expect(dec(await p)).toBe('bytes that only land on the second try')
    a.close()
  })

  it('does NOT re-drive a healthy-but-slow transfer (noteProgress keeps the stall clock fresh)', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    let clock = 0
    const hash = blobHash(enc('a slow but alive stream'))
    let gets = 0
    let msgCb: ((from: string, m: BlobMsg) => void) | undefined
    const wire: BlobWire = {
      broadcast: (m) => {
        if (m.op === 'want') msgCb?.('B', { v: 1, op: 'have', hash })
      },
      send: (_to, m) => {
        if (m.op === 'get') gets++
      },
      sendBytes: () => {},
      onMessage: (cb) => {
        msgCb = cb
        return () => {}
      },
      onBytes: () => () => {},
    }
    const a = new BlobSync(store(), wire, { now: () => clock })
    a.want(hash, { timeoutMs: 100000, retryMs: 5, stallMs: 50 })
    await sleep(15)
    expect(gets).toBe(1)
    // Advance well past stallMs, but report chunk progress each step (< stallMs apart) → never counts as a stall.
    for (let t = 20; t <= 240; t += 20) {
      clock = t
      a.noteProgress(hash)
      await sleep(6)
    }
    expect(gets).toBe(1) // still ONE get — a live (if slow) transfer is not re-driven
    a.close()
  })

  it('coalesces concurrent wants for the same hash to one broadcast + one transfer', async () => {
    const bus = makeBus()
    const bStore = store()
    const hash = await bStore.put(enc('coalesced'))
    const a = new BlobSync(store(), bus.peer('A'))
    new BlobSync(bStore, bus.peer('B'))
    const [g1, g2] = await Promise.all([a.want(hash, { timeoutMs: 500 }), a.want(hash, { timeoutMs: 500 })])
    expect(dec(g1)).toBe('coalesced')
    expect(dec(g2)).toBe('coalesced')
    expect(bus.counts.wantBroadcasts).toBe(1)
    expect(bus.counts.byteSends).toBe(1)
    a.close()
  })
})
