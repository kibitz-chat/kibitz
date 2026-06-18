import { describe, expect, it } from 'vitest'
import { bindingMatches, canonicalFingerprint, nonceForFingerprint } from './oidcBinding'

const FP = 'ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89'

describe('canonicalFingerprint', () => {
  it('lowercases and trims so both sides agree regardless of source casing', () => {
    expect(canonicalFingerprint('  AB:CD:EF  ')).toBe('ab:cd:ef')
    expect(canonicalFingerprint('ab:cd:ef')).toBe('ab:cd:ef')
  })
})

describe('nonceForFingerprint', () => {
  it('is deterministic and case-insensitive (uppercase cert FP → same nonce)', async () => {
    expect(await nonceForFingerprint(FP)).toBe(await nonceForFingerprint(FP.toUpperCase()))
  })

  it('differs for a different fingerprint', async () => {
    const other = FP.replace(/^ab/, 'cd')
    expect(await nonceForFingerprint(FP)).not.toBe(await nonceForFingerprint(other))
  })

  it('differs when salted (room-scoped) vs unsalted, and per salt', async () => {
    const base = await nonceForFingerprint(FP)
    const room = await nonceForFingerprint(FP, 'room-1')
    expect(room).not.toBe(base)
    expect(room).not.toBe(await nonceForFingerprint(FP, 'room-2'))
  })

  it('produces a url-safe base64 string (no +/= chars)', async () => {
    expect(await nonceForFingerprint(FP)).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('bindingMatches', () => {
  it('matches the cert the token was minted for', async () => {
    const nonce = await nonceForFingerprint(FP)
    expect(await bindingMatches(nonce, FP)).toBe(true)
    expect(await bindingMatches(nonce, FP.toUpperCase())).toBe(true) // canonicalised
  })

  it('rejects a token replayed against a DIFFERENT peer cert', async () => {
    const aliceNonce = await nonceForFingerprint(FP)
    const malloryFp = FP.replace(/^ab/, 'ff')
    expect(await bindingMatches(aliceNonce, malloryFp)).toBe(false)
  })

  it('rejects when salt (room) differs', async () => {
    const nonce = await nonceForFingerprint(FP, 'room-1')
    expect(await bindingMatches(nonce, FP, 'room-2')).toBe(false)
    expect(await bindingMatches(nonce, FP, 'room-1')).toBe(true)
  })

  it('rejects missing/empty inputs', async () => {
    expect(await bindingMatches(undefined, FP)).toBe(false)
    expect(await bindingMatches(await nonceForFingerprint(FP), '')).toBe(false)
  })
})
