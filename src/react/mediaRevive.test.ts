import { describe, it, expect } from 'vitest'
import { trackDead, planRevive } from './mediaRevive'

describe('trackDead', () => {
  it('is true for a missing or ended track, false for a live one (muted or not)', () => {
    expect(trackDead(null)).toBe(true)
    expect(trackDead(undefined)).toBe(true)
    expect(trackDead({ readyState: 'ended' } as MediaStreamTrack)).toBe(true)
    expect(trackDead({ readyState: 'live' } as MediaStreamTrack)).toBe(false)
    // a live-but-muted track is NOT dead — iOS unmutes it on foreground
    expect(trackDead({ readyState: 'live', muted: true } as MediaStreamTrack)).toBe(false)
  })
})

describe('planRevive', () => {
  const base = { ios: true, inCall: true, micIntent: true, camIntent: true, keepMic: false, micDead: true, camDead: true }

  it('revives a wanted lane whose real track died', () => {
    expect(planRevive(base)).toEqual({ reMic: true, reCam: true })
  })

  it('never revives off iOS or outside a call', () => {
    expect(planRevive({ ...base, ios: false })).toEqual({ reMic: false, reCam: false })
    expect(planRevive({ ...base, inCall: false })).toEqual({ reMic: false, reCam: false })
  })

  it('leaves a lane alone when the user does not want it on', () => {
    expect(planRevive({ ...base, micIntent: false })).toEqual({ reMic: false, reCam: true })
    expect(planRevive({ ...base, camIntent: false })).toEqual({ reMic: true, reCam: false })
  })

  it('does not re-grab a still-live track (not dead)', () => {
    expect(planRevive({ ...base, micDead: false })).toEqual({ reMic: false, reCam: true })
    expect(planRevive({ ...base, camDead: false })).toEqual({ reMic: true, reCam: false })
  })

  it('never touches the mic in car mode (keepMic)', () => {
    expect(planRevive({ ...base, keepMic: true })).toEqual({ reMic: false, reCam: true })
  })
})
