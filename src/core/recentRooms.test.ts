import { describe, it, expect, beforeEach } from 'vitest'
import { getRecentRooms, recordRecentRoom, forgetRecentRoom, clearRecentRooms } from './recentRooms'

// node has no localStorage — install a minimal in-memory one before each test
beforeEach(() => {
  const m = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as Storage
})

describe('recentRooms', () => {
  it('records newest-first, dedups by code, refreshes on a re-visit', () => {
    recordRecentRoom({ code: 'a', name: 'A', hash: '#a?sk=1', at: 1 })
    recordRecentRoom({ code: 'b', name: 'B', hash: '#b', at: 2 })
    recordRecentRoom({ code: 'a', name: 'A2', hash: '#a?sk=2', at: 3 }) // re-visit a
    const list = getRecentRooms()
    expect(list.map((r) => r.code)).toEqual(['a', 'b']) // a moved to front, no duplicate
    expect(list[0].hash).toBe('#a?sk=2') // refreshed hash
    expect(list[0].name).toBe('A2') // refreshed name
  })

  it('caps at 6, keeping the newest', () => {
    for (let i = 0; i < 9; i++) recordRecentRoom({ code: 'r' + i, name: 'r' + i, hash: '#r' + i, at: i })
    const list = getRecentRooms()
    expect(list).toHaveLength(6)
    expect(list[0].code).toBe('r8') // newest first
    expect(list.some((r) => r.code === 'r0')).toBe(false) // oldest dropped
  })

  it('falls back to the code when no name; ignores empty code/hash', () => {
    recordRecentRoom({ code: 'plain', hash: '#plain', at: 1 })
    recordRecentRoom({ code: '', hash: '#x', at: 2 }) // no code → ignored
    recordRecentRoom({ code: 'y', hash: '', at: 3 }) // no hash → ignored
    expect(getRecentRooms().map((r) => r.code)).toEqual(['plain'])
    expect(getRecentRooms()[0].name).toBe('plain')
  })

  it('forget removes one; clear wipes all', () => {
    recordRecentRoom({ code: 'a', hash: '#a', at: 1 })
    recordRecentRoom({ code: 'b', hash: '#b', at: 2 })
    forgetRecentRoom('a')
    expect(getRecentRooms().map((r) => r.code)).toEqual(['b'])
    clearRecentRooms()
    expect(getRecentRooms()).toEqual([])
  })
})
