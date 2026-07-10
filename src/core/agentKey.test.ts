import { describe, expect, it } from 'vitest'
import {
  generateAgentKeypair,
  exportAgentPublicKey,
  agentKeyThumbprint,
  signAgentAssertion,
  verifyAgentAssertion,
} from './agentKey'
import { generateInviteKeypair } from './inviteToken'
import { signManifest, verifyManifest, admitAgentByManifest, type RoomManifest, type AgentEntry } from './roomManifest'

const ROOM = 'kbz-v1-standup'
const FP = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89'
const NOW = 1_700_000_000

async function mint(room = ROOM, fp = FP, now = NOW) {
  const kp = await generateAgentKeypair()
  const pub = await exportAgentPublicKey(kp.publicKey)
  const assertion = await signAgentAssertion(kp.privateKey, { room, fp, now })
  return { kp, pub, assertion }
}

describe('agentKey — a self-held key as an agent identity, cert-bound at the door', () => {
  it('round-trips: an assertion signed by an allow-listed key verifies, returning its thumbprint', async () => {
    const { pub, assertion } = await mint()
    const res = await verifyAgentAssertion(assertion, { allowedKeys: [pub], room: ROOM, remoteFp: FP, now: NOW })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.keyId).toBe(await agentKeyThumbprint(pub))
  })

  it('is CERT-BOUND: rejects when the live fingerprint differs from the signed one (no replay onto another connection)', async () => {
    const { pub, assertion } = await mint()
    const res = await verifyAgentAssertion(assertion, {
      allowedKeys: [pub],
      room: ROOM,
      remoteFp: '99:99:99:99:99:99:99:99:99:99:99:99:99:99:99:99',
      now: NOW,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/cert-bound/)
  })

  it('canonicalises the fingerprint (case/whitespace-insensitive match)', async () => {
    const { pub } = await mint()
    const kp = await generateAgentKeypair()
    const pub2 = await exportAgentPublicKey(kp.publicKey)
    const assertion = await signAgentAssertion(kp.privateKey, { room: ROOM, fp: '  ab:cd:ef  ', now: NOW })
    const res = await verifyAgentAssertion(assertion, { allowedKeys: [pub2], room: ROOM, remoteFp: 'AB:CD:EF', now: NOW })
    expect(res.ok).toBe(true)
    void pub
  })

  it('is ROOM-BOUND: an assertion for another room is rejected (no cross-room replay)', async () => {
    const { pub, assertion } = await mint()
    const res = await verifyAgentAssertion(assertion, { allowedKeys: [pub], room: 'kbz-v1-other', remoteFp: FP, now: NOW })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/room/)
  })

  it('rejects a key that is NOT on the allow-list', async () => {
    const { assertion } = await mint()
    const stranger = await exportAgentPublicKey((await generateAgentKeypair()).publicKey)
    const res = await verifyAgentAssertion(assertion, { allowedKeys: [stranger], room: ROOM, remoteFp: FP, now: NOW })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/no matching/)
  })

  it('admits when the signing key is one of several allow-listed keys', async () => {
    const others = await Promise.all([0, 1].map(async () => exportAgentPublicKey((await generateAgentKeypair()).publicKey)))
    const { pub, assertion } = await mint()
    const res = await verifyAgentAssertion(assertion, {
      allowedKeys: [others[0], pub, others[1]],
      room: ROOM,
      remoteFp: FP,
      now: NOW,
    })
    expect(res.ok).toBe(true)
  })

  it('enforces freshness: a stale assertion is rejected', async () => {
    const { pub, assertion } = await mint(ROOM, FP, NOW - 10_000)
    const res = await verifyAgentAssertion(assertion, { allowedKeys: [pub], room: ROOM, remoteFp: FP, now: NOW, maxAgeSec: 300 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/stale/)
  })

  it('rejects an assertion dated in the future beyond clock leeway', async () => {
    const { pub, assertion } = await mint(ROOM, FP, NOW + 10_000)
    const res = await verifyAgentAssertion(assertion, { allowedKeys: [pub], room: ROOM, remoteFp: FP, now: NOW, leewaySec: 60 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/future/)
  })

  it('rejects a tampered assertion', async () => {
    const { pub, assertion } = await mint()
    const tampered = assertion.slice(0, -2) + (assertion.endsWith('AA') ? 'BB' : 'AA')
    const res = await verifyAgentAssertion(tampered, { allowedKeys: [pub], room: ROOM, remoteFp: FP, now: NOW })
    expect(res.ok).toBe(false)
  })

  it('fails closed with an empty allow-list', async () => {
    const { assertion } = await mint()
    const res = await verifyAgentAssertion(assertion, { allowedKeys: [], room: ROOM, remoteFp: FP, now: NOW })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/no allowed keys/)
  })

  it('thumbprint is stable per key and distinct across keys', async () => {
    const a = await exportAgentPublicKey((await generateAgentKeypair()).publicKey)
    const b = await exportAgentPublicKey((await generateAgentKeypair()).publicKey)
    expect(await agentKeyThumbprint(a)).toBe(await agentKeyThumbprint(a))
    expect(await agentKeyThumbprint(a)).not.toBe(await agentKeyThumbprint(b))
  })
})

