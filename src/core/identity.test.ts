import { beforeAll, describe, expect, it } from 'vitest'
import { nonceForFingerprint } from './oidcBinding'
import { bytesToB64url, type Jwk } from './oidcVerify'
import { verifyPeerIdentity } from './identity'

// Reuse the mock-issuer pattern from oidcVerify.test, plus a cert-bound nonce.
const enc = new TextEncoder()
const ISS = 'https://accounts.google.com'
const AUD = 'client-123.apps.googleusercontent.com'
const KID = 'k1'
const NOW = 1_900_000_000
const FP = 'ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89'

let priv: CryptoKey
let jwks: Jwk[]

async function mint(claims: Record<string, unknown>) {
  const h = bytesToB64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID })))
  const p = bytesToB64url(enc.encode(JSON.stringify(claims)))
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, priv, enc.encode(`${h}.${p}`)))
  return `${h}.${p}.${bytesToB64url(sig)}`
}

async function token(over: Record<string, unknown> = {}, fp = FP, salt?: string) {
  return mint({
    iss: ISS,
    aud: AUD,
    sub: 'user-abc',
    exp: NOW + 3600,
    email: 'alice@acme.com',
    email_verified: true,
    name: 'Alice',
    nonce: await nonceForFingerprint(fp, salt),
    ...over,
  })
}

const verify = (jwt: string, over?: { remoteFp?: string; salt?: string }) =>
  verifyPeerIdentity({ jwt, remoteFp: over?.remoteFp ?? FP, audience: AUD, issuer: ISS, jwks, now: NOW, salt: over?.salt })

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

describe('verifyPeerIdentity (L3 composition)', () => {
  it('accepts a valid, email-verified, correctly-bound token', async () => {
    const r = await verify(await token())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.identity.email).toBe('alice@acme.com')
      expect(r.identity.name).toBe('Alice')
      expect(r.identity.sub).toBe('user-abc')
    }
  })

  it('REJECTS a token replayed against a different peer cert (the core L3 guarantee)', async () => {
    // Alice's real token, but presented over Mallory's connection (different cert FP).
    const malloryFp = FP.replace(/^ab/, 'ff')
    const r = await verify(await token(), { remoteFp: malloryFp })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/binding/)
  })

  it('rejects an unverified email even if signature + binding are fine', async () => {
    const r = await verify(await token({ email_verified: false }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/email/)
  })

  it('rejects a token with no email', async () => {
    const r = await verify(await token({ email: undefined }))
    expect(r.ok).toBe(false)
  })

  it('rejects an expired token (delegates to verifyIdToken)', async () => {
    const r = await verify(await token({ exp: NOW - 3600 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('expired')
  })

  it('honours the room salt: a token bound for room-1 fails in room-2', async () => {
    const jwt = await token({}, FP, 'room-1')
    expect((await verify(jwt, { salt: 'room-1' })).ok).toBe(true)
    expect((await verify(jwt, { salt: 'room-2' })).ok).toBe(false)
  })

  it('surfaces the Workspace hosted domain (hd) for domain gating', async () => {
    const r = await verify(await token({ hd: 'acme.com' }))
    expect(r.ok && r.identity.hd).toBe('acme.com')
  })
})
