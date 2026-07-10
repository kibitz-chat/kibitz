import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { joinRoom, type Room, type RoomTransport } from './room'
import { createLocalBus } from './localBus'
import { gateVerifierFor } from './joinGateRuntime'
import { signManifest, humansOpenForManifest } from './roomManifest'
import { generateInviteKeypair, exportInvitePublicKey } from './inviteToken'

/** Flush microtasks + the connect/open timer. */
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('localBus — in-memory transport running the real room engine', () => {
  let bus: RoomTransport
  let host: Room
  let guest: Room
  const extra: Room[] = []
  beforeEach(async () => {
    bus = createLocalBus()
    host = joinRoom('demo', { transport: bus })
    guest = joinRoom('demo', { transport: bus })
    await tick()
  })
  afterEach(() => {
    host.close()
    guest.close()
    extra.forEach((r) => r.close())
    extra.length = 0
  })

  const joinBoth = async () => {
    host.link.setSelf(true, false, 'Host', '', 'vhost')
    guest.link.setSelf(true, false, 'Guest', '', 'vguest')
    await tick()
  }

  it('makes the first joiner the authority and the second a participant', () => {
    expect(host.isAuthority()).toBe(true)
    expect(guest.isAuthority()).toBe(false)
  })

  it('syncs the roster across peers', async () => {
    const hostSaw: string[][] = []
    const guestSaw: string[][] = []
    host.link.onRoster((m) => hostSaw.push(m.map((x) => x.id)))
    guest.link.onRoster((m) => guestSaw.push(m.map((x) => x.id)))
    await joinBoth()
    expect(hostSaw.at(-1)).toEqual(['vhost', 'vguest'])
    expect(guestSaw.at(-1)).toEqual(expect.arrayContaining(['vhost', 'vguest']))
  })

  // Content (chat / app / sendTo) is peer-to-peer over the data mesh now, not the
  // room — so the bus drives PRESENCE; the mesh data channel is covered by
  // meshData.test.ts. The bus still proves the real engine's roster + gating.

  it('a locked room turns a third joiner away (real engine over the bus)', async () => {
    await joinBoth()
    host.setLocked(true)
    await tick()
    // A fresh peer joins the SAME bus and tries to enter the locked room.
    const latecomer = joinRoom('demo', { transport: bus })
    extra.push(latecomer)
    const status: string[] = []
    latecomer.onLobby((s) => status.push(s))
    await tick()
    latecomer.link.setSelf(true, false, 'Late', '', 'vlate') // join attempt
    await tick()
    expect(status).toContain('locked')
    const roster: string[][] = []
    host.link.onRoster((m) => roster.push(m.map((x) => x.id)))
    await tick()
    expect(roster.at(-1) ?? []).not.toContain('vlate')
  })
})

// The end-to-end guard for the gated-room "split roster": two HUMANS in a GATED, agent-only room must roster
// each other over the REAL engine. This is the reproducible case the unit tests missed — gateIdentity was
// holding credential-less humans (only the agent got in). Runs in `vitest run` (no browser), so it's a
// cheap regression check to run on EVERY change to the room / gate / transport layer.
describe('localBus — gated AGENT-ONLY room admits credential-less humans (split-roster regression)', () => {
  const NOW = 2_000_000
  const tick = () => new Promise((r) => setTimeout(r, 0))

  // Mint a real signed gate for a room: agent key(s) committed, optionally a human member allow-list.
  const gatedRoom = async (room: string, members: string[]) => {
    const kp = await generateInviteKeypair()
    const pubKey = await exportInvitePublicKey(kp.publicKey)
    const agentJwk = await exportInvitePublicKey((await generateInviteKeypair()).publicKey)
    const manifestObj = {
      members,
      mode: 'invite' as const,
      room,
      exp: NOW + 3600,
      agentKeys: [{ key: agentJwk, label: 'Singer' }],
    }
    const manifest = await signManifest(kp.privateKey, manifestObj)
    const verify = await gateVerifierFor({ mode: 'invite', pubKey, manifest }, room, () => NOW)
    // Mirror what the Widget passes to the engine for an invite/agent room.
    return { require: true, verify, bindsFingerprint: false, openHumans: humansOpenForManifest(manifestObj) }
  }

  it('agent-only (no human members): both credential-less humans roster each other', async () => {
    const bus = createLocalBus()
    const gate = await gatedRoom('agentroom', []) // agent committed, NO human allow-list ⇒ humans open
    const h = joinRoom('agentroom', { transport: bus, gate })
    const g = joinRoom('agentroom', { transport: bus, gate })
    try {
      const hSaw: string[][] = []
      h.link.onRoster((m) => hSaw.push(m.map((x) => x.id)))
      h.link.setSelf(true, false, 'Host', '', 'vh')
      g.link.setSelf(true, false, 'Guest', '', 'vg') // a plain human — presents NO credential
      await tick()
      await tick()
      expect(hSaw.at(-1)).toEqual(expect.arrayContaining(['vh', 'vg'])) // the host rosters the human (was: only 'vh')
    } finally {
      h.close()
      g.close()
    }
  })

  it('WITH a human member allow-list: a credential-less human is still HELD (no security regression)', async () => {
    const bus = createLocalBus()
    const gate = await gatedRoom('memberroom', ['Alice']) // a real human gate ⇒ openHumans false
    const h = joinRoom('memberroom', { transport: bus, gate })
    const g = joinRoom('memberroom', { transport: bus, gate })
    try {
      const hSaw: string[][] = []
      h.link.onRoster((m) => hSaw.push(m.map((x) => x.id)))
      h.link.setSelf(true, false, 'Host', '', 'vh')
      g.link.setSelf(true, false, 'Guest', '', 'vg') // no token → must NOT be admitted
      await tick()
      await tick()
      expect(hSaw.at(-1) ?? []).not.toContain('vg')
    } finally {
      h.close()
      g.close()
    }
  })
})
