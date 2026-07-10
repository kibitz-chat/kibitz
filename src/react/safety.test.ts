import { describe, expect, it } from 'vitest'
import { nextPeerSafety, parseVerifiedFps, sameSafety, serializeVerifiedFps, type PeerSafety } from './safety'

const info = (code: string, remoteFp: string) => ({ code, remoteFp })

describe('nextPeerSafety — per-peer SAS state transition', () => {
  it('first reading: shows the code, not yet verified, not changed', () => {
    expect(nextPeerSafety(undefined, info('🦊 🐢', 'aa:bb'), new Set())).toEqual({
      code: '🦊 🐢',
      remoteFp: 'aa:bb',
      verified: false,
      changed: false,
    })
  })

  it('marks verified when the remote fingerprint is in the trusted set', () => {
    const s = nextPeerSafety(undefined, info('🦊 🐢', 'aa:bb'), new Set(['aa:bb']))
    expect(s.verified).toBe(true)
    expect(s.changed).toBe(false)
  })

  it('flags changed when a previously-verified peer presents a new, untrusted cert', () => {
    const prev: PeerSafety = { code: '🦊 🐢', remoteFp: 'aa:bb', verified: true, changed: false }
    const s = nextPeerSafety(prev, info('🐙 🦉', 'cc:dd'), new Set(['aa:bb']))
    expect(s.changed).toBe(true)
    expect(s.verified).toBe(false)
    expect(s.remoteFp).toBe('cc:dd')
  })

  it('does NOT flag changed when the new cert is itself trusted', () => {
    const prev: PeerSafety = { code: '🦊 🐢', remoteFp: 'aa:bb', verified: true, changed: false }
    const s = nextPeerSafety(prev, info('🐙 🦉', 'cc:dd'), new Set(['aa:bb', 'cc:dd']))
    expect(s.changed).toBe(false)
    expect(s.verified).toBe(true)
  })

  it('does NOT flag changed when the cert is unchanged', () => {
    const prev: PeerSafety = { code: '🦊 🐢', remoteFp: 'aa:bb', verified: true, changed: false }
    const s = nextPeerSafety(prev, info('🦊 🐢', 'aa:bb'), new Set(['aa:bb']))
    expect(s.changed).toBe(false)
    expect(s.verified).toBe(true)
  })

  it('TOFU: a pin MISMATCH (known contact, different key) flags changed across calls', () => {
    // Fresh call (no prev), unverified cert, but this contact was pinned to another key before.
    const s = nextPeerSafety(undefined, info('🐙 🦉', 'cc:dd'), new Set(), 'mismatch')
    expect(s.changed).toBe(true)
    expect(s.verified).toBe(false)
  })

  it('TOFU: a pin MATCH or UNPINNED reading does not alarm', () => {
    expect(nextPeerSafety(undefined, info('🦊 🐢', 'aa:bb'), new Set(), 'match').changed).toBe(false)
    expect(nextPeerSafety(undefined, info('🦊 🐢', 'aa:bb'), new Set(), 'unpinned').changed).toBe(false)
  })

  it('TOFU: a trusted (verified-set) cert wins over a stale pin mismatch — no false alarm', () => {
    const s = nextPeerSafety(undefined, info('🦊 🐢', 'aa:bb'), new Set(['aa:bb']), 'mismatch')
    expect(s.verified).toBe(true)
    expect(s.changed).toBe(false)
  })

  it('an unavailable reading keeps the last known state (a blip is not a downgrade)', () => {
    const prev: PeerSafety = { code: '🦊 🐢', remoteFp: 'aa:bb', verified: true, changed: false }
    expect(nextPeerSafety(prev, null, new Set(['aa:bb']))).toEqual(prev)
  })

  it('unavailable with no prior state is all-empty', () => {
    expect(nextPeerSafety(undefined, null, new Set())).toEqual({
      code: null,
      remoteFp: null,
      verified: false,
      changed: false,
    })
  })
})

describe('sameSafety — stable-reference guard for the poll', () => {
  const a: PeerSafety = { code: '🦊 🐢', remoteFp: 'aa', verified: true, changed: false }
  it('is true for equal maps', () => {
    expect(sameSafety({ p: a }, { p: { ...a } })).toBe(true)
  })
  it('is false when a field differs', () => {
    expect(sameSafety({ p: a }, { p: { ...a, verified: false } })).toBe(false)
    expect(sameSafety({ p: a }, { p: { ...a, changed: true } })).toBe(false)
    expect(sameSafety({ p: a }, { p: { ...a, remoteFp: 'bb' } })).toBe(false)
  })
  it('is false when the peer set differs', () => {
    expect(sameSafety({ p: a }, {})).toBe(false)
    expect(sameSafety({ p: a }, { q: a })).toBe(false)
  })
})

describe('verified-fingerprint store (de/serialize)', () => {
  it('round-trips a set', () => {
    expect(parseVerifiedFps(serializeVerifiedFps(new Set(['aa', 'bb'])))).toEqual(new Set(['aa', 'bb']))
  })

  it('parses null / garbage / non-arrays to an empty set', () => {
    expect(parseVerifiedFps(null)).toEqual(new Set())
    expect(parseVerifiedFps('not json')).toEqual(new Set())
    expect(parseVerifiedFps('{"a":1}')).toEqual(new Set())
  })

  it('caps the stored set to the most recent N', () => {
    const many = Array.from({ length: 150 }, (_, i) => `fp${i}`)
    const kept = parseVerifiedFps(serializeVerifiedFps(new Set(many), 100))
    expect(kept.size).toBe(100)
    expect(kept.has('fp149')).toBe(true) // newest kept
    expect(kept.has('fp0')).toBe(false) // oldest dropped
  })
})
