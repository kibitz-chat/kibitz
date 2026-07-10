import { describe, expect, it } from 'vitest'
import { encryptManifest, decryptManifest } from './gateSecret'

// Layer 2: seal a verified-room manifest under an out-of-band group passphrase, so a link-holder
// WITHOUT the passphrase (and the web host) sees only ciphertext. A member with the passphrase
// decrypts to the original token, which verifies exactly as before.

const TOKEN = 'eyJtZW1iZXJzIjpbImFsaWNlQGFjbWUuY29tIl19.c2lnbmF0dXJl' // a manifest-token-shaped string

describe('gateSecret — passphrase-sealed manifest (AES-GCM / PBKDF2)', () => {
  it('round-trips: decrypt with the right passphrase returns the original token', async () => {
    const blob = await encryptManifest(TOKEN, 'open-sesame')
    expect(blob).not.toContain(TOKEN.slice(0, 12)) // the token is not recoverable from the blob text
    expect(await decryptManifest(blob, 'open-sesame')).toBe(TOKEN)
  })

  it('a WRONG passphrase fails closed (null), not a throw or garbage', async () => {
    const blob = await encryptManifest(TOKEN, 'correct horse')
    expect(await decryptManifest(blob, 'battery staple')).toBeNull()
  })

  it('a TAMPERED blob fails closed (GCM auth) — no malleability', async () => {
    const blob = await encryptManifest(TOKEN, 'pw')
    // flip a character near the end (ciphertext/tag region)
    const tampered = blob.slice(0, -2) + (blob.slice(-2, -1) === 'A' ? 'B' : 'A') + blob.slice(-1)
    expect(await decryptManifest(tampered, 'pw')).toBeNull()
  })

  it('malformed / empty input returns null, never throws', async () => {
    expect(await decryptManifest('', 'pw')).toBeNull()
    expect(await decryptManifest('not-base64!!', 'pw')).toBeNull()
    expect(await decryptManifest('AAAA', 'pw')).toBeNull() // too short to hold salt+iv+tag
  })

  it('is non-deterministic — the same token+passphrase seals differently each time (random salt+iv)', async () => {
    const a = await encryptManifest(TOKEN, 'pw')
    const b = await encryptManifest(TOKEN, 'pw')
    expect(a).not.toBe(b)
    expect(await decryptManifest(a, 'pw')).toBe(TOKEN)
    expect(await decryptManifest(b, 'pw')).toBe(TOKEN)
  })

  it('seals NEW blobs at the current version (v2 = 600k iters — byte 0)', async () => {
    const blob = await encryptManifest(TOKEN, 'pw')
    const versionByte = atob(blob.replace(/-/g, '+').replace(/_/g, '/')).charCodeAt(0)
    expect(versionByte).toBe(2)
  })

  it('BACKWARD-COMPAT: an already-minted v1 (210k) blob still decrypts by its embedded version', async () => {
    // A REAL blob sealed by the pre-bump code (byte 0 = 0x01 = v1, 210k iters). Decrypt must dispatch the work
    // factor on the version byte, or every already-shared link (and v1-sealed host key) would stop opening.
    const V1_GOLDEN = 'AQrktPg5INXDXUCOvla1khfqwF_h9_Y60OIkKPUXN91LDxmGwIstc6kDuKPXMvqooLFur0J4QTvuHadL7fUPjKc'
    expect(await decryptManifest(V1_GOLDEN, 'v1-golden-pass')).toBe('conformance-token-v1')
    expect(await decryptManifest(V1_GOLDEN, 'wrong-pass')).toBeNull() // still fails closed on a wrong passphrase
  })

  it('an UNKNOWN version byte fails closed (null)', async () => {
    const blob = await encryptManifest(TOKEN, 'pw')
    const raw = Uint8Array.from(atob(blob.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    raw[0] = 99 // a version we don't know how to derive
    const munged = btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(await decryptManifest(munged, 'pw')).toBeNull()
  })

  it('normalizes the passphrase (NFKC) so visually-identical secrets agree across input methods', async () => {
    // 'é' as one codepoint (U+00E9) vs 'e' + combining accent (U+0065 U+0301) → same after NFKC
    const blob = await encryptManifest(TOKEN, 'café')
    expect(await decryptManifest(blob, 'café')).toBe(TOKEN)
  })
})
