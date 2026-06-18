import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getIceServers, _resetIceCache } from './iceConfig'

// Minimal Response-like so the test doesn't depend on the Response constructor.
const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response

describe('getIceServers (robust internet relay)', () => {
  beforeEach(() => _resetIceCache())
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
})
