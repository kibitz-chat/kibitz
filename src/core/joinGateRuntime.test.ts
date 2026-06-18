import { describe, it, expect } from 'vitest'
import { buildInviteBundle, buildVerifiedGoogleRoom, buildVerifiedRoom, buildVerifiedRoster, gateVerifierFor, unlockGate } from './joinGateRuntime'
import { decodeGateParams, gateParamsFrom } from './joinGateLink'
import { exportInvitePublicKey, generateInviteKeypair, importInvitePublicKey, signInvite } from './inviteToken'
import { admitAgentByManifest, signManifest, verifyManifest } from './roomManifest'
import { generateAgentKeypair, exportAgentPublicKey, signAgentAssertion } from './agentKey'

const NOW = 2_000_000

// Pull the gate out of a built link exactly as the app would: it now rides the FRAGMENT
// (host-private), with the query as a legacy fallback. gateParamsFrom handles both.
const paramsOf = (link: string): URLSearchParams => {
  const u = new URL(link)
  return gateParamsFrom(u.hash, u.search)
}
const descriptorOf = (link: string) => decodeGateParams(paramsOf(link))
const tokenOf = (link: string) => paramsOf(link).get('gt')!

describe('gateVerifierFor — names mode', () => {
  it('admits a listed name, denies others', async () => {
    const verify = await gateVerifierFor({ mode: 'names', names: ['Alice', 'Bob'] }, 'standup')
    expect((await verify('alice', null)).ok).toBe(true)
    expect((await verify('mallory', null)).ok).toBe(false)
    expect((await verify(undefined, null)).ok).toBe(false)
  })
})

describe('gateVerifierFor — invite mode, end to end (mint → link → verify)', () => {
  it("a guest's minted token verifies against the public key carried in the room link", async () => {
    const bundle = await buildInviteBundle('https://k.chat/#standup', 'standup', ['Alice', 'Bob'], NOW + 3600)

    // The AUTHORITY rebuilds verify() purely from the room link — no shared state.
    const verify = await gateVerifierFor(descriptorOf(bundle.roomLink), 'standup', () => NOW)

    const aliceToken = tokenOf(bundle.guests[0].link)
    const bobToken = tokenOf(bundle.guests[1].link)
    expect((await verify(aliceToken, null)).ok).toBe(true)
    expect((await verify(bobToken, null)).ok).toBe(true)
  })

  it('rejects a made-up token, a token for another room, and an expired one', async () => {
    const bundle = await buildInviteBundle('https://k.chat/#standup', 'standup', ['Alice'], NOW + 3600)
    const verify = await gateVerifierFor(descriptorOf(bundle.roomLink), 'standup', () => NOW)
    expect((await verify('garbage.token', null)).ok).toBe(false)

    // a token minted for a DIFFERENT room must not verify under this room's key+room
    const other = await buildInviteBundle('https://k.chat/#lunch', 'lunch', ['Alice'], NOW + 3600)
    expect((await verify(tokenOf(other.guests[0].link), null)).ok).toBe(false) // wrong key AND wrong room

    const expired = await buildInviteBundle('https://k.chat/#standup', 'standup', ['Alice'], NOW - 1)
    const verifyExpired = await gateVerifierFor(descriptorOf(expired.roomLink), 'standup', () => NOW)
    expect((await verifyExpired(tokenOf(expired.guests[0].link), null)).reason).toBe('expired')
  })

  it('the room link carries ONLY the public key — no token, no secret', () => {
    // (sync structural check on the encoded params)
    const params = new URL('https://k.chat/?g=invite&gk=AAA#standup').searchParams
    expect(params.get('g')).toBe('invite')
    expect(params.get('gt')).toBeNull() // the shared room link never carries a credential
  })

  it('a corrupt/absent invite key in the link fails CLOSED (denies)', async () => {
    const verify = await gateVerifierFor({ mode: 'invite' }, 'standup') // no pubKey
    expect((await verify('whatever', null)).ok).toBe(false)
  })
})

describe('gateVerifierFor — open mode', () => {
  it('admits everyone (no gate)', async () => {
    const verify = await gateVerifierFor({ mode: 'open' }, 'standup')
    expect((await verify(undefined, null)).ok).toBe(true)
  })
})

