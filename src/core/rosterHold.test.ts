import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rosterHoldOn } from './rosterHold'

// rosterHoldOn reads localStorage + location; the node test env has neither, so stub them.
function stubEnv(search = '') {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  })
  vi.stubGlobal('location', { search })
  return store
}

describe('rosterHoldOn (per-device flag, default ON)', () => {
  beforeEach(() => stubEnv())
  afterEach(() => vi.unstubAllGlobals())

  it('defaults ON when nothing is set', () => {
    expect(rosterHoldOn()).toBe(true)
  })

  it('respects the persisted localStorage value', () => {
    localStorage.setItem('kbz.rosterHold', '0')
    expect(rosterHoldOn()).toBe(false)
    localStorage.setItem('kbz.rosterHold', '1')
    expect(rosterHoldOn()).toBe(true)
  })

  it('?rhold=0 turns it OFF for that device AND persists', () => {
    stubEnv('?rhold=0')
    expect(rosterHoldOn()).toBe(false)
    expect(localStorage.getItem('kbz.rosterHold')).toBe('0')
  })
})
