import { describe, expect, it } from 'vitest'
import { localMediaSrc, nextStageMAt, pickStagedMedia, stageMAtOf, stageMClearAtOf, stagedMediaOf } from './stageMedia'

const p = (id: string, meta: Record<string, unknown> = {}) => ({ id, meta })

describe('stageMedia — shared "which shared file is on the stage" convention', () => {
  it("reads a participant's staged-media push from meta", () => {
    expect(stagedMediaOf(p('a'))).toBeNull()
    expect(stagedMediaOf(p('a', { stageMedia: 'bob#2', stageMAt: 3 }))).toBe('bob#2')
    expect(stageMAtOf(p('a', { stageMedia: 'bob#2', stageMAt: 3 }))).toBe(3)
    expect(stageMAtOf(p('a', { stageMedia: '', stageMAt: 3 }))).toBe(0) // empty key → not pushing
  })

  it('nobody pushing → no staged media', () => {
    expect(pickStagedMedia([p('a'), p('b')])).toBeNull()
  })

  it('the NEWEST push wins (anyone can take over the stage)', () => {
    const parts = [
      p('agent', { stageMedia: 'a#1', stageMAt: 1 }),
      p('alice', { stageMedia: 'b#1', stageMAt: 5 }), // pushed later → wins (alice is the playback authority)
      p('bob', { stageMedia: 'c#1', stageMAt: 3 }),
    ]
    expect(pickStagedMedia(parts)).toEqual({ key: 'b#1', from: 'alice' })
  })

  it('a cleared push (stageMedia undefined) drops out of contention', () => {
    const parts = [
      p('agent', { stageMedia: 'a#1', stageMAt: 1 }),
      p('alice', { stageMedia: undefined, stageMAt: 9 }),
    ]
    expect(pickStagedMedia(parts)).toEqual({ key: 'a#1', from: 'agent' })
  })

  it('nextStageMAt is one past the highest push OR clear (monotonic take-over)', () => {
    expect(nextStageMAt([p('a', { stageMedia: 'm', stageMAt: 4 }), p('b', { stageMedia: 'm2', stageMAt: 7 })])).toBe(8)
    expect(nextStageMAt([p('a', { stageMClearAt: 11 }), p('b', { stageMedia: 'm', stageMAt: 7 })])).toBe(12) // a clear counts
    expect(nextStageMAt([p('a'), p('b')])).toBe(1)
  })

  it('a CLEAR newer than the newest push empties the stage — ANYONE can un-stage (tombstone)', () => {
    expect(stageMClearAtOf(p('a', { stageMClearAt: 6 }))).toBe(6)
    const cleared = [p('alice', { stageMedia: 'clip#1', stageMAt: 5 }), p('bob', { stageMedia: undefined, stageMClearAt: 6 })]
    expect(pickStagedMedia(cleared)).toBeNull()
    const restaged = [...cleared, p('carol', { stageMedia: 'clip#2', stageMAt: 7 })]
    expect(pickStagedMedia(restaged)).toEqual({ key: 'clip#2', from: 'carol' })
  })
})

describe('localMediaSrc — resolve a stage key to THIS peer\'s own local copy', () => {
  // Every peer holds its OWN blob: url for the bytes, but the SAME mid/xid. Resolve by mid first, then xid.
  const chat = [
    { mid: 'bob#2', attachment: { xid: 'x-aaa', url: 'blob:peerA/1' } },
    { mid: 'bob#3', attachment: { xid: 'x-bbb', url: 'blob:peerA/2' } },
    { mid: 'sue#1', attachment: { xid: 'x-ccc', url: undefined } }, // saved-to-disk / large → no readable url
    { mid: 'txt#1' }, // a plain text row, no attachment
  ]
  it('resolves a shared file by its stable mid → this peer\'s local url', () => {
    expect(localMediaSrc(chat, 'bob#2')).toBe('blob:peerA/1')
    expect(localMediaSrc(chat, 'bob#3')).toBe('blob:peerA/2')
  })
  it('also resolves by the transfer xid', () => {
    expect(localMediaSrc(chat, 'x-bbb')).toBe('blob:peerA/2')
  })
  it('returns null when this peer lacks the bytes (evicted / saved / never received) — the fallback signal', () => {
    expect(localMediaSrc(chat, 'sue#1')).toBeNull() // present row but no url
    expect(localMediaSrc(chat, 'nope#9')).toBeNull() // not in chat at all
    expect(localMediaSrc(chat, '')).toBeNull()
  })
})
