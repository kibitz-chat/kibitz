import { describe, it, expect } from 'vitest'
import { generateInviteKeypair, exportInvitePublicKey, importInvitePublicKey } from './inviteToken'
import { memberAllowed, memberAllowedAsync, signManifest, verifyManifest, type RoomManifest } from './roomManifest'
import { memberHash } from './rosterHash'

const NOW = 3_000_000
const manifest = (over: Partial<RoomManifest> = {}): RoomManifest => ({
  members: ['Alice', 'bob@acme.com', 'Carol'],
  mode: 'invite',
  room: 'standup',
  exp: NOW + 3600,
  ...over,
})

describe('room manifest (signed, committed roster)', () => {
  it('round-trips: a signed manifest verifies under the creator public key from the link', async () => {
    const kp = await generateInviteKeypair()
    const token = await signManifest(kp.privateKey, manifest())
    // the link carries the creator's PUBLIC key (JWK) — re-import it as a peer would
    const pub = await importInvitePublicKey(await exportInvitePublicKey(kp.publicKey))
    const r = await verifyManifest(token, pub, { room: 'standup', now: NOW })
    expect(r.ok).toBe(true)
    expect(r.ok && r.manifest.members).toContain('Alice')
  })

  it('rejects a manifest signed by a different key, a wrong room, an expired one, and an empty list', async () => {
    const a = await generateInviteKeypair()
    const b = await generateInviteKeypair()
    const token = await signManifest(a.privateKey, manifest())
    expect((await verifyManifest(token, b.publicKey, { room: 'standup', now: NOW })).ok).toBe(false) // forged
    expect((await verifyManifest(token, a.publicKey, { room: 'lunch', now: NOW })).ok).toBe(false) // wrong room
    const exp = await signManifest(a.privateKey, manifest({ exp: NOW - 1 }))
    expect((await verifyManifest(exp, a.publicKey, { room: 'standup', now: NOW })).ok).toBe(false) // expired
    const empty = await signManifest(a.privateKey, manifest({ members: [] }))
    expect((await verifyManifest(empty, a.publicKey, { room: 'standup', now: NOW })).ok).toBe(false) // no members
  })

  it('pins the gate mode when asked: an invite-mode manifest is refused where google is expected', async () => {
    const kp = await generateInviteKeypair()
    const inviteRoster = await signManifest(kp.privateKey, manifest({ mode: 'invite' }))
    // no expected mode → accepted (back-compat)
    expect((await verifyManifest(inviteRoster, kp.publicKey, { room: 'standup', now: NOW })).ok).toBe(true)
    // expecting google → the validly-signed invite manifest is refused (no mode-crossing)
    const r = await verifyManifest(inviteRoster, kp.publicKey, { room: 'standup', now: NOW, mode: 'google' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('wrong mode')
    // expecting the matching mode → accepted
    expect((await verifyManifest(inviteRoster, kp.publicKey, { room: 'standup', now: NOW, mode: 'invite' })).ok).toBe(true)
  })

  it('rejects a tampered member list (signature covers it)', async () => {
    const kp = await generateInviteKeypair()
    const token = await signManifest(kp.privateKey, manifest())
    const body = token.slice(0, token.indexOf('.'))
    // swap the body for one that adds an attacker, keep the original signature
    const forged = btoa(JSON.stringify(manifest({ members: ['Alice', 'mallory@evil.com'] })))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(forged).not.toBe(body)
    const tampered = `${forged}.${token.slice(token.indexOf('.') + 1)}`
    expect((await verifyManifest(tampered, kp.publicKey, { room: 'standup', now: NOW })).ok).toBe(false)
  })
})

describe('memberAllowed — is a verified identity on the manifest?', () => {
  const m = manifest()
  it('matches a listed name/email, case- and space-insensitively', () => {
    expect(memberAllowed(m, 'alice')).toBe(true)
    expect(memberAllowed(m, '  Bob@Acme.com ')).toBe(true)
    expect(memberAllowed(m, 'CAROL')).toBe(true)
  })
  it('rejects a non-member and blanks', () => {
    expect(memberAllowed(m, 'dave')).toBe(false)
    expect(memberAllowed(m, '')).toBe(false)
    expect(memberAllowed(m, undefined)).toBe(false)
  })
})

describe('memberAllowedAsync — privacy-mode hashed allow-list (Layer 1)', () => {
  it('matches a hashed (mh) roster by hashing the identity, room-bound; ignores cleartext', async () => {
    const m = manifest({
      members: [], // privacy mode reveals nothing in cleartext
      mh: [await memberHash('alice@acme.com', 'standup'), await memberHash('bob@x.com', 'standup')],
    })
    expect(await memberAllowedAsync(m, 'ALICE@acme.com ')).toBe(true)
    expect(await memberAllowedAsync(m, 'bob@x.com')).toBe(true)
    expect(await memberAllowedAsync(m, 'eve@x.com')).toBe(false)
  })

  it('hashed match is room-bound — a hash minted for another room never matches here', async () => {
    const m = manifest({ members: [], mh: [await memberHash('alice@acme.com', 'other')] })
    expect(await memberAllowedAsync(m, 'alice@acme.com')).toBe(false)
  })

  it('falls back to the cleartext path for a legacy manifest (no mh)', async () => {
    const m = manifest({ members: ['alice@acme.com'] })
    expect(await memberAllowedAsync(m, 'alice@acme.com')).toBe(true)
    expect(await memberAllowedAsync(m, 'nope@x.com')).toBe(false)
  })

  it('no identity → fail closed on both paths', async () => {
    expect(await memberAllowedAsync(manifest({ mh: ['x'] }), undefined)).toBe(false)
    expect(await memberAllowedAsync(manifest(), '')).toBe(false)
  })
})

describe('verifyManifest — a hashed-only roster (mh, empty members) is a valid allow-list', () => {
  it('accepts a manifest whose allow-list is committed only as hashes', async () => {
    const kp = await generateInviteKeypair()
    const m = manifest({ members: [], mh: [await memberHash('alice@acme.com', 'standup')] })
    const token = await signManifest(kp.privateKey, m)
    const r = await verifyManifest(token, kp.publicKey, { room: 'standup', now: NOW })
    expect(r.ok).toBe(true)
    expect(r.ok && r.manifest.mh).toHaveLength(1)
  })

  it('still rejects a manifest with NEITHER members nor mh', async () => {
    const kp = await generateInviteKeypair()
    const token = await signManifest(kp.privateKey, manifest({ members: [], mh: [] }))
    const r = await verifyManifest(token, kp.publicKey, { room: 'standup', now: NOW })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('no members')
  })
})
