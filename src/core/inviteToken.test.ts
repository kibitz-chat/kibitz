import { describe, it, expect } from 'vitest'
import {
  exportInvitePrivateKey,
  exportInvitePublicKey,
  generateInviteKeypair,
  importInvitePrivateKey,
  importInvitePublicKey,
  signInvite,
  verifyInvite,
} from './inviteToken'
import { bytesToB64url } from './oidcVerify'

const NOW = 1_000_000 // fixed epoch-seconds for deterministic expiry checks
const future = NOW + 3600
const past = NOW - 1

describe('signed invite tokens (ECDSA P-256)', () => {
  it('round-trips: a signed invite verifies under the matching public key', async () => {
    const kp = await generateInviteKeypair()
    const token = await signInvite(kp.privateKey, { name: 'Alice', room: 'standup', exp: future })
    const r = await verifyInvite(token, kp.publicKey, { room: 'standup', now: NOW })
    expect(r).toEqual({ ok: true, name: 'Alice' })
  })

  it('verifies after the public key is exported to JWK (the link form) and re-imported', async () => {
    const kp = await generateInviteKeypair()
    const token = await signInvite(kp.privateKey, { name: 'Bob', room: 'standup', exp: future })
    const pub = await importInvitePublicKey(await exportInvitePublicKey(kp.publicKey)) // link round-trip
    const r = await verifyInvite(token, pub, { room: 'standup', now: NOW })
    expect(r).toMatchObject({ ok: true, name: 'Bob' })
  })

  it('the creator can re-load the private key from storage and mint more invites', async () => {
    const kp = await generateInviteKeypair()
    const priv = await importInvitePrivateKey(await exportInvitePrivateKey(kp.privateKey))
    const token = await signInvite(priv, { name: 'Carol', room: 'standup', exp: future })
    expect((await verifyInvite(token, kp.publicKey, { room: 'standup', now: NOW })).ok).toBe(true)
  })

  it('rejects a token signed by a DIFFERENT key (forgery)', async () => {
    const a = await generateInviteKeypair()
    const b = await generateInviteKeypair()
    const token = await signInvite(a.privateKey, { name: 'Mallory', room: 'standup', exp: future })
    expect(await verifyInvite(token, b.publicKey, { room: 'standup', now: NOW })).toEqual({
      ok: false,
      reason: 'bad signature',
    })
  })

  it('rejects a tampered payload (name swapped after signing)', async () => {
    const kp = await generateInviteKeypair()
    const token = await signInvite(kp.privateKey, { name: 'Alice', room: 'standup', exp: future })
    // forge a new body, keep the original signature
    const forgedBody = bytesToB64url(new TextEncoder().encode(JSON.stringify({ name: 'Eve', room: 'standup', exp: future })))
    const tampered = `${forgedBody}.${token.slice(token.indexOf('.') + 1)}`
    expect((await verifyInvite(tampered, kp.publicKey, { room: 'standup', now: NOW })).ok).toBe(false)
  })

  it('rejects a token bound to a DIFFERENT room (no cross-room replay)', async () => {
    const kp = await generateInviteKeypair()
    const token = await signInvite(kp.privateKey, { name: 'Alice', room: 'standup', exp: future })
    expect(await verifyInvite(token, kp.publicKey, { room: 'lunch', now: NOW })).toEqual({
      ok: false,
      reason: 'wrong room',
    })
  })

  it('rejects an expired token', async () => {
    const kp = await generateInviteKeypair()
    const token = await signInvite(kp.privateKey, { name: 'Alice', room: 'standup', exp: past })
    expect(await verifyInvite(token, kp.publicKey, { room: 'standup', now: NOW })).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('rejects a malformed token string', async () => {
    const kp = await generateInviteKeypair()
    expect((await verifyInvite('not-a-token', kp.publicKey, { room: 'standup', now: NOW })).ok).toBe(false)
    expect((await verifyInvite('only.', kp.publicKey, { room: 'standup', now: NOW })).ok).toBe(false)
  })
})
