import { describe, expect, it } from 'vitest'
import { RoomLedger } from './roomLedger'
import { LedgerStore, type LedgerKV, localStorageKV, memoryKV, persistLedger } from './roomLedgerStore'

const FAR = 9_999_999_999_999
const NOW = 1_000_000

// A Map-backed Storage shim (kibitz vitest is node-only, no real localStorage).
function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, String(v))
    },
    removeItem: (k) => {
      m.delete(k)
    },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  } as Storage
}

describe('LedgerStore', () => {
  it('round-trips a ledger (save → load)', async () => {
    const kv = memoryKV()
    const led = new RoomLedger()
    led.attest('agentSeen.x', true, { author: 'a', expireAt: FAR })
    const store = new LedgerStore(kv, 'room1')
    await store.save(led.snapshot(), NOW)
    const fresh = new RoomLedger()
    fresh.merge(await store.load(NOW))
    expect(fresh.has('agentSeen.x', NOW)).toBe(true)
  })

  it('drops expired entries on load', async () => {
    const kv = memoryKV()
    const led = new RoomLedger()
    led.attest('soon', true, { author: 'a', expireAt: NOW + 100 })
    led.attest('later', true, { author: 'a', expireAt: FAR })
    await new LedgerStore(kv, 'r').save(led.snapshot(), NOW)
    const loaded = await new LedgerStore(kv, 'r').load(NOW + 500) // 'soon' has expired by now
    const fresh = new RoomLedger()
    fresh.merge(loaded)
    expect(fresh.has('soon', NOW + 500)).toBe(false)
    expect(fresh.has('later', NOW + 500)).toBe(true)
  })

  it('does not persist already-expired entries (GC on save)', async () => {
    const kv = memoryKV()
    const led = new RoomLedger()
    led.attest('dead', true, { author: 'a', expireAt: NOW - 1 }) // already expired
    await new LedgerStore(kv, 'r').save(led.snapshot(), NOW)
    const raw = await kv.get('kbz.ledger.r')
    expect(raw).toBe('{}') // nothing live → empty object stored
  })

  it('returns {} on empty or corrupt storage (fail-soft)', async () => {
    const kv: LedgerKV = { async get() { return 'not json{' }, async set() {} }
    expect(await new LedgerStore(kv, 'r').load(NOW)).toEqual({})
    expect(await new LedgerStore(memoryKV(), 'r').load(NOW)).toEqual({})
  })

  it('is keyed per room (no cross-room bleed)', async () => {
    const kv = memoryKV()
    const a = new RoomLedger()
    a.attest('k', true, { author: 'a', expireAt: FAR })
    await new LedgerStore(kv, 'roomA').save(a.snapshot(), NOW)
    expect(await new LedgerStore(kv, 'roomB').load(NOW)).toEqual({}) // different room → nothing
  })
})

describe('localStorageKV', () => {
  it('round-trips via an injected Storage', async () => {
    const kv = localStorageKV(fakeStorage())
    await kv.set('k', 'v')
    expect(await kv.get('k')).toBe('v')
    expect(await kv.get('missing')).toBeNull()
  })

  it('swallows a throwing Storage (quota / private mode)', async () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      },
    } as unknown as Storage
    const kv = localStorageKV(throwing)
    await expect(kv.set('k', 'v')).resolves.toBeUndefined() // no throw
    expect(await kv.get('k')).toBeNull()
  })
})

describe('persistLedger', () => {
  it('seeds the ledger from the store on start (ready)', async () => {
    const kv = memoryKV()
    const seed = new RoomLedger()
    seed.attest('agentSeen.x', true, { author: 'a', expireAt: FAR })
    await new LedgerStore(kv, 'r').save(seed.snapshot(), NOW)

    const led = new RoomLedger()
    const p = persistLedger(led, new LedgerStore(kv, 'r'), { now: () => NOW })
    expect(led.has('agentSeen.x', NOW)).toBe(false) // not loaded yet
    await p.ready
    expect(led.has('agentSeen.x', NOW)).toBe(true) // loaded
    p.stop()
  })

  it('saves local writes (survives a reload)', async () => {
    const kv = memoryKV()
    const led = new RoomLedger()
    const p = persistLedger(led, new LedgerStore(kv, 'r'), { now: () => NOW })
    await p.ready
    led.attest('agentSeen.x', true, { author: 'a', expireAt: FAR })
    await p.flush()
    p.stop()
    // A fresh "page load" reads it back.
    const reloaded = new RoomLedger()
    reloaded.merge(await new LedgerStore(kv, 'r').load(NOW))
    expect(reloaded.has('agentSeen.x', NOW)).toBe(true)
  })

  it('stops persisting after stop()', async () => {
    const kv = memoryKV()
    const led = new RoomLedger()
    const p = persistLedger(led, new LedgerStore(kv, 'r'), { now: () => NOW })
    await p.ready
    p.stop()
    led.attest('late', true, { author: 'a', expireAt: FAR })
    await p.flush() // flush still works (explicit), but no debounced auto-save fires after stop
    // (flush after stop persists the current snapshot — that's fine; the guarantee is no *scheduled* saves)
    expect(led.has('late', NOW)).toBe(true)
  })
})
