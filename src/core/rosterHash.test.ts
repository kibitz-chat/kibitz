import { describe, expect, it } from 'vitest'
import { memberHash, matchesMemberHash } from './rosterHash'

// Layer 1 (privacy hardening): a verified-room roster can commit HASHED identities instead of
// cleartext emails, so the link / the web host can't harvest the roster. The room id is the salt.

describe('memberHash — room-bound, salted hash of a roster identity', () => {
  it('is deterministic + canonicalizes (NFKC, trim, lowercase) so creator & joiner agree', async () => {
    const a = await memberHash(' Alice@Acme.com ', 'room-x')
    const b = await memberHash('alice@acme.com', 'room-x')
    expect(a).toBe(b)
  })

  it('is room-bound — the same email hashes differently per room (no cross-room correlation)', async () => {
    const x = await memberHash('alice@acme.com', 'room-x')
    const y = await memberHash('alice@acme.com', 'room-y')
    expect(x).not.toBe(y)
  })

  it('matchesMemberHash finds a present identity (case/space-insensitive) and rejects others', async () => {
    const list = [await memberHash('alice@acme.com', 'r'), await memberHash('bob@x.com', 'r')]
    expect(await matchesMemberHash(list, 'ALICE@acme.com ', 'r')).toBe(true)
    expect(await matchesMemberHash(list, 'eve@x.com', 'r')).toBe(false)
    expect(await matchesMemberHash(list, undefined, 'r')).toBe(false)
    expect(await matchesMemberHash([], 'alice@acme.com', 'r')).toBe(false)
  })

  it('golden vector — FROZEN (changing it would invalidate every issued hashed roster)', async () => {
    expect(await memberHash('alice@acme.com', 'standup')).toBe('TutGnM0TOGVPG7s_K53tYqMBp0ZsSLPALCjoxSR5TCk')
  })
})
