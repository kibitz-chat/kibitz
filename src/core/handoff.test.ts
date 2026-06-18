import { afterEach, describe, expect, it } from 'vitest'
import {
  HANDOFF_TTL,
  clearHandoffRoom,
  consumeHandoffRoom,
  readHandoff,
  serializeHandoff,
  stashHandoffRoom,
} from './handoff'

describe('handoff — "open in app" room stash', () => {
  const now = 1_000_000_000_000
  const href = 'https://kibitz.chat/#tidal-3pu4s1ghy1'

  it('round-trips a fresh stash', () => {
    const raw = serializeHandoff(href, now)
    expect(readHandoff(raw, now)).toBe(href)
    expect(readHandoff(raw, now + HANDOFF_TTL - 1)).toBe(href) // still inside the window
  })

  it('ignores a stale stash (older than the TTL)', () => {
    const raw = serializeHandoff(href, now)
    expect(readHandoff(raw, now + HANDOFF_TTL + 1)).toBeNull()
  })

  it('returns null for nothing / malformed / empty href', () => {
    expect(readHandoff(null, now)).toBeNull()
    expect(readHandoff('not json', now)).toBeNull()
    expect(readHandoff(JSON.stringify({ href, t: 'soon' }), now)).toBeNull() // bad timestamp
    expect(readHandoff(serializeHandoff('', now), now)).toBeNull() // empty href
  })
})

describe('handoff — localStorage wrappers', () => {
  const href = 'https://kibitz.chat/#tidal-3pu4s1ghy1'
  const g = globalThis as { localStorage?: unknown }

  afterEach(() => {
    delete g.localStorage
  })

  /** Minimal in-memory localStorage stub (the node test env has none). */
  function stubStorage(): Map<string, string> {
    const m = new Map<string, string>()
    g.localStorage = {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    }
    return m
  }

  it('stash → consume returns the room once, then null (one-shot, cleared on read)', () => {
    stubStorage()
    stashHandoffRoom(href)
    expect(consumeHandoffRoom()).toBe(href)
    expect(consumeHandoffRoom()).toBeNull() // already consumed
  })

  it('clear forgets a stashed room', () => {
    stubStorage()
    stashHandoffRoom(href)
    clearHandoffRoom()
    expect(consumeHandoffRoom()).toBeNull()
  })

  it('never throws when storage is blocked', () => {
    g.localStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(() => stashHandoffRoom(href)).not.toThrow()
    expect(() => clearHandoffRoom()).not.toThrow()
    expect(consumeHandoffRoom()).toBeNull()
  })
})
