import { describe, it, expect } from 'vitest'
import { OTP_MAX_ATTEMPTS, OTP_TTL_SEC, checkOtp, hashOtp, newOtpCode, newSalt, type OtpRecord } from './emailOtp'

const NOW = 1_000_000

const recordFor = async (code: string, over: Partial<OtpRecord> = {}): Promise<OtpRecord> => {
  const salt = newSalt()
  return {
    codeHash: await hashOtp(code, salt),
    salt,
    email: 'alice@acme.com',
    room: 'standup',
    nonce: 'NONCE',
    exp: NOW + OTP_TTL_SEC,
    attempts: 0,
    ...over,
  }
}

describe('newOtpCode — 6 uniform digits', () => {
  it('is always exactly 6 digits', () => {
    for (let i = 0; i < 200; i++) expect(newOtpCode()).toMatch(/^\d{6}$/)
  })
  it('is not trivially constant (draws vary)', () => {
    const seen = new Set(Array.from({ length: 50 }, () => newOtpCode()))
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('newSalt / hashOtp', () => {
  it('hash is deterministic for the same code+salt, and salted', async () => {
    const salt = newSalt()
    expect(await hashOtp('123456', salt)).toBe(await hashOtp('123456', salt))
    expect(await hashOtp('123456', salt)).not.toBe(await hashOtp('123456', newSalt()))
    expect(await hashOtp('123456', salt)).not.toBe(await hashOtp('654321', salt))
  })
  it('does not store the plaintext code anywhere in the hash', async () => {
    expect(await hashOtp('123456', newSalt())).not.toContain('123456')
  })
})

describe('checkOtp', () => {
  it('accepts the right code before expiry, under the attempt cap', async () => {
    const rec = await recordFor('123456')
    expect(await checkOtp('123456', rec, NOW)).toEqual({ ok: true })
  })
  it('rejects a wrong code as a mismatch', async () => {
    const rec = await recordFor('123456')
    expect(await checkOtp('000000', rec, NOW)).toEqual({ ok: false, reason: 'mismatch' })
  })
  it('rejects once expired', async () => {
    const rec = await recordFor('123456', { exp: NOW - 1 })
    expect(await checkOtp('123456', rec, NOW)).toEqual({ ok: false, reason: 'expired' })
  })
  it('locks out once attempts hit the cap (even with the right code)', async () => {
    const rec = await recordFor('123456', { attempts: OTP_MAX_ATTEMPTS })
    expect(await checkOtp('123456', rec, NOW)).toEqual({ ok: false, reason: 'locked' })
  })
})
