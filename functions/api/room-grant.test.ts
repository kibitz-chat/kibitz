import { describe, it, expect } from 'vitest'
import { onRequestPost } from './room-grant'

// A minimal fake ENTITLEMENTS KV with one active license. The endpoint is otherwise pure WebCrypto.
function fakeEnv() {
  const store: Record<string, unknown> = { 'lic:goodkey': { status: 'active' } }
  return {
    ENTITLEMENTS: {
      get: async (k: string) => store[k] ?? null,
      put: async () => {},
      delete: async () => {},
    },
    ROOM_GRANT_SECRET: 'test-secret',
  }
}

const call = (room: unknown, key: string | null = 'goodkey') =>
  onRequestPost({
    request: new Request('https://kibitz.chat/api/room-grant', {
      method: 'POST',
      headers: key ? { authorization: `Bearer ${key}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
      body: JSON.stringify({ room }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: fakeEnv() as any,
  })

describe('POST /api/room-grant — room validation (review 2026-06-17)', () => {
  it('rejects an over-long room (KV-key 512-byte limit + grant-bloat guard)', async () => {
    const r = await call('a'.repeat(201))
    expect(r.status).toBe(400)
  })

  it('rejects an exotic-charset room (spaces / punctuation)', async () => {
    expect((await call('bad room!')).status).toBe(400)
    expect((await call('🙂'.repeat(3))).status).toBe(400)
  })

  it('mints a signed grant for a normal room id', async () => {
    const r = await call('tidal-3pu4s1ghy1')
    expect(r.status).toBe(200)
    const body = (await r.json()) as { grant?: string; exp?: number }
    expect(typeof body.grant).toBe('string')
    expect(body.grant).toContain('.') // <b64url(json)>.<b64url(hmac)>
  })

  it('still requires a license key (no auth → 401)', async () => {
    expect((await call('tidal-3pu4s1ghy1', null)).status).toBe(401)
  })

  it('still rejects an empty room (400)', async () => {
    expect((await call('')).status).toBe(400)
  })
})
