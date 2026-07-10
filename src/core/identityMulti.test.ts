import { describe, it, expect } from 'vitest'
import { peekIssuer, verifyPeerMulti, type AcceptedProvider } from './identity'
import { exportPublicJwk, generateSigningKey, signEmailToken } from './emailToken'
import { nonceForFingerprint } from './oidcBinding'

const NOW = 2_000_000
const EMAIL_ISS = 'https://email.kibitz.chat'
const EMAIL_AUD = 'kibitz-email'

describe('peekIssuer', () => {
  it('reads iss without verifying; null on junk', async () => {
    const kp = await generateSigningKey()
    const pub = await exportPublicJwk(kp.publicKey)
    const jwt = await signEmailToken(
      kp.privateKey,
      { iss: EMAIL_ISS, aud: EMAIL_AUD, email: 'a@b.com', nonce: 'N', sub: 'a@b.com', iat: NOW, exp: NOW + 600 },
      pub.kid,
    )
    expect(peekIssuer(jwt)).toBe(EMAIL_ISS)
    expect(peekIssuer('not.a.jwt')).toBeNull()
    expect(peekIssuer('x')).toBeNull()
  })
})

describe('verifyPeerMulti — route by issuer', () => {
  it('routes an email-code token to its provider and verifies it cert-bound', async () => {
    const kp = await generateSigningKey()
    const pub = await exportPublicJwk(kp.publicKey)
    const fp = 'AA:BB'
    const nonce = await nonceForFingerprint(fp, 'standup')
    const jwt = await signEmailToken(
      kp.privateKey,
      { iss: EMAIL_ISS, aud: EMAIL_AUD, email: 'bob@acme.com', nonce, sub: 'bob@acme.com', iat: NOW, exp: NOW + 600 },
      pub.kid,
    )
    const providers: AcceptedProvider[] = [
      { issuer: 'https://accounts.google.com', audience: 'goog', resolveJwks: async () => [] }, // wrong provider
      { issuer: EMAIL_ISS, audience: EMAIL_AUD, resolveJwks: async () => [pub] }, // the right one
    ]
    const r = await verifyPeerMulti({ jwt, remoteFp: fp, providers, now: NOW, salt: 'standup' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.identity.email).toBe('bob@acme.com')
  })

  it('rejects a token whose issuer is not in the accepted list', async () => {
    const kp = await generateSigningKey()
    const pub = await exportPublicJwk(kp.publicKey)
    const jwt = await signEmailToken(
      kp.privateKey,
      { iss: 'https://evil.example', aud: EMAIL_AUD, email: 'a@b.com', nonce: 'N', sub: 'a@b.com', iat: NOW, exp: NOW + 600 },
      pub.kid,
    )
    const providers: AcceptedProvider[] = [{ issuer: EMAIL_ISS, audience: EMAIL_AUD, resolveJwks: async () => [pub] }]
    const r = await verifyPeerMulti({ jwt, remoteFp: 'AA:BB', providers, now: NOW, salt: 'standup' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('untrusted issuer')
  })
})
