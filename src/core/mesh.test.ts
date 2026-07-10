import { describe, expect, it } from 'vitest'
import { admitMembers, gatedTrack, laneSender, planRoster, type RosterMember, shouldInitiate } from './mesh'

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

describe('laneSender — per-lane sender addressing (camera vs share must not clobber each other)', () => {
  // A fake pc whose transceivers sit in the negotiated m-line order: audio, video(camera), video(share),
  // mirroring useCall's stream track order. receiver.track.kind reflects the m-line (set even when the
  // sender's own track is gated to null), which is what laneSender keys off.
  const tx = (kind: string, senderId: string) => ({ receiver: { track: { kind } }, sender: { id: senderId } })
  const pc = (transceivers: ReturnType<typeof tx>[]) => ({ getTransceivers: () => transceivers }) as unknown as RTCPeerConnection
  const full = pc([tx('audio', 'A'), tx('video', 'CAM'), tx('video', 'SHARE')])

  it('audio → the audio sender', () => {
    expect((laneSender(full, 'audio') as unknown as { id: string })?.id).toBe('A')
  })
  it('video → the FIRST video sender (camera)', () => {
    expect((laneSender(full, 'video') as unknown as { id: string })?.id).toBe('CAM')
  })
  it('share → the SECOND video sender (share) — NOT the camera', () => {
    const s = laneSender(full, 'share') as unknown as { id: string }
    expect(s?.id).toBe('SHARE')
    expect(s?.id).not.toBe('CAM')
  })
  it('ordering survives a gated camera (sender.track null) via the receiver kind', () => {
    const gated = pc([tx('audio', 'A'), { receiver: { track: { kind: 'video' } }, sender: { id: 'CAM', track: null } } as unknown as ReturnType<typeof tx>, tx('video', 'SHARE')])
    expect((laneSender(gated, 'video') as unknown as { id: string })?.id).toBe('CAM')
    expect((laneSender(gated, 'share') as unknown as { id: string })?.id).toBe('SHARE')
  })
  it('returns null for an un-negotiated share lane (a 2-lane peer with no share m-line)', () => {
    const twoLane = pc([tx('audio', 'A'), tx('video', 'CAM')])
    expect(laneSender(twoLane, 'share')).toBeNull()
    expect((laneSender(twoLane, 'video') as unknown as { id: string })?.id).toBe('CAM') // camera still resolves
  })
  // The opt-in 4th lane: m-line order audio(mic), video(cam), video(share), audio(shareAudio).
  const fourLane = pc([tx('audio', 'MIC'), tx('video', 'CAM'), tx('video', 'SHARE'), tx('audio', 'SHAREAUDIO')])
  it('shareAudio → the SECOND audio sender (NOT the mic)', () => {
    const s = laneSender(fourLane, 'shareAudio') as unknown as { id: string }
    expect(s?.id).toBe('SHAREAUDIO')
    expect(s?.id).not.toBe('MIC')
  })
  it('audio still → the FIRST audio sender (mic) with the 4th lane present', () => {
    expect((laneSender(fourLane, 'audio') as unknown as { id: string })?.id).toBe('MIC')
  })
  it('shareAudio → null on a peer WITHOUT the lane (old/opt-out client) — graceful, no clobber', () => {
    expect(laneSender(full, 'shareAudio')).toBeNull() // `full` is the 3-lane pc
    expect((laneSender(full, 'audio') as unknown as { id: string })?.id).toBe('A') // mic unaffected
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

describe('admitMembers (room human-cap, collusion-resistant half)', () => {
  const h = (id: string) => ({ id, human: true })
  const a = (id: string) => ({ id, human: false })
  it('uncapped (null/0) → everyone admitted', () => {
    expect([...admitMembers([h('1'), h('2'), a('bot')], null, new Set())].sort()).toEqual(['1', '2', 'bot'])
    expect(admitMembers([h('1')], 0, new Set()).size).toBe(1)
  })
  it('caps HUMANS at maxHumans (self counts as 1); agents are free; the over-cap human is refused', () => {
    const members = [h('1'), h('2'), h('3'), h('4'), h('5'), h('6'), a('bot')]
    const r = admitMembers(members, 6, new Set())
    expect(r.has('bot')).toBe(true) // agent doesn't count
    expect([...r].filter((id) => id !== 'bot').length).toBe(5) // 5 other humans + self = 6
    expect(r.has('6')).toBe(false) // the 7th human (self is the 6th) is refused
  })
  it('no eviction — a newcomer is refused, an already-admitted member is kept', () => {
    const prev = new Set(['1', '2', '3', '4', '5']) // room already full at cap 6 (self + 5)
    const r = admitMembers([h('0'), h('1'), h('2'), h('3'), h('4'), h('5')], 6, prev)
    for (const id of ['1', '2', '3', '4', '5']) expect(r.has(id)).toBe(true)
    expect(r.has('0')).toBe(false)
  })
})
