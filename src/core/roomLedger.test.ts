import { describe, expect, it } from 'vitest'
import {
  type AttestedEntry,
  type LedgerState,
  type OwnedEntry,
  RoomLedger,
  gcEntry,
  gcLedger,
  liveAttestations,
  mergeAttested,
  mergeLedger,
  mergeOwned,
} from './roomLedger'

const FAR = 9_999_999_999_999 // an expireAt far in the future
const owned = (value: unknown, author: string, seq: number, expireAt = FAR): OwnedEntry => ({ kind: 'owned', value, author, seq, expireAt })
const att = (id: string, author: string, value: unknown, expireAt = FAR) => ({ id, author, value, expireAt })
const attested = (adds: ReturnType<typeof att>[], removes: string[] = []): AttestedEntry => ({ kind: 'attested', adds, removes })
const J = (x: unknown) => JSON.stringify(x)

// Canonicalize so set-union order doesn't make equal ledgers compare unequal.
const norm = (s: LedgerState): LedgerState => {
  const out: LedgerState = {}
  for (const k of Object.keys(s).sort()) {
    const e = s[k]
    out[k] =
      e.kind === 'attested'
        ? { kind: 'attested', adds: [...e.adds].sort((a, b) => a.id.localeCompare(b.id)), removes: [...e.removes].sort() }
        : e
  }
  return out
}
const sameLedger = (a: LedgerState, b: LedgerState) => expect(J(norm(a))).toEqual(J(norm(b)))

describe('mergeOwned (LWW register)', () => {
  it('higher seq wins', () => {
    expect(mergeOwned(owned('a', 'h', 1), owned('b', 'h', 2)).value).toBe('b')
    expect(mergeOwned(owned('b', 'h', 2), owned('a', 'h', 1)).value).toBe('b')
  })
  it('ties break by author id, deterministically (commutative)', () => {
    expect(mergeOwned(owned('x', 'a', 5), owned('y', 'b', 5)).value).toBe('y') // 'b' >= 'a'
    expect(mergeOwned(owned('y', 'b', 5), owned('x', 'a', 5)).value).toBe('y')
  })
})

describe('mergeAttested (OR-set)', () => {
  it('unions adds (by id) and retracted ids', () => {
    const a = attested([att('1', 'a', true)], ['9'])
    const b = attested([att('1', 'a', true), att('2', 'b', true)], ['8'])
    const m = mergeAttested(a, b)
    expect(m.adds.map((x) => x.id).sort()).toEqual(['1', '2'])
    expect(m.removes.sort()).toEqual(['8', '9'])
  })
  it('liveAttestations excludes retracted and expired', () => {
    const e = attested([att('1', 'a', true), att('2', 'b', true), att('3', 'c', true, 100)], ['2'])
    const live = liveAttestations(e, 500) // now=500 → id 3 expired (100), id 2 retracted
    expect(live.map((x) => x.id)).toEqual(['1'])
  })
})

describe('CRDT laws on mergeLedger', () => {
  const A: LedgerState = { host: owned('cfg1', 'host', 3), seen: attested([att('1', 'a', true)], []) }
  const B: LedgerState = { host: owned('cfg2', 'host', 5), seen: attested([att('2', 'b', true)], ['1']) }
  const C: LedgerState = { seen: attested([att('3', 'c', true)], []), poll: owned(42, 'host', 1) }

  it('idempotent: merge(a, a) == a', () => sameLedger(mergeLedger(A, A), A))
  it('commutative: merge(a, b) == merge(b, a)', () => sameLedger(mergeLedger(A, B), mergeLedger(B, A)))
  it('associative: merge(merge(a,b),c) == merge(a,merge(b,c))', () => {
    sameLedger(mergeLedger(mergeLedger(A, B), C), mergeLedger(A, mergeLedger(B, C)))
  })
  it('converges to the same state from any order (3 replicas, 6 orderings)', () => {
    const states = [A, B, C]
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]
    const results = orders.map((o) => o.reduce((acc, i) => mergeLedger(acc, states[i]), {} as LedgerState))
    for (const r of results) sameLedger(r, results[0])
  })
})

