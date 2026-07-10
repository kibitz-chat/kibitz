import { describe, it, expect } from 'vitest'
import { decideStale, PROTOCOL_VERSION } from './buildGate'

describe('decideStale — wire-protocol compatibility', () => {
  it('STALE when a peer is on a strictly HIGHER protocol than us', () => {
    expect(decideStale(1, [2])).toEqual({ stale: true, newerProtocol: 2 })
  })
  it('NOT stale when we are equal — the routine-deploy case (the whole point: no reload on a normal deploy)', () => {
    expect(decideStale(1, [1, 1, 1]).stale).toBe(false)
  })
  it('NOT stale when we are AHEAD of the peer (they reload, not us)', () => {
    expect(decideStale(2, [1]).stale).toBe(false)
  })
  it('a peer with NO protocol (a pre-field client) is treated as the baseline (1) — compatible with baseline', () => {
    expect(decideStale(1, [undefined, null]).stale).toBe(false)
    // …but a baseline peer (missing) is OLDER than us at protocol 2 ⇒ still not stale (we're ahead).
    expect(decideStale(2, [undefined]).stale).toBe(false)
  })
  it('garbage / NaN protocol ⇒ baseline (fail-open, never a spurious reload)', () => {
    expect(decideStale(1, [Number.NaN as unknown as number]).stale).toBe(false)
    expect(decideStale(Number.NaN as unknown as number, [1]).stale).toBe(false)
  })
  it('detects the highest protocol among several peers', () => {
    expect(decideStale(1, [1, undefined, 3, 2]).newerProtocol).toBe(3)
  })
  it('PROTOCOL_VERSION is a positive integer (a real generation)', () => {
    expect(Number.isInteger(PROTOCOL_VERSION) && PROTOCOL_VERSION >= 1).toBe(true)
  })
})
