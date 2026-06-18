import { describe, it, expect } from 'vitest'
import { exportPublicJwk, generateSigningKey, importSigningKey, signEmailToken } from './emailToken'
import { verifyIdToken } from './oidcVerify'
import { verifyPeerIdentity } from './identity'
import { nonceForFingerprint } from './oidcBinding'

const NOW = 2_000_000
const ISS = 'https://email.kibitz.chat'
const AUD = 'kibitz-email'

describe('emailToken — RS256 token the existing OIDC verifier accepts', () => {
  it('round-trips: sign → verifyIdToken OK with the published JWKS', async () => {
    const kp = await generateSigningKey()
    const pub = await exportPublicJwk(kp.publicKey)
    const jwt = await signEmailToken(
      kp.privateKey,
      { iss: ISS, aud: AUD, email: 'alice@acme.com', nonce: 'N', sub: 'alice@acme.com', iat: NOW, exp: NOW + 600 },
      pub.kid,
    )
    const r = await verifyIdToken(jwt, { jwks: [pub], issuer: ISS, audience: AUD, now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.claims.email).toBe('alice@acme.com')
      expect(r.claims.email_verified).toBe(true)
    }
  })

  it('is rejected by a DIFFERENT key (forgery) and a wrong audience', async () => {
    const kp = await generateSigningKey()
    const other = await generateSigningKey()
    const pub = await exportPublicJwk(kp.publicKey)
    const otherPub = await exportPublicJwk(other.publicKey)
    const jwt = await signEmailToken(
      kp.privateKey,
      { iss: ISS, aud: AUD, email: 'a@b.com', nonce: 'N', sub: 'a@b.com', iat: NOW, exp: NOW + 600 },
      pub.kid,
    )
    expect((await verifyIdToken(jwt, { jwks: [otherPub], issuer: ISS, audience: AUD, now: NOW })).ok).toBe(false) // forged
    expect((await verifyIdToken(jwt, { jwks: [pub], issuer: ISS, audience: 'other', now: NOW })).ok).toBe(false) // wrong aud
  })

  it('importSigningKey (the Worker path): load a stored private JWK → sign → verify; kid is stable', async () => {
    const kp = await generateSigningKey()
    const privJwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey
    const loaded = await importSigningKey(privJwk)
    const directPub = await exportPublicJwk(kp.publicKey)
    expect(loaded.kid).toBe(directPub.kid) // the served JWKS kid matches the token's kid
    const jwt = await signEmailToken(
      loaded.key,
      { iss: ISS, aud: AUD, email: 'c@d.com', nonce: 'N', sub: 'c@d.com', iat: NOW, exp: NOW + 600 },
      loaded.kid,
    )
    const r = await verifyIdToken(jwt, { jwks: [loaded.publicJwk], issuer: ISS, audience: AUD, now: NOW })
    expect(r.ok).toBe(true)
  })

  it('verifies end to end as a cert-bound peer identity (nonce == hash(fingerprint))', async () => {
    const kp = await generateSigningKey()
    const pub = await exportPublicJwk(kp.publicKey)
    const fp = 'AA:BB:CC' // the DTLS fingerprint this side handshook with
    const nonce = await nonceForFingerprint(fp, 'standup')
    const jwt = await signEmailToken(
      kp.privateKey,
      { iss: ISS, aud: AUD, email: 'bob@acme.com', nonce, sub: 'bob@acme.com', iat: NOW, exp: NOW + 600 },
      pub.kid,
    )
    const v = await verifyPeerIdentity({ jwt, remoteFp: fp, audience: AUD, issuer: ISS, jwks: [pub], now: NOW, salt: 'standup' })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.identity.email).toBe('bob@acme.com')
    // a token bound to a DIFFERENT fingerprint must fail the binding
    const bad = await verifyPeerIdentity({ jwt, remoteFp: 'ZZ:ZZ', audience: AUD, issuer: ISS, jwks: [pub], now: NOW, salt: 'standup' })
    expect(bad.ok).toBe(false)
  })
})