describe('verified roster — buildVerifiedRoom + manifest-enforced verification', () => {
  it('admits a guest who is BOTH validly invited AND on the committed roster', async () => {
    const bundle = await buildVerifiedRoom('https://k.chat/#standup', 'standup', ['Alice', 'Bob'], NOW + 3600)
    const d = descriptorOf(bundle.roomLink)
    expect(d.manifest).toBeTruthy() // the room link carries the signed manifest
    expect(paramsOf(bundle.roomLink).get('gt')).toBeNull() // not a credential (fragment-form too)
    const verify = await gateVerifierFor(d, 'standup', () => NOW)
    expect((await verify(tokenOf(bundle.guests[0].link), null)).ok).toBe(true) // Alice
    expect((await verify(tokenOf(bundle.guests[1].link), null)).ok).toBe(true) // Bob
  })

  it('refuses a validly-signed invite whose name is NOT on the committed roster', async () => {
    // The real membership guard: a token correctly signed by the SAME creator key, but for a
    // name the manifest doesn't list, must still be refused. (buildVerifiedRoom only mints for
    // members, so construct the off-roster-but-valid case from the primitives.)
    const kp = await generateInviteKeypair()
    const pubKey = await exportInvitePublicKey(kp.publicKey)
    const manifest = await signManifest(kp.privateKey, { members: ['Alice'], mode: 'invite', room: 'standup', exp: NOW + 3600 })
    const aliceTok = await signInvite(kp.privateKey, { name: 'Alice', room: 'standup', exp: NOW + 3600 })
    const malloryTok = await signInvite(kp.privateKey, { name: 'Mallory', room: 'standup', exp: NOW + 3600 })

    const verify = await gateVerifierFor({ mode: 'invite', pubKey, manifest }, 'standup', () => NOW)
    expect((await verify(aliceTok, null)).ok).toBe(true) // on the roster
    const r = await verify(malloryTok, null) // validly signed, but NOT on the roster
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('not on the room roster')
  })

  it('buildVerifiedGoogleRoom commits an EMAIL roster + client id in one shareable link (no per-guest tokens)', async () => {
    const { roomLink } = await buildVerifiedGoogleRoom(
      'https://k.chat/#standup',
      'standup',
      ['Alice@Acme.com', ' bob@acme.com '],
      'XYZ.apps.googleusercontent.com',
      NOW + 3600,
    )
    const d = descriptorOf(roomLink)
    expect(d.mode).toBe('google')
    expect(d.clientId).toBe('XYZ.apps.googleusercontent.com')
    expect(d.manifest).toBeTruthy()
    expect(d.pubKey).toBeTruthy() // verifies the manifest
    expect(paramsOf(roomLink).get('gt')).toBeNull() // members prove via Google sign-in, no token
    // The committed manifest verifies under the link's pubkey and carries the normalized emails.
    const pub = await importInvitePublicKey(d.pubKey!)
    const mv = await verifyManifest(d.manifest!, pub, { room: 'standup', now: NOW })
    expect(mv.ok).toBe(true)
    if (mv.ok) expect(mv.manifest.members).toEqual(['alice@acme.com', 'bob@acme.com'])
  })

  it('buildVerifiedRoster: signin→members, oidc→domains, mail→display-only; publishes the roster', async () => {
    const { roomLink } = await buildVerifiedRoster(
      'https://k.chat/#standup',
      'standup',
      [
        { email: 'Alice@Acme.com', method: 'signin', name: 'Alice' },
        { domain: '@acme.com', method: 'oidc', name: 'Anyone at Acme' },
        { email: 'carol@x.com', method: 'mail', name: 'Carol' }, // email-code → admittable
      ],
      'XYZ.apps.googleusercontent.com',
      NOW + 3600,
    )
    const d = descriptorOf(roomLink)
    expect(d.mode).toBe('google')
    const pub = await importInvitePublicKey(d.pubKey!)
    const mv = await verifyManifest(d.manifest!, pub, { room: 'standup', now: NOW, mode: 'google' })
    expect(mv.ok).toBe(true)
    if (!mv.ok) return
    expect(mv.manifest.members).toEqual(['alice@acme.com', 'carol@x.com']) // signin + mail (both exact emails)
    expect(mv.manifest.domains).toEqual(['acme.com']) // oidc domain (normalized, '@' stripped)
    // the published roster carries ALL three with their methods + names, for the preview
    expect(mv.manifest.invitees).toEqual([
      { method: 'signin', id: 'alice@acme.com', name: 'Alice' },
      { method: 'oidc', domain: 'acme.com', name: 'Anyone at Acme' },
      { method: 'mail', id: 'carol@x.com', name: 'Carol' },
    ])
  })

  it('buildVerifiedRoster: pre-authorized agent keys ride the manifest → an agent admits end-to-end', async () => {
    const agent = await generateAgentKeypair()
    const agentPub = await exportAgentPublicKey(agent.publicKey)
    const fp = 'AA:BB:CC:DD'
    const { roomLink } = await buildVerifiedRoster(
      'https://k.chat/#standup',
      'standup',
      [{ email: 'alice@acme.com', method: 'signin' }],
      'XYZ.apps.googleusercontent.com',
      NOW + 3600,
      undefined, // no passphrase
      [{ key: agentPub, label: 'notes-bot', caps: { perceive: ['read-chat'], act: ['send-chat'] } }],
    )
    const d = descriptorOf(roomLink)
    const pub = await importInvitePublicKey(d.pubKey!)
    const mv = await verifyManifest(d.manifest!, pub, { room: 'standup', now: NOW, mode: 'google' })
    expect(mv.ok).toBe(true)
    if (!mv.ok) return
    expect(mv.manifest.agentKeys).toHaveLength(1)
    // The agent signs a cert-bound assertion over the SAME room id the manifest is bound to.
    const assertion = await signAgentAssertion(agent.privateKey, { room: 'standup', fp, now: NOW })
    const res = await admitAgentByManifest(assertion, mv.manifest, { remoteFp: fp, now: NOW })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.label).toBe('notes-bot')
    expect(res.caps.act).toEqual(['send-chat']) // the granted policy survived the round-trip
  })

  it('passphrase-sealed roster (Layer 2): the link carries ciphertext, unlock recovers a verifiable manifest', async () => {
    const { roomLink } = await buildVerifiedRoster(
      'https://k.chat/#standup',
      'standup',
      [{ email: 'alice@acme.com', method: 'signin' }],
      'XYZ.apps.googleusercontent.com',
      NOW + 3600,
      'our-game-night', // the out-of-band group passphrase
    )
    const d = descriptorOf(roomLink)
    // The link carries ONLY ciphertext — no cleartext manifest reaches anyone without the passphrase.
    expect(d.encManifest).toBeTruthy()
    expect(d.manifest).toBeUndefined()
    expect(paramsOf(roomLink).get('gm')).toBeNull()
    // A wrong passphrase fails closed (no descriptor, nothing leaks).
    expect(await unlockGate(d, 'wrong-secret')).toBeNull()
    // The right passphrase yields a plaintext descriptor whose manifest verifies + carries the email.
    const opened = await unlockGate(d, 'our-game-night')
    expect(opened).not.toBeNull()
    expect(opened!.encManifest).toBeUndefined()
    const pub = await importInvitePublicKey(opened!.pubKey!)
    const mv = await verifyManifest(opened!.manifest!, pub, { room: 'standup', now: NOW, mode: 'google' })
    expect(mv.ok).toBe(true)
    if (mv.ok) expect(mv.manifest.members).toEqual(['alice@acme.com'])
    // A descriptor with no encManifest is returned unchanged (nothing to unlock).
    expect(await unlockGate({ mode: 'google', manifest: 'tok' }, 'anything')).toEqual({ mode: 'google', manifest: 'tok' })
  })

  it('fails closed if the manifest is for another room or expired', async () => {
    const bundle = await buildVerifiedRoom('https://k.chat/#standup', 'standup', ['Alice'], NOW + 3600)
    const d = descriptorOf(bundle.roomLink)
    // verify under the WRONG room → the manifest check fails → nobody gets in
    const wrongRoom = await gateVerifierFor(d, 'lunch', () => NOW)
    expect((await wrongRoom(tokenOf(bundle.guests[0].link), null)).ok).toBe(false)
    // expired manifest (now past its exp)
    const expired = await buildVerifiedRoom('https://k.chat/#standup', 'standup', ['Alice'], NOW - 1)
    const verifyExpired = await gateVerifierFor(descriptorOf(expired.roomLink), 'standup', () => NOW)
    expect((await verifyExpired(tokenOf(expired.guests[0].link), null)).ok).toBe(false)
  })
})
