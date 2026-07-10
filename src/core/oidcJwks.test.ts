import { describe, expect, it, vi } from 'vitest'
import { createJwksResolver, discoverJwksUri, fetchJwks } from './oidcJwks'

const ISS = 'https://accounts.google.com'
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs'
const KEYS = [{ kty: 'RSA', kid: 'k1', n: 'AA', e: 'AQAB' }]

const ok = (body: unknown) => ({ ok: true, json: async () => body })
const notFound = () => ({ ok: false, json: async () => ({}) })

function mockFetch() {
  return vi.fn(async (url: string) => {
    if (url === `${ISS}/.well-known/openid-configuration`) return ok({ jwks_uri: JWKS_URI })
    if (url === JWKS_URI) return ok({ keys: KEYS })
    return notFound()
  })
}

describe('discoverJwksUri', () => {
  it('reads jwks_uri from the discovery document', async () => {
    expect(await discoverJwksUri(ISS, mockFetch())).toBe(JWKS_URI)
  })
  it('tolerates a trailing slash on the issuer', async () => {
    const f = mockFetch()
    await discoverJwksUri(`${ISS}/`, f)
    expect(f).toHaveBeenCalledWith(`${ISS}/.well-known/openid-configuration`)
  })
  it('throws when discovery fails', async () => {
    await expect(discoverJwksUri('https://nope.example', mockFetch())).rejects.toThrow()
  })

  it('rejects a non-HTTPS jwks_uri (no downgrade)', async () => {
    const f = vi.fn(async () => ok({ jwks_uri: 'http://accounts.google.com/certs' }))
    await expect(discoverJwksUri(ISS, f)).rejects.toThrow(/https/)
  })

  it('allows a cross-origin HTTPS jwks_uri (Google uses www.googleapis.com)', async () => {
    expect(await discoverJwksUri(ISS, mockFetch())).toBe(JWKS_URI) // googleapis.com ≠ accounts.google.com
  })
})

describe('fetchJwks', () => {
  it('returns the keys array', async () => {
    expect(await fetchJwks(JWKS_URI, mockFetch())).toEqual(KEYS)
  })
  it('throws when the body has no keys[]', async () => {
    await expect(fetchJwks(JWKS_URI, vi.fn(async () => ok({})))).rejects.toThrow()
  })
})

describe('createJwksResolver (discovery + TTL cache)', () => {
  it('caches within the TTL (one discovery + one jwks fetch), refetches after', async () => {
    const f = mockFetch()
    let t = 1000
    const r = createJwksResolver({ fetch: f, now: () => t, ttlMs: 5000 })

    expect(await r.resolve(ISS)).toEqual(KEYS)
    expect(f).toHaveBeenCalledTimes(2) // discovery + jwks

    await r.resolve(ISS) // cached
    expect(f).toHaveBeenCalledTimes(2)

    t += 6000 // past TTL
    await r.resolve(ISS)
    expect(f).toHaveBeenCalledTimes(4) // refetched
  })

  it('invalidate() forces a refetch', async () => {
    const f = mockFetch()
    const r = createJwksResolver({ fetch: f, now: () => 0, ttlMs: 1_000_000 })
    await r.resolve(ISS)
    expect(f).toHaveBeenCalledTimes(2)
    r.invalidate(ISS)
    await r.resolve(ISS)
    expect(f).toHaveBeenCalledTimes(4)
  })
})
