import { describe, expect, it } from 'vitest'
import { certFingerprint } from './identityCert'

describe('certFingerprint', () => {
  it('returns the canonical (lowercase) sha-256 fingerprint', () => {
    const cert = { getFingerprints: () => [{ algorithm: 'sha-256', value: 'AB:CD:EF:01' }] }
    expect(certFingerprint(cert)).toBe('ab:cd:ef:01')
  })

  it('picks sha-256 even when other algorithms are listed first', () => {
    const cert = {
      getFingerprints: () => [
        { algorithm: 'sha-1', value: 'de:ad' },
        { algorithm: 'sha-256', value: 'be:ef' },
      ],
    }
    expect(certFingerprint(cert)).toBe('be:ef')
  })

  it('returns null when no sha-256 fingerprint is exposed', () => {
    expect(certFingerprint({ getFingerprints: () => [{ algorithm: 'sha-1', value: 'de:ad' }] })).toBeNull()
    expect(certFingerprint({ getFingerprints: () => [] })).toBeNull()
  })
})