describe('gc — expiry without resurrection', () => {
  it('drops expired owned registers', () => {
    expect(gcEntry(owned('x', 'h', 1, 100), 500)).toBeNull()
    expect(gcEntry(owned('x', 'h', 1, 1000), 500)).not.toBeNull()
  })
  it('drops an expired add AND its now-orphaned tombstone (no resurrection)', () => {
    const e = attested([att('1', 'a', true, 100), att('2', 'b', true, FAR)], ['1'])
    const g = gcEntry(e, 500) as AttestedEntry
    expect(g.adds.map((x) => x.id)).toEqual(['2']) // expired add 1 gone
    expect(g.removes).toEqual([]) // its tombstone dropped (nothing to suppress)
  })
  it('keeps a tombstone while its (still-live) add is present', () => {
    const e = attested([att('1', 'a', true, FAR)], ['1'])
    const g = gcEntry(e, 500) as AttestedEntry
    expect(g.adds.map((x) => x.id)).toEqual(['1'])
    expect(g.removes).toEqual(['1']) // suppression preserved → stays retracted
    expect(liveAttestations(g, 500)).toEqual([]) // and it IS suppressed
  })
  it('gcLedger drops keys that became empty', () => {
    const s: LedgerState = { gone: attested([att('1', 'a', true, 100)]), kept: owned('v', 'h', 1, FAR) }
    expect(Object.keys(gcLedger(s, 500))).toEqual(['kept'])
  })
})

describe('RoomLedger — the agent "resumable?" hint (worked example)', () => {
  it('two participants attest agentSeen → has() true; merges across peers', () => {
    const alice = new RoomLedger()
    const bob = new RoomLedger()
    alice.attest('agentSeen.painter', true, { author: 'alice', expireAt: FAR })
    bob.attest('agentSeen.painter', true, { author: 'bob', expireAt: FAR })
    expect(alice.has('agentSeen.painter', 0)).toBe(true)
    // A fresh joiner (carol) re-syncs from a peer that still has it (the self-healing property).
    const carol = new RoomLedger()
    expect(carol.has('agentSeen.painter', 0)).toBe(false)
    carol.merge(alice.snapshot())
    expect(carol.has('agentSeen.painter', 0)).toBe(true)
  })

  it('"end the agent" retracts observed attestations → has() false', () => {
    const led = new RoomLedger()
    const id1 = led.attest('agentSeen.painter', true, { author: 'alice', expireAt: FAR })
    const id2 = led.attest('agentSeen.painter', true, { author: 'bob', expireAt: FAR })
    expect(led.has('agentSeen.painter', 0)).toBe(true)
    led.retract('agentSeen.painter', [id1, id2])
    expect(led.has('agentSeen.painter', 0)).toBe(false)
  })

  it('the flag expires by TTL', () => {
    const led = new RoomLedger()
    led.attest('agentSeen.painter', true, { author: 'alice', expireAt: 1000 })
    expect(led.has('agentSeen.painter', 500)).toBe(true)
    expect(led.has('agentSeen.painter', 2000)).toBe(false) // past TTL
  })

  it('merge() reports changed keys and emits, and is idempotent on re-merge', () => {
    const a = new RoomLedger()
    a.attest('seen', true, { author: 'a', expireAt: FAR, id: 'x' })
    const b = new RoomLedger()
    const changed: string[] = []
    b.on((k) => changed.push(k))
    expect(b.merge(a.snapshot())).toEqual(['seen'])
    expect(changed).toEqual(['seen'])
    expect(b.merge(a.snapshot())).toEqual([]) // re-merging the same delta is a no-op (idempotent)
  })

  it('owned key is single-writer LWW (host config)', () => {
    const led = new RoomLedger()
    led.setOwned('cfg', { theme: 'a' }, { author: 'host', seq: 1, expireAt: FAR })
    led.setOwned('cfg', { theme: 'b' }, { author: 'host', seq: 2, expireAt: FAR })
    expect(led.getOwned('cfg', 0)).toEqual({ theme: 'b' })
    led.merge({ cfg: owned({ theme: 'stale' }, 'host', 1) }) // an older seq can't win
    expect(led.getOwned('cfg', 0)).toEqual({ theme: 'b' })
  })
})
