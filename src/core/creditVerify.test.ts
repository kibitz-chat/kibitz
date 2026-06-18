import { beforeAll, describe, expect, it } from 'vitest'
import { bytesToB64url, type Jwk } from './oidcVerify'
import { verifyCreditCredential } from './creditVerify'

// --- a mock credit issuer: a real RSA keypair, real RS256 signatures, real JWKS ----------
const enc = new TextEncoder()
const ISS = 'https://issuer.example.com'
const KID = 'cred-key-1'
const NOW = 1_900_000_000 // fixed "current time" (epoch seconds)

let priv: CryptoKey
let jwks: Jwk[]

async function mint(claims: Record<string, unknown>, opts?: { alg?: string; kid?: string | null; key?: CryptoKey }) {
  const header: Record<string, unknown> = { alg: opts?.alg ?? 'RS256', typ: 'JWT' }
  if (opts?.kid !== null) header.kid = opts?.kid ?? KID
  const h = bytesToB64url(enc.encode(JSON.stringify(header)))
  const p = bytesToB64url(enc.encode(JSON.stringify(claims)))
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, opts?.key ?? priv, enc.encode(`${h}.${p}`)))
  return `${h}.${p}.${bytesToB64url(sig)}`
}

const goodClaims = (): Record<string, unknown> => ({
  iss: ISS,
  sub: 'kibitzer',
  room: 'lunar-comet',
  iat: NOW - 5,
  nbf: NOW - 5,
  exp: NOW + 60,
  k: 'wbz-credit.v1',
})

beforeAll(async () => {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  priv = kp.privateKey
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as Jwk
  jwks = [{ kty: 'RSA', n: jwk.n, e: jwk.e, kid: KID, alg: 'RS256', use: 'sig' }]
})

const verify = (jwt: string, over?: Partial<Parameters<typeof verifyCreditCredential>[1]>) =>
  verifyCreditCredential(jwt, { jwks, issuer: ISS, now: NOW, ...over })

describe('verifyCreditCredential', () => {
  it('accepts a valid credential and returns agentId + exp + room', async () => {
    const r = await verify(await mint(goodClaims()))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.agentId).toBe('kibitzer')
      expect(r.exp).toBe(NOW + 60)
      expect(r.room).toBe('lunar-comet')
    }
  })

  it('rejects a tampered payload (signature no longer matches)', async () => {
    const [h, , s] = (await mint(goodClaims())).split('.')
    const tampered = bytesToB64url(enc.encode(JSON.stringify({ ...goodClaims(), sub: 'evil' })))
    expect((await verify(`${h}.${tampered}.${s}`)).ok).toBe(false)
  })

  it('rejects alg:none (unsigned)', async () => {
    const h = bytesToB64url(enc.encode(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID })))
    const p = bytesToB64url(enc.encode(JSON.stringify(goodClaims())))
    const r = await verify(`${h}.${p}.`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/alg/)
  })

  it('rejects HS256 (alg-confusion — never treat the key as a symmetric secret)', async () => {
    expect((await verify(await mint(goodClaims(), { alg: 'HS256' }))).ok).toBe(false)
  })

  it('rejects an unknown kid (fail closed)', async () => {
    const r = await verify(await mint(goodClaims(), { kid: 'rotated-away' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/kid/)
  })

  it("rejects a credential signed by a key that isn't in the JWKS", async () => {
    const other = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )
    const r = await verify(await mint(goodClaims(), { key: other.privateKey }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('bad signature')
  })

  it('rejects an expired credential (past exp + leeway)', async () => {
    const r = await verify(await mint({ ...goodClaims(), exp: NOW - 120 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('expired')
  })

  it('honours leeway around exp (a slightly-late renewal still verifies)', async () => {
    const jwt = await mint({ ...goodClaims(), exp: NOW - 30 })
    expect((await verify(jwt, { leewaySec: 60 })).ok).toBe(true)
    expect((await verify(jwt, { leewaySec: 0 })).ok).toBe(false)
  })

  it('rejects a credential issued in the future (clock skew / forged iat)', async () => {
    const r = await verify(await mint({ ...goodClaims(), iat: NOW + 3600 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/future/)
  })

  it('rejects the wrong issuer', async () => {
    const r = await verify(await mint({ ...goodClaims(), iss: 'https://evil.example' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/iss/)
  })

  it('rejects a missing sub (no agent id)', async () => {
    const c = goodClaims()
    delete c.sub
    const r = await verify(await mint(c))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('no sub')
  })

  it('enforces the kind tag when configured (defence in depth)', async () => {
    expect((await verify(await mint(goodClaims()), { kind: 'wbz-credit.v1' })).ok).toBe(true)
    const r = await verify(await mint({ ...goodClaims(), k: 'something-else' }), { kind: 'wbz-credit.v1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/kind/)
  })

  it('accepts the issuer given as a list', async () => {
    const r = await verify(await mint(goodClaims()), { issuer: ['https://other.example', ISS] })
    expect(r.ok).toBe(true)
  })
})
