import { describe, expect, it } from 'vitest'
import { gatedTrack, planRoster, type RosterMember, shouldInitiate } from './mesh'

const m = (id: string, cam = false): RosterMember => ({ id, cam })

// Stand-ins — gatedTrack only ever compares references, never touches the track.
const real = { id: 'real' } as unknown as MediaStreamTrack
const placeholder = { id: 'placeholder' } as unknown as MediaStreamTrack

describe('gatedTrack — per-peer media perception', () => {
  it('an ALLOWED peer receives the real track', () => {
    expect(gatedTrack(true, real, placeholder)).toBe(real)
  })
  it('a WITHHELD peer receives the placeholder, not the real track', () => {
    expect(gatedTrack(false, real, placeholder)).toBe(placeholder)
  })
  it('fails CLOSED when no placeholder could be minted — returns null, never the real track', () => {
    // A capability gate must not leak real media when the placeholder is missing.
    expect(gatedTrack(false, real, null)).toBeNull()
    expect(gatedTrack(false, real, null)).not.toBe(real)
  })
  it('never returns the real track to a withheld peer (any placeholder state)', () => {
    for (const ph of [placeholder, null]) expect(gatedTrack(false, real, ph)).not.toBe(real)
  })
  it('passes null through when there is nothing on the lane', () => {
    expect(gatedTrack(true, null, placeholder)).toBeNull()
  })
})

describe('shouldInitiate', () => {
  it('exactly one side of each pair initiates (the smaller id)', () => {
    expect(shouldInitiate('a', 'b')).toBe(true)
    expect(shouldInitiate('b', 'a')).toBe(false)
    // Never both, never neither — glare-free.
    expect(shouldInitiate('a', 'b') === shouldInitiate('b', 'a')).toBe(false)
  })
})

describe('planRoster', () => {
  it('dials new members we are the initiator for, and skips ourselves', () => {
    const plan = planRoster('a', [m('a'), m('b'), m('c')], new Set())
    expect(plan.initiate.sort()).toEqual(['b', 'c'])
    expect(plan.drop).toEqual([])
  })

  it('does NOT dial members that should dial us (their id sorts first)', () => {
    // We are 'm'; 'a'/'b' are smaller, so they initiate to us.
    const plan = planRoster('m', [m('a'), m('b'), m('z')], new Set())
    expect(plan.initiate).toEqual(['z'])
  })

  it('does NOT re-dial on a camera change — replaceTrack handles it on the live connection', () => {
    // Re-dialling per camera toggle churns whole RTCPeerConnections, which crashes
    // iOS WebKit natively. Camera changes swap tracks on the existing call.
    const plan = planRoster('a', [m('a'), m('b', true)], new Set(['b']))
    expect(plan.initiate).toEqual([])
  })

  it('does not dial pairs we already opened', () => {
    const plan = planRoster('a', [m('a'), m('b')], new Set(['b']))
    expect(plan.initiate).toEqual([])
  })

  it('drops members who left the roster', () => {
    const plan = planRoster('a', [m('a'), m('b')], new Set(['b', 'c']))
    expect(plan.drop).toEqual(['c'])
    expect(plan.initiate).toEqual([])
  })
})
