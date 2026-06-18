import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearInCall, isFresh, markInCall, parseIntent, REJOIN_TTL_MS, shouldRejoin, type RejoinIntent } from './rejoinIntent'

describe('parseIntent', () => {
  it('round-trips a well-formed intent', () => {
    expect(parseIntent(JSON.stringify({ room: 'lunch', at: 1000 }))).toEqual({ room: 'lunch', at: 1000 })
  })

  it('rejects null / empty', () => {
    expect(parseIntent(null)).toBeNull()
    expect(parseIntent('')).toBeNull()
  })

  it('rejects malformed JSON', () => {
    expect(parseIntent('{not json')).toBeNull()
  })

  it('rejects the wrong shape (missing/!string room, missing/!finite at)', () => {
    expect(parseIntent(JSON.stringify({ at: 1000 }))).toBeNull()
    expect(parseIntent(JSON.stringify({ room: '', at: 1000 }))).toBeNull()
    expect(parseIntent(JSON.stringify({ room: 'x' }))).toBeNull()
    expect(parseIntent(JSON.stringify({ room: 'x', at: 'soon' }))).toBeNull()
    expect(parseIntent(JSON.stringify({ room: 'x', at: Number.NaN }))).toBeNull()
    expect(parseIntent(JSON.stringify([]))).toBeNull()
    expect(parseIntent(JSON.stringify('lunch'))).toBeNull()
  })
})

describe('isFresh', () => {
  const intent: RejoinIntent = { room: 'lunch', at: 10_000 }

  it('is fresh for the same room within the TTL', () => {
    expect(isFresh(intent, 'lunch', 10_000)).toBe(true) // age 0
    expect(isFresh(intent, 'lunch', 10_000 + REJOIN_TTL_MS)).toBe(true) // exactly at TTL
    expect(isFresh(intent, 'lunch', 10_000 + REJOIN_TTL_MS / 2)).toBe(true)
  })

  it('is stale past the TTL', () => {
    expect(isFresh(intent, 'lunch', 10_000 + REJOIN_TTL_MS + 1)).toBe(false)
  })

  it('never matches a different room (no cross-room rejoin)', () => {
    expect(isFresh(intent, 'dinner', 10_000)).toBe(false)
  })

  it('rejects null and a clock that ran backwards', () => {
    expect(isFresh(null, 'lunch', 10_000)).toBe(false)
    expect(isFresh(intent, 'lunch', 9_000)).toBe(false) // intent stamped in the "future"
  })

  it('honours a custom ttl', () => {
    expect(isFresh(intent, 'lunch', 10_500, 1_000)).toBe(true)
    expect(isFresh(intent, 'lunch', 11_500, 1_000)).toBe(false)
  })
})

// The IO layer is what actually runs in the browser; the node test env has no
// localStorage, so install a minimal fake to exercise the round-trip + the
// failure-is-safe guards.
describe('markInCall / clearInCall / shouldRejoin (localStorage IO)', () => {
  function fakeStorage() {
    const map = new Map<string, string>()
    return {
      getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    }
  }

  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('round-trips: mark then shouldRejoin (same room, within TTL)', () => {
    markInCall('lunch', 10_000)
    expect(shouldRejoin('lunch', 10_000)).toBe(true)
    expect(shouldRejoin('lunch', 10_000 + REJOIN_TTL_MS)).toBe(true)
  })

  it('does not rejoin a different room or a stale stamp', () => {
    markInCall('lunch', 10_000)
    expect(shouldRejoin('dinner', 10_000)).toBe(false)
    expect(shouldRejoin('lunch', 10_000 + REJOIN_TTL_MS + 1)).toBe(false)
  })

  it('clearInCall forgets the intent (no surprise rejoin after an explicit leave)', () => {
    markInCall('lunch', 10_000)
    clearInCall()
    expect(shouldRejoin('lunch', 10_000)).toBe(false)
  })

  it('shouldRejoin is false with nothing stored', () => {
    expect(shouldRejoin('lunch', 10_000)).toBe(false)
  })

  it('a re-stamp (heartbeat) extends freshness from the new time', () => {
    markInCall('lunch', 10_000)
    markInCall('lunch', 10_000 + REJOIN_TTL_MS) // heartbeat later in the call
    // Now-just-past the ORIGINAL stamp's window, but fresh against the re-stamp.
    expect(shouldRejoin('lunch', 10_000 + REJOIN_TTL_MS + 5_000)).toBe(true)
  })

  it('survives a throwing localStorage (storage blocked) without throwing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    })
    expect(() => markInCall('lunch', 10_000)).not.toThrow()
    expect(() => clearInCall()).not.toThrow()
    expect(shouldRejoin('lunch', 10_000)).toBe(false) // safe default: don't rejoin
  })
})
