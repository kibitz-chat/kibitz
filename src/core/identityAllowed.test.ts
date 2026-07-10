import { describe, expect, it } from 'vitest'
import { addAllowedEmail, identityAllowed } from './identity'
import type { VerifiedIdentity } from './identity'

const id = (email: string, hd?: string): VerifiedIdentity => ({ email, emailVerified: true, sub: 's', iss: 'x', hd })

describe('identityAllowed', () => {
  it('allows any verified identity when no domains are set', () => {
    expect(identityAllowed(id('a@anywhere.com'))).toBe(true)
    expect(identityAllowed(id('a@anywhere.com'), [])).toBe(true)
    expect(identityAllowed(id('a@anywhere.com'), ['  '])).toBe(true) // all-blank → no restriction
  })

  it('matches the email domain (case-insensitive, tolerates a leading @)', () => {
    expect(identityAllowed(id('alice@acme.com'), ['acme.com'])).toBe(true)
    expect(identityAllowed(id('Alice@ACME.com'), ['acme.com'])).toBe(true)
    expect(identityAllowed(id('alice@acme.com'), ['@acme.com'])).toBe(true)
    expect(identityAllowed(id('alice@acme.com'), ['other.com', 'acme.com'])).toBe(true)
  })

  it('rejects a domain not in the list', () => {
    expect(identityAllowed(id('alice@example.com'), ['acme.com'])).toBe(false)
    expect(identityAllowed(id('alice@notacme.com'), ['acme.com'])).toBe(false)
  })

  it('matches the Google Workspace hd claim even if the email domain differs', () => {
    // Workspace accounts can have a vanity email but an hd of the org domain.
    expect(identityAllowed(id('alice@aliasmail.com', 'acme.com'), ['acme.com'])).toBe(true)
  })

  it('is not fooled by a substring or suffix trick', () => {
    expect(identityAllowed(id('alice@evilacme.com'), ['acme.com'])).toBe(false)
    expect(identityAllowed(id('alice@acme.com.evil.com'), ['acme.com'])).toBe(false)
  })

  describe('allowedEmails — exact per-person guest list', () => {
    it('admits an exact email (case-insensitive) and rejects others', () => {
      expect(identityAllowed(id('alice@acme.com'), undefined, ['alice@acme.com'])).toBe(true)
      expect(identityAllowed(id('Alice@Acme.com'), undefined, ['alice@acme.com'])).toBe(true)
      expect(identityAllowed(id('bob@acme.com'), undefined, ['alice@acme.com'])).toBe(false)
    })

    it('only the listed address passes — not the whole domain', () => {
      // The point of an email list: alice gets in, her colleague carol does NOT.
      expect(identityAllowed(id('carol@acme.com'), undefined, ['alice@acme.com'])).toBe(false)
    })

    it('unions with allowedDomains (allow anyone in EITHER list)', () => {
      const policyDomains = ['acme.com']
      const policyEmails = ['bob@example.com']
      expect(identityAllowed(id('alice@acme.com'), policyDomains, policyEmails)).toBe(true) // via domain
      expect(identityAllowed(id('bob@example.com'), policyDomains, policyEmails)).toBe(true) // via email
      expect(identityAllowed(id('eve@evil.com'), policyDomains, policyEmails)).toBe(false) // in neither
    })

    it('ignores blank/whitespace entries; both lists empty → any verified identity', () => {
      expect(identityAllowed(id('anyone@anywhere.com'), [], [])).toBe(true)
      expect(identityAllowed(id('anyone@anywhere.com'), undefined, ['  '])).toBe(true)
    })
  })
})

describe('addAllowedEmail — building the guest list (immutable, validated)', () => {
  it('appends a canonical (trimmed, lowercased) address as a NEW array', () => {
    const a = ['alice@acme.com']
    const b = addAllowedEmail(a, '  Bob@Acme.com ')
    expect(b).toEqual(['alice@acme.com', 'bob@acme.com'])
    expect(a).toEqual(['alice@acme.com']) // original untouched
  })
  it('rejects blanks and non-emails (returns an unchanged copy)', () => {
    expect(addAllowedEmail([], '')).toEqual([])
    expect(addAllowedEmail([], '   ')).toEqual([])
    expect(addAllowedEmail([], 'notanemail')).toEqual([])
    expect(addAllowedEmail([], 'a@')).toEqual([])
    expect(addAllowedEmail([], '@b')).toEqual([])
  })
  it('de-duplicates (case-insensitively)', () => {
    expect(addAllowedEmail(['alice@acme.com'], 'ALICE@acme.com')).toEqual(['alice@acme.com'])
  })
  it('the stored form is exactly what identityAllowed matches', () => {
    const list = addAllowedEmail([], 'Alice@Acme.com')
    expect(identityAllowed(id('alice@acme.com'), undefined, list)).toBe(true)
  })
})
