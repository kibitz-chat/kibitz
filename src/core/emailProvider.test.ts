import { describe, it, expect, vi, afterEach } from 'vitest'
import { startEmailVerify, submitEmailCode } from './emailProvider'

afterEach(() => vi.unstubAllGlobals())

const stubFetch = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })))

describe('email provider network calls', () => {
  it('startEmailVerify posts and returns the ticket', async () => {
    stubFetch(200, { ok: true, ticket: 'abc123' })
    const r = await startEmailVerify('', { email: 'a@b.com', room: 'r', nonce: 'n' })
    expect(r).toEqual({ ok: true, ticket: 'abc123' })
  })
  it('submitEmailCode posts and returns the jwt', async () => {
    stubFetch(200, { ok: true, jwt: 'eyJ.x.y' })
    const r = await submitEmailCode('', { ticket: 't', code: '123456' })
    expect(r.ok).toBe(true)
    expect(r.jwt).toBe('eyJ.x.y')
  })
  it('surfaces a dormant backend and network errors gracefully', async () => {
    stubFetch(200, { configured: false })
    expect((await startEmailVerify('', { email: 'a@b.com', room: 'r', nonce: 'n' })).configured).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    expect((await submitEmailCode('', { ticket: 't', code: '1' })).reason).toBe('network')
  })
})
