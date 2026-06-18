import { beforeAll, describe, expect, it } from 'vitest'
import { b64urlToBytes, bytesToB64url, type Jwk, verifyIdToken } from './oidcVerify'

// --- a mock OIDC issuer: a real RSA keypair, real RS256 signatures, real JWKS ------
const enc = new TextEncoder()
const ISS = 'https://accounts.google.com'
const AUD = 'client-123.apps.googleusercontent.com'
const KID = 'test-key-1'
const NOW = 1_900_000_000 // fixed "current time" (epoch seconds)

let priv: CryptoKey
let pubJwk: Jwk
let jwks: Jwk[]

async function mint(claims: Record<string, unknown>, opts?: { alg?: string; kid?: string | null; key?: CryptoKey }) {
  const header: Record<string, unknown> = { alg: opts?.alg ?? 'RS256', typ: 'JWT' }
  if (opts?.kid !== null) header.kid = opts?.kid ?? KID
  const h = bytesToB64url(enc.encode(JSON.stringify(header)))
  const p = bytesToB64url(enc.encode(JSON.stringify(claims)))
  const signingInput = enc.encode(`${h}.${p}`)
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, opts?.key ?? priv, signingInput),
  )
  return `${h}.${p}.${bytesToB64url(sig)}`
}

const goodClaims = () => ({
  iss: ISS,
  aud: AUD,
  sub: 'user-abc',
  exp: NOW + 3600,
  iat: NOW - 10,
  email: 'alice@acme.com',
  email_verified: true,
  nonce: 'bound-nonce',
})

beforeAll(async () => {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  priv = kp.privateKey
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as Jwk
  pubJwk = { kty: 'RSA', n: jwk.n, e: jwk.e, kid: KID, alg: 'RS256', use: 'sig' }
  jwks = [pubJwk]
})

const verify = (jwt: string, over?: Partial<Parameters<typeof verifyIdToken>[1]>) =>
  verifyIdToken(jwt, { jwks, issuer: ISS, audience: AUD, now: NOW, ...over })

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    expect([...b64urlToBytes(bytesToB64url(bytes))]).toEqual([...bytes])
  })
})

describe('verifyIdToken', () => {
  it('accepts a valid token and returns the claims', async () => {
    const r = await verify(await mint(goodClaims()))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.claims.email).toBe('alice@acme.com')
      expect(r.claims.nonce).toBe('bound-nonce')
      expect(r.claims.sub).toBe('user-abc')
    }
  })

  it('rejects a tampered payload (signature no longer matches)', async () => {
    const jwt = await mint(goodClaims())
    const [h, p, s] = jwt.split('.')
    // Flip the email in the payload without re-signing.
    const tampered = bytesToB64url(enc.encode(JSON.stringify({ ...goodClaims(), email: 'attacker@evil.com' })))
    expect((await verify(`${h}.${tampered}.${s}`)).ok).toBe(false)
    expect(p).not.toBe(tampered)
  })

  it('rejects alg:none (unsigned)', async () => {
    const h = bytesToB64url(enc.encode(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID })))
    const p = bytesToB64url(enc.encode(JSON.stringify(goodClaims())))
    const r = await verify(`${h}.${p}.`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/alg/)
  })

  it('rejects HS256 (alg-confusion — never treat the key as a symmetric secret)', async () => {
    const r = await verify(await mint(goodClaims(), { alg: 'HS256' }))
    expect(r.ok).toBe(false)
  })

  it('rejects an expired token', async () => {
    const r = await verify(await mint({ ...goodClaims(), exp: NOW - 3600 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('expired')
  })

  it('rejects a not-yet-valid token (nbf in the future)', async () => {
    const r = await verify(await mint({ ...goodClaims(), nbf: NOW + 3600 }))
    expect(r.ok).toBe(false)
  })

  it('rejects the wrong audience', async () => {
    const r = await verify(await mint({ ...goodClaims(), aud: 'someone-else.apps.googleusercontent.com' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('bad aud')
  })

  it('rejects the wrong issuer', async () => {
    const r = await verify(await mint({ ...goodClaims(), iss: 'https://evil.example' }))
    expect(r.ok).toBe(false)
  })

  it('accepts aud as an array that includes our client_id', async () => {
    const r = await verify(await mint({ ...goodClaims(), aud: [AUD, 'other'] }))
    expect(r.ok).toBe(true)
  })

  it('rejects an unknown kid (fail closed)', async () => {
    const r = await verify(await mint(goodClaims(), { kid: 'rotated-away' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/kid/)
  })

  it("rejects a token signed by a key that isn't in the JWKS", async () => {
    const other = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )
    const r = await verify(await mint(goodClaims(), { key: other.privateKey }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('bad signature')
  })

  it('accepts both Google issuer spellings when issuer is a list', async () => {
    const r = await verify(await mint({ ...goodClaims(), iss: 'accounts.google.com' }), {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
    })
    expect(r.ok).toBe(true)
  })

  it('honours leeway around exp', async () => {
    const jwt = await mint({ ...goodClaims(), exp: NOW - 30 }) // 30s ago
    expect((await verify(jwt, { leewaySec: 60 })).ok).toBe(true) // within leeway
    expect((await verify(jwt, { leewaySec: 0 })).ok).toBe(false) // strict
  })

  it('rejects a token issued in the future (clock skew / forged iat)', async () => {
    const r = await verify(await mint({ ...goodClaims(), iat: NOW + 3600 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/future/)
  })

  it('rejects an over-age token only when maxAgeSec is set', async () => {
    const jwt = await mint({ ...goodClaims(), iat: NOW - 7200, exp: NOW + 3600 }) // old iat, still valid exp
    expect((await verify(jwt)).ok).toBe(true) // no maxAgeSec → iat age ignored
    const r = await verify(jwt, { maxAgeSec: 3700 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('token too old')
  })
})
