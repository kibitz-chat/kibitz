import { describe, it, expect } from 'vitest'
import hookSrc from './useActiveSpeakers.ts?raw'
import { isAudibleParticipant } from './useActiveSpeakers'
import type { CallParticipant } from './useCall'

// The meter loop is a requestAnimationFrame chain that reschedules itself every frame. Widget mounts this
// hook UNCONDITIONALLY and never unmounts, so if the loop isn't gated it spins at ~60fps forever — even on
// the landing page after a call ends — keeping an iOS phone warm and draining battery. The fix gates the
// loop on `metering = participants.some(isAudibleParticipant)`. These tests pin BOTH halves: the predicate
// that decides "is there anything to meter", and (structurally, since there's no hook-render harness) that
// the loop actually depends on it.

// Minimal CallParticipant with a single audio track of the given trait — only the fields the predicate reads.
const withTrack = (t: Partial<MediaStreamTrack> | null): CallParticipant =>
  ({
    id: 'p',
    name: 'p',
    cam: false,
    avatar: '',
    stream: t
      ? ({ getAudioTracks: () => [{ readyState: 'live', muted: false, enabled: true, ...t }] } as unknown as MediaStream)
      : null,
    shareStream: null,
  }) as unknown as CallParticipant

describe('isAudibleParticipant — the meter-loop gate predicate', () => {
  it('is true only for a live, unmuted, enabled audio track', () => {
    expect(isAudibleParticipant(withTrack({}))).toBe(true)
  })

  it('is false when there is no stream (nothing to meter)', () => {
    expect(isAudibleParticipant(withTrack(null))).toBe(false)
  })

  it('is false for a muted track (your own mic off / a muted peer)', () => {
    expect(isAudibleParticipant(withTrack({ muted: true }))).toBe(false)
  })

  it('is false for a disabled track', () => {
    expect(isAudibleParticipant(withTrack({ enabled: false }))).toBe(false)
  })

  it('is false for an ended track', () => {
    expect(isAudibleParticipant(withTrack({ readyState: 'ended' }))).toBe(false)
  })

  it('a stream with no audio tracks is not audible', () => {
    const p = { id: 'p', name: 'p', cam: false, avatar: '', stream: { getAudioTracks: () => [] }, shareStream: null }
    expect(isAudibleParticipant(p as unknown as CallParticipant)).toBe(false)
  })

  it('an empty call has nothing to meter → the gate is off', () => {
    expect(([] as CallParticipant[]).some(isAudibleParticipant)).toBe(false)
  })
})

describe('meter loop is gated (no forever-spinning rAF after a call)', () => {
  it('derives `metering` from the audible participants', () => {
    expect(hookSrc).toMatch(/const metering = participants\.some\(isAudibleParticipant\)/)
  })

  it('the rAF meter-loop effect early-returns and depends on `metering` (not [])', () => {
    // Guards against a regression back to `useEffect(() => { ...rAF... }, [])`, which spins forever.
    expect(hookSrc).toMatch(/if \(!metering\) \{[\s\S]*?return\n\s*\}/)
    expect(hookSrc).toMatch(/cancelAnimationFrame\(raf\)\n\s*\}, \[metering\]\)/)
  })
})
