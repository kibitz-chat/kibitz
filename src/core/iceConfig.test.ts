import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getIceServers, warmIceServers, _resetIceCache } from './iceConfig'

// Minimal Response-like so the test doesn't depend on the Response constructor.
const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response

// In-memory localStorage — the node test env has no DOM, so the persist/reuse path needs a stub to exercise it.
const memLocalStorage = (): Storage => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage
}

describe('getIceServers (robust internet relay)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memLocalStorage())
    _resetIceCache()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('uses TURN servers from /api/turn when configured', async () => {
    const turn: RTCIceServer[] = [
      { urls: ['stun:stun.cloudflare.com:3478'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => ok({ iceServers: turn, configured: true })))
    expect(await getIceServers()).toEqual(turn)
  })

  it('falls back to STUN-only when TURN is not configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ iceServers: null, configured: false })))
    const servers = await getIceServers()
    expect(servers).toHaveLength(1)
    expect(String(servers[0].urls)).toContain('stun:')
    expect('credential' in servers[0]).toBe(false)
  })

  it('falls back to STUN when the fetch throws (offline / dev)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network')
      }),
    )
    const servers = await getIceServers()
    expect(String(servers[0].urls)).toContain('stun:')
  })

  it('caches within a session — one fetch for repeated callers', async () => {
    const f = vi.fn(async () => ok({ iceServers: [{ urls: 'stun:x' }] }))
    vi.stubGlobal('fetch', f)
    await Promise.all([getIceServers(), getIceServers()])
    await getIceServers()
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('does NOT cache a transient miss — a later call retries and can land TURN (cellular reliability)', async () => {
    const turn: RTCIceServer[] = [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }]
    // First fetch times out / throws (a slow cellular moment) → STUN fallback, but it must NOT poison the session.
    const f = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('timeout')
      })
      .mockImplementation(async () => ok({ iceServers: turn, configured: true }))
    vi.stubGlobal('fetch', f)
    const first = await getIceServers()
    expect(String(first[0].urls)).toContain('stun:') // fell back this time
    const second = await getIceServers() // retries (the miss wasn't cached) → now gets the real TURN relay
    expect(second).toEqual(turn)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('warmIceServers retries a transient miss until TURN is cached (presence-peer reliability)', async () => {
    const turn: RTCIceServer[] = [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }]
    const f = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('timeout')
      })
      .mockImplementation(async () => ok({ iceServers: turn, configured: true }))
    vi.stubGlobal('fetch', f)
    await warmIceServers(5)
    expect(await getIceServers()).toEqual(turn) // warmed → cached TURN, no further fetch
    expect(f).toHaveBeenCalledTimes(2) // one miss + one success; getIceServers() after is a cache hit
  })

  it('caches a DEFINITIVE no-TURN answer (200 + null iceServers) — does NOT retry (online self-host / TURN off)', async () => {
    // A real response that says "no relay here" must NOT trigger the transient-retry storm — else an online-but-no-TURN
    // join stalls ~7s warming a relay that will never come. One fetch, cached STUN, done.
    const f = vi.fn(async () => ok({ iceServers: null, configured: false }))
    vi.stubGlobal('fetch', f)
    await warmIceServers(4)
    const servers = await getIceServers()
    expect(String(servers[0].urls)).toContain('stun:')
    expect(f).toHaveBeenCalledTimes(1) // definitive answer cached after ONE fetch — no retry storm, no stall
  })

  it('reuses persisted TURN creds when the fetch STALLS (survives a network change / reload, no host-only)', async () => {
    const turn: RTCIceServer[] = [
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
    ]
    // Creds saved by a prior successful session (e.g. on 4G), still fresh:
    localStorage.setItem('kbz.iceServers', JSON.stringify({ at: Date.now(), servers: turn }))
    // Now the fetch STALLS (the after-a-network-change / reload-on-cellular case):
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('stalled after network change')
      }),
    )
    expect(await getIceServers()).toEqual(turn) // reused the saved relay creds, NOT a host-only STUN fallback
  })

  it('does NOT reuse STALE persisted creds (older than the TTL) — falls back to STUN', async () => {
    const turn: RTCIceServer[] = [
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
    ]
    // 60 min old, past the 30-min reuse window → must be ignored so we never hand out an expired credential:
    localStorage.setItem('kbz.iceServers', JSON.stringify({ at: Date.now() - 60 * 60 * 1000, servers: turn }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('stalled')
      }),
    )
    const servers = await getIceServers()
    expect(String(servers[0].urls)).toContain('stun:') // stale creds ignored → STUN fallback
  })
})
