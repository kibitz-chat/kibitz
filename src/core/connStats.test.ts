import { describe, expect, it } from 'vitest'
import { connInfo, statsToArray, summarizeConnection, type RtcStatLike } from './connStats'

const pair = (extra: object): RtcStatLike => ({ type: 'candidate-pair', id: 'pair1', localCandidateId: 'L', remoteCandidateId: 'R', ...extra })
const cand = (id: string, candidateType: string): RtcStatLike => ({ type: id === 'L' ? 'local-candidate' : 'remote-candidate', id, candidateType })

describe('summarizeConnection', () => {
  it('reports direct when the selected pair uses host/srflx candidates', () => {
    const stats = [pair({ state: 'succeeded', nominated: true }), cand('L', 'host'), cand('R', 'srflx')]
    expect(summarizeConnection(stats)).toBe('direct')
  })

  it('reports relay when either candidate is a TURN relay', () => {
    expect(summarizeConnection([pair({ state: 'succeeded', nominated: true }), cand('L', 'relay'), cand('R', 'host')])).toBe('relay')
    expect(summarizeConnection([pair({ state: 'succeeded', nominated: true }), cand('L', 'host'), cand('R', 'relay')])).toBe('relay')
  })

  it('prefers the transport-named selected pair', () => {
    const stats = [
      { type: 'transport', id: 't', selectedCandidatePairId: 'pairX' },
      { type: 'candidate-pair', id: 'pairX', localCandidateId: 'L', remoteCandidateId: 'R', state: 'succeeded' },
      cand('L', 'relay'),
      cand('R', 'host'),
    ]
    expect(summarizeConnection(stats)).toBe('relay')
  })

  it('honors Firefox-style `selected` when there is no nominated flag', () => {
    const stats = [pair({ state: 'succeeded', selected: true }), cand('L', 'host'), cand('R', 'host')]
    expect(summarizeConnection(stats)).toBe('direct')
  })

  it('returns null when no pair has succeeded yet', () => {
    expect(summarizeConnection([pair({ state: 'in-progress' }), cand('L', 'host'), cand('R', 'host')])).toBeNull()
    expect(summarizeConnection([])).toBeNull()
  })

  it('returns null when the candidate types are missing', () => {
    expect(summarizeConnection([pair({ state: 'succeeded', nominated: true })])).toBeNull()
  })
})

describe('connInfo — kind + RTT + packet loss', () => {
  const inbound = (lost: number, recv: number): RtcStatLike => ({ type: 'inbound-rtp', id: 'in', packetsLost: lost, packetsReceived: recv })

  it('reads RTT (seconds → ms) and loss % off the active pair + inbound stats', () => {
    const stats = [
      pair({ state: 'succeeded', nominated: true, currentRoundTripTime: 0.042 }),
      cand('L', 'host'),
      cand('R', 'srflx'),
      inbound(5, 95),
    ]
    expect(connInfo(stats)).toEqual({ kind: 'direct', rttMs: 42, lossPct: 5 })
  })

  it('reports 0% loss when packets arrived with none lost', () => {
    const stats = [pair({ state: 'succeeded', nominated: true }), cand('L', 'relay'), cand('R', 'host'), inbound(0, 200)]
    expect(connInfo(stats)).toMatchObject({ kind: 'relay', lossPct: 0 })
  })

  it('leaves RTT/loss null when those stats are absent', () => {
    const stats = [pair({ state: 'succeeded', nominated: true }), cand('L', 'host'), cand('R', 'host')]
    expect(connInfo(stats)).toEqual({ kind: 'direct', rttMs: null, lossPct: null })
  })

  it('still returns null kind while connecting (no succeeded pair)', () => {
    expect(connInfo([pair({ state: 'in-progress' })])).toEqual({ kind: null, rttMs: null, lossPct: null })
  })
})

describe('statsToArray', () => {
  it('drains a forEach-style report into an array', () => {
    const report = { forEach: (cb: (s: RtcStatLike) => void) => [{ type: 'a' }, { type: 'b' }].forEach(cb) }
    expect(statsToArray(report).map((s) => s.type)).toEqual(['a', 'b'])
  })
})
