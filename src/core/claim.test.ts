import { describe, it, expect } from 'vitest'
import { readClaim, claimLabel, claimMeta } from './claim'

describe('readClaim — self-asserted claim off participant meta', () => {
  it('reads an email claim (trimmed)', () => {
    expect(readClaim({ claim: { kind: 'email', email: '  alice@acme.com ' } })).toEqual({ kind: 'email', email: 'alice@acme.com' })
  })
  it('reads a guest claim', () => {
    expect(readClaim({ claim: { kind: 'guest' } })).toEqual({ kind: 'guest' })
  })
  it('returns null for no / malformed claim', () => {
    expect(readClaim(undefined)).toBeNull()
    expect(readClaim({})).toBeNull()
    expect(readClaim({ claim: { kind: 'email' } })).toBeNull() // no email
    expect(readClaim({ claim: { kind: 'email', email: '' } })).toBeNull()
    expect(readClaim({ claim: 'nope' })).toBeNull()
    expect(readClaim({ claim: { kind: 'other' } })).toBeNull()
  })
  it('round-trips through claimMeta', () => {
    expect(readClaim(claimMeta({ kind: 'email', email: 'a@b.com' }))).toEqual({ kind: 'email', email: 'a@b.com' })
    expect(readClaim(claimMeta(null))).toBeNull()
  })
  it('labels a claim (guest vs not-verified)', () => {
    expect(claimLabel({ kind: 'guest' })).toMatch(/guest/i)
    expect(claimLabel({ kind: 'email', email: 'a@b.com' })).toMatch(/not verified/i)
  })
})
