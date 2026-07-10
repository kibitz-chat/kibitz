import { describe, it, expect } from 'vitest'
import { prfSecretToMemKey, passkeySupported } from './passkeyKey'

// The WebAuthn ceremonies need a real authenticator (verified on-device). Here we lock the PURE crypto contract:
// mk = base64url(first 32 bytes of the prf secret) — must be deterministic so re-derivation matches the commitment.
describe('passkeyKey (pure)', () => {
  it('prfSecretToMemKey = base64url of the first 32 bytes, deterministic', () => {
    const secret = new Uint8Array(32)
    for (let i = 0; i < 32; i++) secret[i] = i
    const mk = prfSecretToMemKey(secret)
    expect(mk).toBe(prfSecretToMemKey(secret)) // deterministic
    expect(mk).toMatch(/^[A-Za-z0-9_-]+$/) // base64url, no padding
    expect(mk).not.toContain('=')
    // accepts an ArrayBuffer too, and truncates >32 bytes to 32
    const big = new Uint8Array(64).fill(7)
    expect(prfSecretToMemKey(big.buffer)).toBe(prfSecretToMemKey(big.slice(0, 32)))
  })

  it('passkeySupported is false in a non-browser env (no window) and never throws', () => {
    expect(passkeySupported()).toBe(false)
  })
})