describe('agentKey × roomManifest — allow-list + capability policy ride the signed manifest', () => {
  const baseManifest = (agentKeys: AgentEntry[]): RoomManifest => ({
    members: ['boss@acme.com'],
    mode: 'google',
    room: ROOM,
    exp: NOW + 3600,
    agentKeys,
  })

  it('round-trips, admits a cert-bound assertion, and is perceive-only by default', async () => {
    const creator = await generateInviteKeypair()
    const agent = await generateAgentKeypair()
    const agentPub = await exportAgentPublicKey(agent.publicKey)

    const token = await signManifest(creator.privateKey, baseManifest([{ key: agentPub, label: 'notes-bot' }]))
    const v = await verifyManifest(token, creator.publicKey, { room: ROOM, now: NOW, mode: 'google' })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.manifest.agentKeys).toHaveLength(1)

    const assertion = await signAgentAssertion(agent.privateKey, { room: ROOM, fp: FP, now: NOW })
    const res = await admitAgentByManifest(assertion, v.manifest, { remoteFp: FP, now: NOW })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.label).toBe('notes-bot')
    expect(res.caps.act).toEqual([]) // perceive-only by default
    expect(res.caps.perceive).toContain('read-chat')
  })

  it('honors a per-agent grant — an agent-only/collaboration room can grant act', async () => {
    const creator = await generateInviteKeypair()
    const agent = await generateAgentKeypair()
    const agentPub = await exportAgentPublicKey(agent.publicKey)
    const token = await signManifest(
      creator.privateKey,
      baseManifest([{ key: agentPub, caps: { perceive: ['read-chat', 'read-roster'], act: ['send-chat', 'act'] } }]),
    )
    const v = await verifyManifest(token, creator.publicKey, { room: ROOM, now: NOW })
    if (!v.ok) throw new Error('manifest should verify')
    const assertion = await signAgentAssertion(agent.privateKey, { room: ROOM, fp: FP, now: NOW })
    const res = await admitAgentByManifest(assertion, v.manifest, { remoteFp: FP, now: NOW })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.caps.act).toEqual(['send-chat', 'act'])
  })

  it('admitAgentByManifest rejects a non-cert-bound assertion (wrong live fingerprint)', async () => {
    const creator = await generateInviteKeypair()
    const agent = await generateAgentKeypair()
    const agentPub = await exportAgentPublicKey(agent.publicKey)
    const token = await signManifest(creator.privateKey, baseManifest([{ key: agentPub }]))
    const v = await verifyManifest(token, creator.publicKey, { room: ROOM, now: NOW })
    if (!v.ok) throw new Error('manifest should verify')
    const assertion = await signAgentAssertion(agent.privateKey, { room: ROOM, fp: FP, now: NOW })
    const res = await admitAgentByManifest(assertion, v.manifest, { remoteFp: '99:99:99:99', now: NOW })
    expect(res.ok).toBe(false)
  })

  it('a tampered allow-list (adding an agent key) breaks the manifest signature', async () => {
    const creator = await generateInviteKeypair()
    const token = await signManifest(creator.privateKey, baseManifest([]))
    // Attacker splices their own agent key into the signed payload.
    const evil = await exportAgentPublicKey((await generateAgentKeypair()).publicKey)
    const [body] = token.split('.')
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))))
    decoded.agentKeys = [evil]
    const reencoded = btoa(JSON.stringify(decoded)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const forged = `${reencoded}.${token.split('.')[1]}`
    const v = await verifyManifest(forged, creator.publicKey, { room: ROOM, now: NOW })
    expect(v.ok).toBe(false)
  })

  it('an AGENT-ONLY manifest (agentKeys, no human members) is VALID — humans open, agents gated', async () => {
    const creator = await generateInviteKeypair()
    const agentPub = await exportAgentPublicKey((await generateAgentKeypair()).publicKey)
    const token = await signManifest(creator.privateKey, { members: [], mode: 'google', room: ROOM, exp: NOW + 3600, agentKeys: [{ key: agentPub }] })
    const v = await verifyManifest(token, creator.publicKey, { room: ROOM, now: NOW })
    expect(v.ok).toBe(true)
  })

  it('a manifest with NEITHER members nor agent keys is rejected (no allow-list at all)', async () => {
    const creator = await generateInviteKeypair()
    const token = await signManifest(creator.privateKey, { members: [], mode: 'google', room: ROOM, exp: NOW + 3600 })
    const v = await verifyManifest(token, creator.publicKey, { room: ROOM, now: NOW })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/no members/)
  })
})
