import { describe, it, expect } from 'vitest'
import { newer, decide, elect, type InstanceState, type Claim } from './useSingleInstance'

const claim = (id: string, epoch: number): Claim => ({ id, epoch })
const leaderState = (self: Claim): InstanceState => ({ self, leader: self, active: true, lastBeat: 0 })
const dormantState = (self: Claim, leader: Claim): InstanceState => ({ self, leader, active: false, lastBeat: 0 })

describe('newer — claim ordering (last one wins)', () => {
  it('a higher epoch is newer', () => {
    expect(newer(claim('a', 2), claim('b', 1))).toBe(true)
    expect(newer(claim('a', 1), claim('b', 2))).toBe(false)
  })
  it('equal epochs break by id, deterministically', () => {
    expect(newer(claim('b', 1), claim('a', 1))).toBe(true)
    expect(newer(claim('a', 1), claim('b', 1))).toBe(false)
  })
  it('a claim is not newer than itself', () => {
    expect(newer(claim('a', 1), claim('a', 1))).toBe(false)
  })
})

describe('decide — claim messages', () => {
  it('the active leader YIELDS to a newer claim (goes dormant, adopts the new leader)', () => {
    const st = leaderState(claim('me', 100))
    const r = decide(st, { t: 'claim', claim: claim('other', 200) }, 500)
    expect(r.state.active).toBe(false)
    expect(r.state.leader).toEqual(claim('other', 200))
    expect(r.state.lastBeat).toBe(500)
    expect(r.send).toBeUndefined() // yielding is silent
  })

  it('the active leader RE-ASSERTS against an older claim (so the stale tab yields)', () => {
    const st = leaderState(claim('me', 200))
    const r = decide(st, { t: 'claim', claim: claim('other', 100) }, 500)
    expect(r.state.active).toBe(true)
    expect(r.send).toEqual({ t: 'claim', claim: claim('me', 200) })
  })

  it('a dormant instance ADOPTS an even-newer leader but stays dormant', () => {
    const st = dormantState(claim('me', 50), claim('leaderA', 100))
    const r = decide(st, { t: 'claim', claim: claim('leaderB', 150) }, 500)
    expect(r.state.active).toBe(false)
    expect(r.state.leader).toEqual(claim('leaderB', 150))
  })

  it('a dormant instance IGNORES a claim older than its known leader (no re-assert — it is not the leader)', () => {
    const st = dormantState(claim('me', 50), claim('leaderA', 100))
    const r = decide(st, { t: 'claim', claim: claim('stale', 60) }, 500)
    expect(r.state).toEqual(st)
    expect(r.send).toBeUndefined()
  })

  it('never re-asserts against an echo of my own claim', () => {
    const st = leaderState(claim('me', 200))
    const r = decide(st, { t: 'claim', claim: claim('me', 200) }, 500)
    expect(r.send).toBeUndefined()
  })
})

describe('decide — heartbeats', () => {
  it("refreshes lastBeat when the current leader beats", () => {
    const st = dormantState(claim('me', 50), claim('leader', 100))
    const r = decide(st, { t: 'heartbeat', claim: claim('leader', 100) }, 900)
    expect(r.state.lastBeat).toBe(900)
    expect(r.state.active).toBe(false)
  })
  it('adopts a newer instance that heartbeats (missed its claim)', () => {
    const st = dormantState(claim('me', 50), claim('old', 100))
    const r = decide(st, { t: 'heartbeat', claim: claim('new', 200) }, 900)
    expect(r.state.leader).toEqual(claim('new', 200))
    expect(r.state.active).toBe(false)
    expect(r.state.lastBeat).toBe(900)
  })
  it('ignores a stale heartbeat', () => {
    const st = dormantState(claim('me', 50), claim('leader', 100))
    const r = decide(st, { t: 'heartbeat', claim: claim('ghost', 40) }, 900)
    expect(r.state).toEqual(st)
  })
})

describe('decide — bye / election', () => {
  it('when the leader says bye, a dormant survivor runs for election and becomes active', () => {
    const st = dormantState(claim('me', 50), claim('leader', 100))
    const r = decide(st, { t: 'bye', claim: claim('leader', 100) }, 1000)
    expect(r.state.active).toBe(true)
    expect(r.state.leader.id).toBe('me')
    expect(r.state.self.epoch).toBeGreaterThan(100) // bumped above the departed leader
    expect(r.send).toEqual({ t: 'claim', claim: r.state.self })
  })
  it('ignores a bye from a non-leader', () => {
    const st = dormantState(claim('me', 50), claim('leader', 100))
    const r = decide(st, { t: 'bye', claim: claim('someoneElse', 90) }, 1000)
    expect(r.state).toEqual(st)
  })
})

describe('elect — deterministic winner among simultaneous survivors', () => {
  it('two survivors electing at the same instant resolve to one via id tiebreak', () => {
    // Both bump to the same epoch; the exchange of their claims must leave exactly one active.
    const a = elect(dormantState(claim('a', 5), claim('gone', 100)), 100)
    const b = elect(dormantState(claim('b', 6), claim('gone', 100)), 100)
    expect(a.state.self.epoch).toBe(b.state.self.epoch) // same bumped epoch (max(100,101)=101)
    // a hears b's claim, b hears a's claim → the higher id ('b') stays active, 'a' yields.
    const aAfter = decide(a.state, { t: 'claim', claim: b.state.self }, 200)
    const bAfter = decide(b.state, { t: 'claim', claim: a.state.self }, 200)
    expect(aAfter.state.active).toBe(false)
    expect(bAfter.state.active).toBe(true)
    expect(bAfter.send).toEqual({ t: 'claim', claim: b.state.self }) // b re-asserts, a is already yielding
  })
})
