import { describe, expect, it } from 'vitest'
import {
  generateHostKeypair,
  exportHostPublicKey,
  exportHostPrivateKey,
  sealHostKey,
  unsealHostKey,
  signHostCommand,
  verifyHostCommand,
  type HostOp,
} from './hostKey'
import { generateInviteKeypair } from './inviteToken'

const ROOM = 'kbz-v1-standup'
const FP = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89'
const NOW = 1_700_000_000
const PW = 'correct horse battery staple'

/** A fresh host: keypair, exported public JWK, sealed private blob (under PW). */
async function mintHost(password = PW) {
  const kp = await generateHostKeypair()
  const pub = await exportHostPublicKey(kp.publicKey)
  const sealed = await sealHostKey(await exportHostPrivateKey(kp.privateKey), password)
  return { kp, pub, sealed }
}

/** Claim flow: unseal the private key with the password, sign a cert-bound command. */
async function command(
  sealed: string,
  password: string,
  op: HostOp,
  opts: { room?: string; fp?: string; target?: string; now?: number } = {},
) {
  const priv = await unsealHostKey(sealed, password)
  if (!priv) throw new Error('unseal failed')
  const { importHostPrivateKey } = await import('./hostKey')
  const key = await importHostPrivateKey(priv)
  return signHostCommand(key, {
    room: opts.room ?? ROOM,
    fp: opts.fp ?? FP,
    op,
    ...(opts.target ? { target: opts.target } : {}),
    now: opts.now ?? NOW,
  })
}

describe('hostKey — seal/unseal the host private key under the password', () => {
  it('round-trips: the right password unseals the same private key', async () => {
    const kp = await generateHostKeypair()
    const priv = await exportHostPrivateKey(kp.privateKey)
    const sealed = await sealHostKey(priv, PW)
    const back = await unsealHostKey(sealed, PW)
    expect(back).not.toBeNull()
    expect(back?.d).toBe(priv.d) // the private scalar survives the round-trip
  })

  it('fails closed on the WRONG password (null, not a throw)', async () => {
    const { sealed } = await mintHost()
    const back = await unsealHostKey(sealed, 'wrong password')
    expect(back).toBeNull()
  })

  it('fails closed on a corrupt sealed blob', async () => {
    const back = await unsealHostKey('not-a-real-blob', PW)
    expect(back).toBeNull()
  })
})

describe('hostKey — sign/verify a cert-bound moderation command', () => {
  it('round-trips: a command signed by the host verifies against its committed public key', async () => {
    const { pub, sealed } = await mintHost()
    const token = await command(sealed, PW, 'lock')
    const res = await verifyHostCommand(token, { hostKey: pub, room: ROOM, remoteFp: FP, now: NOW })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.op).toBe('lock')
  })

  it('carries the target for admit/deny/kick', async () => {
    const { pub, sealed } = await mintHost()
    const token = await command(sealed, PW, 'kick', { target: 'member-42' })
    const res = await verifyHostCommand(token, { hostKey: pub, room: ROOM, remoteFp: FP, now: NOW })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.op).toBe('kick')
      expect(res.target).toBe('member-42')
    }
  })

  it('is CERT-BOUND: a different live fingerprint is rejected (no replay onto another connection)', async () => {
    const { pub, sealed } = await mintHost()
    const token = await command(sealed, PW, 'reset')
    const res = await verifyHostCommand(token, {
      hostKey: pub,
      room: ROOM,
      remoteFp: '99:99:99:99:99:99:99:99:99:99:99:99:99:99:99:99',
      now: NOW,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/cert-bound/)
  })

  it('SKIPS the cert binding for a self-originated command (no remoteFp) — the signature alone proves the key', async () => {
    const { pub, sealed } = await mintHost()
    const token = await command(sealed, PW, 'claim')
    const res = await verifyHostCommand(token, { hostKey: pub, room: ROOM, now: NOW }) // no remoteFp
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.op).toBe('claim')
  })

  it('is ROOM-BOUND: a command for another room is rejected (no cross-room replay)', async () => {
    const { pub, sealed } = await mintHost()
    const token = await command(sealed, PW, 'lock', { room: 'kbz-v1-other' })
    const res = await verifyHostCommand(token, { hostKey: pub, room: ROOM, remoteFp: FP, now: NOW })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/room/)
  })

  it('rejects a command signed by the WRONG key (a stranger can not forge admin)', async () => {
    const { sealed } = await mintHost()
    const stranger = await generateInviteKeypair()
    const strangerPub = await exportHostPublicKey(stranger.publicKey)
    const token = await command(sealed, PW, 'kick', { target: 'x' })
    const res = await verifyHostCommand(token, { hostKey: strangerPub, room: ROOM, remoteFp: FP, now: NOW })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/signature/)
  })

  it('rejects a STALE command (past the freshness window)', async () => {
    const { pub, sealed } = await mintHost()
    const token = await command(sealed, PW, 'lock', { now: NOW })
    const res = await verifyHostCommand(token, { hostKey: pub, room: ROOM, remoteFp: FP, now: NOW + 9999, maxAgeSec: 120 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/stale/)
  })

  it('rejects a FUTURE-dated command beyond the skew leeway', async () => {
    const { pub, sealed } = await mintHost()
    const token = await command(sealed, PW, 'lock', { now: NOW + 9999 })
    const res = await verifyHostCommand(token, { hostKey: pub, room: ROOM, remoteFp: FP, now: NOW, leewaySec: 60 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/future/)
  })

  it('rejects an empty token and a missing host key (fail-closed)', async () => {
    const { pub, sealed } = await mintHost()
    const token = await command(sealed, PW, 'lock')
    expect((await verifyHostCommand('', { hostKey: pub, room: ROOM, remoteFp: FP, now: NOW })).ok).toBe(false)
    // @ts-expect-error — exercising the no-key guard
    expect((await verifyHostCommand(token, { hostKey: undefined, room: ROOM, remoteFp: FP, now: NOW })).ok).toBe(false)
  })

  it('end-to-end: only the password-holder can mint a command the committed key accepts', async () => {
    const { pub, sealed } = await mintHost()
    // Wrong password → can't even unseal, so no command is producible.
    expect(await unsealHostKey(sealed, 'nope')).toBeNull()
    // Right password → a verifiable command.
    const token = await command(sealed, PW, 'lobbyon')
    const res = await verifyHostCommand(token, { hostKey: pub, room: ROOM, remoteFp: FP, now: NOW })
    expect(res.ok).toBe(true)
  })
})
