import { describe, expect, it } from 'vitest'
import { RoomLedger } from './roomLedger'
import { type LedgerMsg, type LedgerWire, LedgerSync } from './roomLedgerSync'

const FAR = 9_999_999_999_999

// A synchronous in-memory mesh: broadcast reaches every OTHER connected peer, JSON-cloned to simulate the
// wire. Counts deliveries so we can assert there's no echo storm.
function makeBus() {
  const peers = new Map<string, (from: string, msg: LedgerMsg) => void>()
  let delivered = 0
  return {
    delivered: () => delivered,
    connect(id: string): LedgerWire {
      return {
        broadcast(msg) {
          for (const [pid, cb] of peers)
            if (pid !== id) {
              delivered++
              cb(id, JSON.parse(JSON.stringify(msg)))
            }
        },
        onMessage(cb) {
          peers.set(id, cb)
          return () => peers.delete(id)
        },
      }
    },
  }
}

// Spin up a peer (ledger + sync) on a bus.
const peer = (bus: ReturnType<typeof makeBus>, id: string) => {
  const ledger = new RoomLedger()
  const sync = new LedgerSync(ledger, bus.connect(id))
  return { id, ledger, sync }
}

describe('LedgerSync — live convergence', () => {
  it('a local attestation propagates to peers immediately (no explicit request)', () => {
    const bus = makeBus()
    const a = peer(bus, 'a')
    const b = peer(bus, 'b')
    a.ledger.attest('agentSeen.x', true, { author: 'a', expireAt: FAR })
    expect(b.ledger.has('agentSeen.x', 0)).toBe(true) // arrived via the pushed `update`
  })

  it('a late joiner pulls existing state on requestSync (the self-heal / browser-switch path)', () => {
    const bus = makeBus()
    const a = peer(bus, 'a')
    const b = peer(bus, 'b')
    a.ledger.attest('agentSeen.x', true, { author: 'a', expireAt: FAR })
    b.ledger.attest('agentSeen.y', true, { author: 'b', expireAt: FAR })
    // Carol joins fresh and asks — both peers reply with their snapshots; she converges to the union.
    const c = peer(bus, 'c')
    expect(c.ledger.has('agentSeen.x', 0)).toBe(false)
    c.sync.requestSync()
    expect(c.ledger.has('agentSeen.x', 0)).toBe(true)
    expect(c.ledger.has('agentSeen.y', 0)).toBe(true)
  })

  it('concurrent attestations on the same key converge (OR-set union)', () => {
    const bus = makeBus()
    const a = peer(bus, 'a')
    const b = peer(bus, 'b')
    a.ledger.attest('seen', true, { author: 'a', expireAt: FAR, id: 'ia' })
    b.ledger.attest('seen', true, { author: 'b', expireAt: FAR, id: 'ib' })
    for (const p of [a, b]) {
      const ids = p.ledger.attestations('seen', 0).map((x) => x.id).sort()
      expect(ids).toEqual(['ia', 'ib'])
    }
  })

  it('an owned register converges to the highest seq across peers', () => {
    const bus = makeBus()
    const a = peer(bus, 'a')
    const b = peer(bus, 'b')
    a.ledger.setOwned('cfg', { v: 1 }, { author: 'host', seq: 1, expireAt: FAR })
    b.ledger.setOwned('cfg', { v: 2 }, { author: 'host', seq: 2, expireAt: FAR })
    expect(a.ledger.getOwned('cfg', 0)).toEqual({ v: 2 })
    expect(b.ledger.getOwned('cfg', 0)).toEqual({ v: 2 })
  })

  it('a retract ("end the agent") propagates and clears the flag everywhere', () => {
    const bus = makeBus()
    const a = peer(bus, 'a')
    const b = peer(bus, 'b')
    const id = a.ledger.attest('agentSeen.x', true, { author: 'a', expireAt: FAR })
    expect(b.ledger.has('agentSeen.x', 0)).toBe(true)
    a.ledger.retract('agentSeen.x', [id])
    expect(a.ledger.has('agentSeen.x', 0)).toBe(false)
    expect(b.ledger.has('agentSeen.x', 0)).toBe(false)
  })

  it('no echo storm: one local write = exactly one broadcast, merges are not re-broadcast', () => {
    const bus = makeBus()
    peer(bus, 'a')
    peer(bus, 'b')
    const c = peer(bus, 'c') // 3-peer mesh
    const before = bus.delivered()
    c.ledger.attest('seen', true, { author: 'c', expireAt: FAR })
    // One broadcast from c → delivered to the 2 other peers, who merge silently (no re-broadcast).
    expect(bus.delivered() - before).toBe(2)
  })

  it('three peers converge to the same state from concurrent writes + a joiner', () => {
    const bus = makeBus()
    const a = peer(bus, 'a')
    const b = peer(bus, 'b')
    a.ledger.attest('seen', true, { author: 'a', expireAt: FAR, id: 'ia' })
    b.ledger.attest('seen', true, { author: 'b', expireAt: FAR, id: 'ib' })
    b.ledger.setOwned('host', 'B', { author: 'host', seq: 2, expireAt: FAR })
    const c = peer(bus, 'c')
    c.sync.requestSync()
    c.ledger.attest('seen', true, { author: 'c', expireAt: FAR, id: 'ic' })
    for (const p of [a, b, c]) {
      expect(p.ledger.attestations('seen', 0).map((x) => x.id).sort()).toEqual(['ia', 'ib', 'ic'])
      expect(p.ledger.getOwned('host', 0)).toBe('B')
    }
  })
})
