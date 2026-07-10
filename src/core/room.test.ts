import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// A controllable fake AuthorityTransport: capture the room's handlers, record what
// it sends/broadcasts. vi.hoisted so the vi.mock factory can reference it.
const mock = vi.hoisted(() => {
  const sends: { id: string; msg: any }[] = []
  const broadcasts: { msg: any; except?: string }[] = []
  const log: { id?: string; msg: any }[] = [] // every emission, in temporal order
  const H: { connect?: (id: string) => void; message?: (id: string, msg: any) => void; disconnect?: (id: string) => void; gone?: (reason: string) => void } = {}
  // Controllable remote-cert fingerprint per connection (the authority gate awaits this
  // before verifying). Default: every conn has a readable fp; null models "not yet readable".
  const fp: { value: string | null } = { value: 'remote-fp' }
  const transport = {
    onConnect: (f: (id: string) => void) => (H.connect = f),
    onMessage: (f: (id: string, msg: any) => void) => (H.message = f),
    onDisconnect: (f: (id: string) => void) => (H.disconnect = f),
    onGone: (f: (reason: string) => void) => (H.gone = f),
    send: (id: string, msg: any) => (sends.push({ id, msg }), log.push({ id, msg }), undefined),
    broadcast: (msg: any, except?: string) => (broadcasts.push({ msg, except }), log.push({ msg }), undefined),
    remoteFingerprint: (_id: string) => Promise.resolve(fp.value),
    close: () => {},
  }
  return {
    sends,
    broadcasts,
    log,
    H,
    fp,
    transport,
    reset: () => ((sends.length = 0), (broadcasts.length = 0), (log.length = 0)),
  }
})

vi.mock('./transport', async (importActual) => ({
  ...(await importActual<typeof import('./transport')>()), // keep real normalizeRoom etc.
  claimRoom: vi.fn(async () => ({ transport: mock.transport })),
  connectToRoom: vi.fn(() => ({ onOpen() {}, onMessage() {}, onGone() {}, send() {}, close() {} })),
}))

import { admitDecision, isKicked, joinRoom, lockedOut, type Room } from './room'
import { generateHostKeypair, exportHostPublicKey, signHostCommand, type HostOp } from './hostKey'

/** Every roster the authority emitted, member-ids only (lobby OFF goes via broadcast,
 *  ON via per-id send) — latest last. */
const rosters = (): string[][] =>
  mock.log.filter((e) => e.msg?.t === 'roster').map((e) => e.msg.members.map((m: any) => m.id))
const voice = (connId: string, voiceId: string, token: string) =>
  mock.H.message!(connId, { t: 'voice', on: true, cam: false, name: connId, voiceId, token })
const lobbyMsg = (id: string, status: string) =>
  mock.sends.some((s) => s.id === id && s.msg.t === 'lobby' && s.msg.status === status)

let room: Room
beforeEach(async () => {
  mock.reset()
  room = joinRoom('test-room')
  await new Promise((r) => setTimeout(r, 0)) // let the async claim → becomeAuthority run
})
afterEach(() => room.close())

describe('lobby OFF (default — unchanged behaviour)', () => {
  it('a peer joins normally; a knock is a no-op', () => {
    mock.H.connect!('p1')
    mock.H.message!('p1', { t: 'knock', name: 'A', token: 't1' }) // ignored while off
    voice('p1', 'v1', 't1')
    expect(rosters().at(-1)).toContain('v1')
    expect(lobbyMsg('p1', 'waiting')).toBe(false) // no lobby messages at all
  })
})

describe('lobby ON', () => {
  it('holds a newcomer: waiting status, not in the roster, host notified via onKnocks', () => {
    const lists: { id: string; name: string; avatar: string }[][] = []
    room.onKnocks((l) => lists.push(l))
    room.setLobby(true)
    expect(room.isLobby()).toBe(true)
    mock.reset()

    mock.H.connect!('p2')
    mock.H.message!('p2', { t: 'knock', name: 'B', avatar: '🦊', token: 't2' })
    expect(lobbyMsg('p2', 'waiting')).toBe(true)
    expect(lists.at(-1)).toEqual([{ id: 'p2', name: 'B', avatar: '🦊' }])

    voice('p2', 'v2', 't2') // gated — they're not admitted
    expect(rosters().flat()).not.toContain('v2')
  })

  it('onKnocks emits the full, current waiting list (add / admit / deny)', () => {
    const lists: { id: string }[][] = []
    room.onKnocks((l) => lists.push(l))
    room.setLobby(true)
    mock.H.connect!('a')
    mock.H.message!('a', { t: 'knock', name: 'A', token: 'ta' })
    mock.H.connect!('b')
    mock.H.message!('b', { t: 'knock', name: 'B', token: 'tb' })
    expect(lists.at(-1)!.map((p) => p.id)).toEqual(['a', 'b'])
    room.admit('a')
    expect(lists.at(-1)!.map((p) => p.id)).toEqual(['b'])
    room.deny('b')
    expect(lists.at(-1)).toEqual([])
  })

  it('admit lets them in; their re-sent voice then joins', () => {
    room.setLobby(true)
    mock.H.connect!('p2')
    mock.H.message!('p2', { t: 'knock', name: 'B', token: 't2' })
    mock.reset()

    room.admit('p2')
    expect(lobbyMsg('p2', 'admitted')).toBe(true)
    voice('p2', 'v2', 't2')
    expect(rosters().at(-1)).toContain('v2')
  })

  it('a pending peer never lands in the roster (so no one meshes with it)', () => {
    room.setLobby(true)
    mock.H.connect!('p2')
    mock.H.message!('p2', { t: 'knock', name: 'B', token: 't2' })
    voice('p2', 'v2', 't2') // gated — held, not admitted
    expect(rosters().flat()).not.toContain('v2')
    room.admit('p2')
    voice('p2', 'v2', 't2') // re-announce after admit
    expect(rosters().at(-1)).toContain('v2')
  })

  it('deny refuses entry', () => {
    room.setLobby(true)
    mock.H.connect!('p2')
    mock.H.message!('p2', { t: 'knock', name: 'B', token: 't2' })
    mock.reset()
    room.deny('p2')
    expect(lobbyMsg('p2', 'denied')).toBe(true)
  })

  it('a join attempt without a prior knock is an implicit knock (connected-before-lock)', () => {
    const lists: { id: string; name: string }[][] = []
    room.onKnocks((l) => lists.push(l))
    room.setLobby(true)
    mock.reset()
    // p9 connected while the lobby was OFF (its connect-knock was ignored), so when
    // it now tries to JOIN it never knocked — the join itself must surface it.
    mock.H.connect!('p9')
    voice('p9', 'v9', 't9') // voice-on, not admitted → held + shown to the host
    expect(lobbyMsg('p9', 'waiting')).toBe(true)
    expect(lists.at(-1)!.map((p) => p.id)).toEqual(['p9'])
    expect(rosters().flat()).not.toContain('v9') // still held, not in the call
  })

  it('a re-knock updates the waiting name (a joiner introducing themselves live)', () => {
    const lists: { id: string; name: string; avatar: string }[][] = []
    room.onKnocks((l) => lists.push(l))
    room.setLobby(true)
    mock.H.connect!('p2')
    mock.H.message!('p2', { t: 'knock', name: 'Guest', token: 't2' }) // connect-time knock
    expect(lists.at(-1)).toEqual([{ id: 'p2', name: 'Guest', avatar: '' }])
    mock.H.message!('p2', { t: 'knock', name: 'Bob', avatar: '🦊', token: 't2' }) // typed a name
    expect(lists.at(-1)).toEqual([{ id: 'p2', name: 'Bob', avatar: '🦊' }])
  })

  it('re-admits a previously-admitted identity silently (never re-queued)', () => {
    const lists: { id: string }[][] = []
    room.onKnocks((l) => lists.push(l))
    room.setLobby(true)
    mock.H.connect!('p2')
    mock.H.message!('p2', { t: 'knock', name: 'B', token: 't2' })
    room.admit('p2')

    mock.reset()
    mock.H.connect!('p2b') // same identity, new connection id
    mock.H.message!('p2b', { t: 'knock', name: 'B', token: 't2' })
    expect(lobbyMsg('p2b', 'admitted')).toBe(true)
    expect(lists.flat().some((p) => p.id === 'p2b')).toBe(false) // never queued to the host
  })
})

describe('lobby flag propagation (migration foundation)', () => {
  it('the lobby setting rides the roster + isLobby() reflects it', () => {
    const flags = () => mock.log.filter((e) => e.msg?.t === 'roster').map((e) => e.msg.lobby)
    voice('p1', 'v1', 't1') // a roster while off
    expect(flags().at(-1)).toBeFalsy()
    expect(room.isLobby()).toBe(false)
    room.setLobby(true) // broadcasts a fresh roster carrying the flag
    expect(flags().at(-1)).toBe(true)
    expect(room.isLobby()).toBe(true)
  })
})

// Content (chat / pay / ink / co-browse) is no longer relayed by the authority —
// it's peer-to-peer over the data mesh (see meshData.test.ts + useCall). The room
// here only coordinates presence.

// The migration-grandfathering decision in isolation (the live seeding of
// `grandfathered` from the inherited roster is exercised by the 2-device test).
describe('admitDecision — who slides in vs who waits (lobby on)', () => {
  it('a returning already-admitted identity (token) slides in silently', () => {
    expect(admitDecision({ token: 't' }, new Set(['t']), new Set())).toBe('silent')
  })
  it('a peer inherited mid-call (grandfathered voiceId) slides in silently', () => {
    expect(admitDecision({ voiceId: 'vX' }, new Set(), new Set(['vX']))).toBe('silent')
  })
  it('an unknown token + unknown voiceId is queued for the host', () => {
    expect(admitDecision({ token: 't2', voiceId: 'vY' }, new Set(['t1']), new Set(['vX']))).toBe('queue')
  })
  it('a bare knocker (no token / voiceId yet) is queued', () => {
    expect(admitDecision({}, new Set(), new Set())).toBe('queue')
  })
})

describe('host id rides the roster (role labels)', () => {
  const lastRoster = () => mock.log.filter((e) => e.msg?.t === 'roster').at(-1)
  it('the coordinator is NOT automatically the host — host stays empty until a verified claim', () => {
    // The decoupling: holding the room id (being the coordinator) no longer grants admin. Joining the
    // call advertises NO host; the `host` slot is filled only by a signed `claim` (see the host-command
    // suite). A room with no committed host key therefore never has an admin.
    expect(room.hostId()).toBe('')
    room.link.setSelf(true, false, 'Host', '', 'hv', undefined)
    expect(lastRoster()!.msg.host).toBe('') // coordinator's media id does NOT become the host
    expect(room.hostId()).toBe('')
  })
})

describe('remove participant (moderation)', () => {
  const inCall = () => rosters().at(-1) ?? []
  const kicked = (id: string) => mock.sends.some((s) => s.id === id && s.msg.t === 'kick')

  it('removes a member, tells their client to leave, and re-blocks the same connection', () => {
    voice('p1', 'v1', 't1')
    expect(inCall()).toContain('v1')
    mock.reset()
    room.remove('v1')
    expect(kicked('p1')).toBe(true)
    expect(inCall()).not.toContain('v1')
    mock.reset()
    voice('p1', 'v1', 't1') // same connection re-announces → still out, told again
    expect(inCall()).not.toContain('v1')
    expect(kicked('p1')).toBe(true)
  })

  it('blocks a reconnect under a fresh connection id (same identity)', () => {
    voice('p1', 'v1', 't1')
    room.remove('v1')
    mock.reset()
    voice('p1b', 'v1', 't1') // new conn id, same token + media id
    expect(inCall()).not.toContain('v1')
    expect(kicked('p1b')).toBe(true)
  })

  it("ignores removing the host's own id", () => {
    room.link.setSelf(true, false, 'Host', '', 'hv', undefined)
    voice('p1', 'v1', 't1')
    room.remove('hv') // no-op — the host leaves via the leave button
    expect(inCall()).toContain('hv')
    expect(inCall()).toContain('v1')
  })
})

describe('isKicked — blocking a removed peer by stable identity', () => {
  it('matches by token', () => {
    expect(isKicked({ token: 't' }, new Set(['t']), new Set())).toBe(true)
  })
  it('matches by media id', () => {
    expect(isKicked({ voiceId: 'v' }, new Set(), new Set(['v']))).toBe(true)
  })
  it('passes an unknown peer (and an empty identity)', () => {
    expect(isKicked({ token: 'x', voiceId: 'y' }, new Set(['t']), new Set(['v']))).toBe(false)
    expect(isKicked({}, new Set(['t']), new Set(['v']))).toBe(false)
  })
})

describe('lock room — sealed to new members', () => {
  const inCall = () => rosters().at(-1) ?? []
  const locked = (id: string) => mock.sends.some((s) => s.id === id && s.msg.t === 'lobby' && s.msg.status === 'locked')

  it('refuses a new joiner while locked, and tells them the room is locked', () => {
    voice('p1', 'v1', 't1') // p1 is in before the lock
    room.setLocked(true)
    expect(room.isLocked()).toBe(true)
    mock.reset()
    voice('p2', 'v2', 't2') // a stranger tries to join
    expect(inCall()).not.toContain('v2')
    expect(locked('p2')).toBe(true)
  })

  it('still lets an existing member reconnect into a locked room (same token)', () => {
    voice('p1', 'v1', 't1')
    room.setLocked(true)
    mock.reset()
    voice('p1b', 'v1', 't1') // same identity, new connection id
    expect(inCall()).toContain('v1')
    expect(locked('p1b')).toBe(false)
  })

  it('lets a member who DROPPED reconnect into a locked room (identity outlives the disconnect)', () => {
    voice('p1', 'v1', 't1')
    mock.H.disconnect!('p1') // their connection drops — removed from the live roster
    room.setLocked(true)
    mock.reset()
    voice('p1b', 'v1', 't1') // they come back on a fresh connection
    expect(inCall()).toContain('v1')
    expect(locked('p1b')).toBe(false)
  })

  it('the locked flag rides the roster + isLocked() reflects it', () => {
    const flags = () => mock.log.filter((e) => e.msg?.t === 'roster').map((e) => e.msg.locked)
    voice('p1', 'v1', 't1')
    expect(flags().at(-1)).toBeFalsy()
    room.setLocked(true)
    expect(flags().at(-1)).toBe(true)
    room.setLocked(false)
    expect(flags().at(-1)).toBe(false)
    expect(room.isLocked()).toBe(false)
  })
})

describe('lockedOut — who a sealed room turns away', () => {
  it('lets an existing member (token or media id) back in', () => {
    expect(lockedOut({ token: 't' }, new Set(['t']), new Set())).toBe(false)
    expect(lockedOut({ voiceId: 'v' }, new Set(), new Set(['v']))).toBe(false)
  })
  it('turns away a stranger', () => {
    expect(lockedOut({ token: 'x', voiceId: 'y' }, new Set(['t']), new Set(['v']))).toBe(true)
    expect(lockedOut({}, new Set(['t']), new Set(['v']))).toBe(true)
  })
})

describe('reset room — clears ephemeral chat', () => {
  it('broadcasts a reset and clears the host locally', () => {
    let hostReset = 0
    room.link.onReset?.(() => (hostReset += 1))
    voice('p1', 'v1', 't1')
    mock.reset()
    room.resetRoom()
    expect(mock.broadcasts.some((b) => b.msg.t === 'reset')).toBe(true)
    expect(hostReset).toBe(1) // the host's own chat clears too
  })
})

describe('identity gate (authority-level — deny unverified at the door)', () => {
  // Spin up a fresh authority that closes over an injected gate.verify, so we can drive
  // ok / fail / hold without any real OIDC. The default `room` (no gate) is closed first.
  const flush = () => new Promise((r) => setTimeout(r, 0)) // let gateIdentity's awaits settle
  const voiceJwt = (connId: string, voiceId: string, token: string, jwt?: string) =>
    mock.H.message!(connId, { t: 'voice', on: true, cam: false, name: connId, voiceId, token, jwt })
  const unverified = (id: string) =>
    mock.sends.some((s) => s.id === id && s.msg.t === 'lobby' && s.msg.status === 'unverified')

  let verify: ReturnType<typeof vi.fn>
  let gated: Room
  const startGated = async (require = true, bindsFingerprint?: boolean) => {
    room.close() // drop the default ungated authority from beforeEach
    mock.reset()
    mock.fp.value = 'remote-fp'
    verify = vi.fn(async () => ({ ok: true }))
    gated = joinRoom('test-room', {
      gate: { require, verify, ...(bindsFingerprint === undefined ? {} : { bindsFingerprint }) },
    })
    await flush() // claim → becomeAuthority
    room = gated // so afterEach closes it
    mock.reset()
  }

  it('admits a joiner whose cert-bound token verifies', async () => {
    await startGated()
    voiceJwt('p1', 'v1', 't1', 'jwt-good')
    await flush()
    expect(verify).toHaveBeenCalledWith('jwt-good', 'remote-fp', undefined, undefined)
    expect(rosters().at(-1)).toContain('v1')
    expect(unverified('p1')).toBe(false)
  })

  it('denies a joiner whose token fails — never rostered, told "unverified"', async () => {
    await startGated()
    verify.mockResolvedValue({ ok: false, reason: 'bad-domain' })
    voiceJwt('p2', 'v2', 't2', 'jwt-bad')
    await flush()
    expect(unverified('p2')).toBe(true)
    expect(rosters().flat()).not.toContain('v2')
  })

  it('a non-cert-bound gate (bindsFingerprint:false) admits even when the fingerprint is null', async () => {
    // Signed invites / name lists don't bind to the connection, so a null/late presence
    // fingerprint must NOT hold them (the bug where a valid invite never got let in).
    await startGated(true, false)
    mock.fp.value = null
    voiceJwt('p1', 'v1', 't1', 'invite-token')
    await flush()
    expect(verify).toHaveBeenCalledWith('invite-token', null, undefined, undefined) // verified with a null fp, not held
    expect(rosters().at(-1)).toContain('v1') // admitted
  })

  it('holds (does not deny) a joiner whose cert is not readable yet — the re-announce retries', async () => {
    await startGated()
    mock.fp.value = null // presence cert fingerprint not available yet
    voiceJwt('p3', 'v3', 't3', 'jwt-good')
    await flush()
    expect(verify).not.toHaveBeenCalled() // can't bind without the fp → no verdict
    expect(unverified('p3')).toBe(false) // held, not denied
    expect(rosters().flat()).not.toContain('v3')

    // The fp becomes readable; the periodic re-announce now verifies and admits.
    mock.fp.value = 'remote-fp'
    voiceJwt('p3', 'v3', 't3', 'jwt-good')
    await flush()
    expect(rosters().at(-1)).toContain('v3')
  })

  it('holds quietly a joiner with no token yet (signs in after) — no "unverified" spam', async () => {
    await startGated()
    voiceJwt('p4', 'v4', 't4', undefined) // hasn't signed in
    await flush()
    expect(verify).not.toHaveBeenCalled()
    expect(unverified('p4')).toBe(false)
    expect(rosters().flat()).not.toContain('v4')

    voiceJwt('p4', 'v4', 't4', 'jwt-good') // after sign-in their announce carries the token
    await flush()
    expect(rosters().at(-1)).toContain('v4')
  })

  it('openHumans (agent-only room): a credential-less human is rostered DIRECTLY — no verify call', async () => {
    // An agent room is require:true (so the agent is verified by its key), but humans are open. A human
    // presents no credential; without openHumans they were dropped at the no-credential hold → the split
    // roster. With it, they roster directly (and the human verify is never consulted — would even refuse).
    room.close(); mock.reset(); mock.fp.value = 'remote-fp'
    verify = vi.fn(async () => ({ ok: false, reason: 'no invite presented' }))
    const r = joinRoom('test-room', { gate: { require: true, verify, openHumans: true } })
    await flush(); room = r; mock.reset()
    voiceJwt('h1', 'hv1', 'ht1', undefined) // a human, no credential
    await flush()
    expect(verify).not.toHaveBeenCalled() // admitted directly, not via the (refusing) human gate
    expect(rosters().at(-1)).toContain('hv1') // rostered — no split
    expect(unverified('h1')).toBe(false)
  })

  it('verifies a connection only once — re-announces from a verified peer skip the gate', async () => {
    await startGated()
    voiceJwt('p5', 'v5', 't5', 'jwt-good')
    await flush()
    expect(verify).toHaveBeenCalledTimes(1)
    voiceJwt('p5', 'v5', 't5', 'jwt-good') // 3s re-announce
    await flush()
    expect(verify).toHaveBeenCalledTimes(1) // not re-verified
    expect(rosters().at(-1)).toContain('v5')
  })

  it('a verifying connection that drops is forgotten (re-verifies on reconnect)', async () => {
    await startGated()
    voiceJwt('p6', 'v6', 't6', 'jwt-good')
    await flush()
    expect(verify).toHaveBeenCalledTimes(1)
    mock.H.disconnect!('p6') // they leave
    voiceJwt('p6b', 'v6', 't6', 'jwt-good') // new connection id
    await flush()
    expect(verify).toHaveBeenCalledTimes(2) // a fresh connection must prove itself again
  })

  it('a disconnect mid-verify leaves no ghost in the roster (async-race guard)', async () => {
    await startGated()
    let release!: (v: { ok: boolean }) => void
    verify.mockReturnValue(new Promise((r) => (release = r))) // hold the verdict open
    voiceJwt('p9', 'v9', 't9', 'jwt-good')
    await flush() // verify is now awaiting
    mock.H.disconnect!('p9') // they drop before the verdict lands
    release({ ok: true }) // late success must NOT roster the gone connection
    await flush()
    expect(rosters().flat()).not.toContain('v9')
  })

  it('a thrown verify holds the joiner (fail-closed admission, not a denial)', async () => {
    await startGated()
    verify.mockRejectedValue(new Error('jwks fetch blew up'))
    voiceJwt('pA', 'vA', 'tA', 'jwt-good')
    await flush()
    expect(unverified('pA')).toBe(false) // not denied — a transient error just holds
    expect(rosters().flat()).not.toContain('vA') // and certainly not admitted
  })

  it('setRequireVerified toggles the gate live (host control)', async () => {
    await startGated(false) // gate present but OFF
    voiceJwt('p7', 'v7', 't7', 'jwt-good')
    await flush()
    expect(verify).not.toHaveBeenCalled() // off → no verification
    expect(rosters().at(-1)).toContain('v7')

    gated.link.setRequireVerified!(true)
    voiceJwt('p8', 'v8', 't8', 'jwt-good') // a new joiner now must verify
    await flush()
    expect(verify).toHaveBeenCalledWith('jwt-good', 'remote-fp', undefined, undefined)
    expect(rosters().at(-1)).toContain('v8')
  })

  it('re-enabling the gate forces a previously-verified connection to re-prove', async () => {
    await startGated(true)
    voiceJwt('p9', 'v9', 't9', 'jwt-good')
    await flush()
    expect(verify).toHaveBeenCalledTimes(1)

    gated.link.setRequireVerified!(false) // gate off
    gated.link.setRequireVerified!(true) // …and back on → drop the "already verified" memory
    voiceJwt('p9', 'v9', 't9', 'jwt-good') // the same live connection re-announces
    await flush()
    expect(verify).toHaveBeenCalledTimes(2) // re-verified, not trusted from the prior window
  })

  it('refuses an oversized token synchronously — no verify, no rostering (DoS guard)', async () => {
    await startGated(true)
    const huge = 'x'.repeat(8193)
    voiceJwt('pB', 'vB', 'tB', huge)
    await flush()
    expect(verify).not.toHaveBeenCalled() // short-circuited before the async path
    expect(unverified('pB')).toBe(true)
    expect(rosters().flat()).not.toContain('vB')
  })
})

describe('agent-key admission (an agent enters by its own key — same gate seam)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const voiceAgent = (connId: string, voiceId: string, token: string, agentAssertion?: string) =>
    mock.H.message!(connId, { t: 'voice', on: true, cam: false, name: connId, voiceId, token, agentAssertion })
  const unverified = (id: string) =>
    mock.sends.some((s) => s.id === id && s.msg.t === 'lobby' && s.msg.status === 'unverified')

  let verify: ReturnType<typeof vi.fn>
  const start = async (require = false) => {
    room.close()
    mock.reset()
    mock.fp.value = 'agent-fp'
    verify = vi.fn(async () => ({ ok: true }))
    room = joinRoom('test-room', { gate: { require, verify } })
    await flush()
    mock.reset()
  }

  it('gates + admits an agent assertion EVEN when the room does not require humans to verify', async () => {
    await start(false) // require:false — humans are open, but an agent presenting a key is checked
    voiceAgent('a1', 'av1', 'at1', 'agent-assertion')
    await flush()
    // The assertion is handed to verify as the 3rd arg (jwt undefined), bound to the live fp.
    expect(verify).toHaveBeenCalledWith(undefined, 'agent-fp', 'agent-assertion', undefined)
    expect(rosters().at(-1)).toContain('av1')
    expect(unverified('a1')).toBe(false)
  })

  it('denies an agent whose assertion fails — never rostered, told "unverified"', async () => {
    await start(false)
    verify.mockResolvedValue({ ok: false, reason: 'not on allow-list' })
    voiceAgent('a2', 'av2', 'at2', 'forged')
    await flush()
    expect(unverified('a2')).toBe(true)
    expect(rosters().flat()).not.toContain('av2')
  })

  it('an agent assertion is ALWAYS held until the fingerprint is readable (cert-bound, regardless of require)', async () => {
    await start(false)
    mock.fp.value = null
    voiceAgent('a3', 'av3', 'at3', 'agent-assertion')
    await flush()
    expect(verify).not.toHaveBeenCalled() // can't check the cert binding without the fp
    expect(unverified('a3')).toBe(false) // held, not denied
    expect(rosters().flat()).not.toContain('av3')
  })

  it('a plain peer (no assertion, no jwt) in a require:false room is NOT gated — stays open', async () => {
    await start(false)
    voiceAgent('h1', 'hv1', 'ht1', undefined) // an ordinary human, no credential
    await flush()
    expect(verify).not.toHaveBeenCalled() // nothing to gate — open for people
    expect(rosters().at(-1)).toContain('hv1')
  })
})

describe('credit-gated agent admission (declared agents must hold a valid credit credential)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const unverified = (id: string) => mock.sends.some((s) => s.id === id && s.msg.t === 'lobby' && s.msg.status === 'unverified')
  const kicked = (id: string) => mock.sends.some((s) => s.id === id && s.msg.t === 'kick')
  // A declared agent announces with a credit credential (no human jwt, no key assertion).
  const voiceCredit = (connId: string, voiceId: string, token: string, agentCredit?: string) =>
    mock.H.message!(connId, { t: 'voice', on: true, cam: false, name: connId, voiceId, token, agentCredit })

  let verify: ReturnType<typeof vi.fn>
  // require:false (open for humans) + requireAgentCredits:true. The verifier admits a credential-bearing
  // agent (returning a rolling exp) and refuses a declared agent that brings none.
  const startCredit = async () => {
    room.close()
    mock.reset()
    mock.fp.value = 'agent-fp'
    verify = vi.fn(async (_jwt?: string, _fp?: string | null, _asn?: string, credit?: string) =>
      credit ? { ok: true, creditExp: Math.floor(Date.now() / 1000) + 60 } : { ok: false, reason: 'agent credit required' },
    )
    room = joinRoom('test-room', { gate: { require: false, requireAgentCredits: true, verify, bindsFingerprint: false } })
    await flush()
    mock.reset()
  }

  it('admits a declared agent that presents a valid credit (verify gets the credit as the 4th arg)', async () => {
    await startCredit()
    voiceCredit('a1', 'av1', 'at1', 'credit-good')
    await flush()
    expect(verify).toHaveBeenCalledWith(undefined, 'agent-fp', undefined, 'credit-good')
    expect(rosters().at(-1)).toContain('av1')
    expect(unverified('a1')).toBe(false)
  })

  it('refuses a declared agent (key assertion) that brings no credit — held, never rostered', async () => {
    await startCredit()
    // A key assertion makes it a DECLARED agent → the gate fires; the mock refuses without a credit.
    mock.H.message!('a2', { t: 'voice', on: true, cam: false, name: 'a2', voiceId: 'av2', token: 'at2', agentAssertion: 'a-key' })
    await flush()
    expect(verify).toHaveBeenCalledWith(undefined, 'agent-fp', 'a-key', undefined)
    expect(unverified('a2')).toBe(true)
    expect(rosters().flat()).not.toContain('av2')
  })

  it('refuses a declared agent whose credit is invalid', async () => {
    await startCredit()
    verify.mockResolvedValue({ ok: false, reason: 'bad credit' })
    voiceCredit('a3', 'av3', 'at3', 'credit-bad')
    await flush()
    expect(unverified('a3')).toBe(true)
    expect(rosters().flat()).not.toContain('av3')
  })

  it('a human (no credit, no assertion) joins straight through — credit gating never touches them', async () => {
    await startCredit()
    mock.H.message!('h1', { t: 'voice', on: true, cam: false, name: 'h1', voiceId: 'hv1', token: 'ht1' })
    await flush()
    expect(verify).not.toHaveBeenCalled() // indistinguishable from a human → not gated (policy boundary)
    expect(rosters().at(-1)).toContain('hv1')
  })

  it('re-verifies a credit agent on EVERY announce (rolling expiry — not cached like a human)', async () => {
    await startCredit()
    voiceCredit('a4', 'av4', 'at4', 'credit-1')
    await flush()
    expect(verify).toHaveBeenCalledTimes(1)
    voiceCredit('a4', 'av4', 'at4', 'credit-2') // a renewed credential on the next announce
    await flush()
    expect(verify).toHaveBeenCalledTimes(2) // re-checked, NOT trusted from the prior window
    expect(rosters().at(-1)).toContain('av4')
  })

  it('reaps a declared agent whose credit lapses and is not renewed (kicked + dropped)', async () => {
    vi.useFakeTimers()
    try {
      room.close()
      mock.reset()
      mock.fp.value = 'agent-fp'
      const start = Math.floor(Date.now() / 1000)
      const verifyT = vi.fn(async (_j?: string, _f?: string | null, _a?: string, credit?: string) =>
        credit ? { ok: true, creditExp: start + 60 } : { ok: false },
      )
      room = joinRoom('test-room', { gate: { require: false, requireAgentCredits: true, verify: verifyT, bindsFingerprint: false } })
      await vi.advanceTimersByTimeAsync(1) // claim → becomeAuthority
      mock.reset()
      mock.H.connect!('a1')
      mock.H.message!('a1', { t: 'voice', on: true, cam: false, name: 'a1', voiceId: 'av1', token: 'at1', agentCredit: 'credit-good' })
      await vi.advanceTimersByTimeAsync(1)
      expect(rosters().at(-1)).toContain('av1')
      // Keep the connection ALIVE (pings) but never renew the credit; advance past exp + leeway (~90s).
      for (let i = 0; i < 80; i++) {
        mock.H.message!('a1', { t: 'ping' })
        await vi.advanceTimersByTimeAsync(2500)
      }
      expect(kicked('a1')).toBe(true)
      expect(rosters().at(-1)).not.toContain('av1')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('host commands — signed moderation gated on the committed host key', () => {
  // The mod path is async (await remoteFingerprint → verifyHostCommand crypto) — flush a few macrotasks.
  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
  }
  const sec = () => Math.floor(Date.now() / 1000)
  const sendMod = (connId: string, token: string) => mock.H.message!(connId, { t: 'mod', token })
  const lastRoster = () => mock.log.filter((e) => e.msg?.t === 'roster').at(-1)

  let priv: CryptoKey
  let pub: JsonWebKey
  // A room that COMMITS the host public key — so any coordinator verifies signed commands against it.
  const startWithHost = async () => {
    const kp = await generateHostKeypair()
    priv = kp.privateKey
    pub = await exportHostPublicKey(kp.publicKey)
    room.close() // drop the default keyless authority from beforeEach
    mock.reset()
    mock.fp.value = 'remote-fp'
    room = joinRoom('test-room', { hostKey: pub })
    await flush() // claim → becomeAuthority
    mock.reset()
  }
  // A host command, cert-bound to the sender's live fingerprint (mock.fp.value = 'remote-fp') by default.
  const cmd = (op: HostOp, opts: { target?: string; fp?: string; now?: number; room?: string } = {}) =>
    signHostCommand(priv, {
      room: opts.room ?? 'test-room',
      fp: opts.fp ?? 'remote-fp',
      op,
      ...(opts.target ? { target: opts.target } : {}),
      now: opts.now ?? sec(),
    })

  it('a room with NO committed host key rejects every command (open room = no admin)', async () => {
    // The default `room` from beforeEach committed no host key. A perfectly-signed command does nothing.
    const kp = await generateHostKeypair()
    voice('p1', 'v1', 't1')
    mock.reset()
    sendMod('p1', await signHostCommand(kp.privateKey, { room: 'test-room', fp: 'remote-fp', op: 'lock', now: sec() }))
    await flush()
    expect(room.isLocked()).toBe(false)
  })

  it('a signed claim marks the sender the verified host on the roster', async () => {
    await startWithHost()
    voice('p1', 'v1', 't1')
    mock.reset()
    sendMod('p1', await cmd('claim'))
    await flush()
    expect(room.hostId()).toBe('v1')
    expect(lastRoster()?.msg.host).toBe('v1')
  })

  it('a signed lock seals the room (no prior claim needed — the signature IS the proof)', async () => {
    await startWithHost()
    voice('p1', 'v1', 't1')
    sendMod('p1', await cmd('lock'))
    await flush()
    expect(room.isLocked()).toBe(true)
  })

  it('drops a remote mod command when the connection cert is UNREADABLE (any falsy fp — fail closed)', async () => {
    // handleMod must never verify a remote command without the cert binding. remoteFingerprint contracts string|null,
    // but a stray '' or undefined must fail closed too, not slip through the (former) `=== null`-only guard and then
    // verify with the fingerprint silently omitted.
    await startWithHost()
    voice('p1', 'v1', 't1')
    for (const bad of ['', undefined]) {
      mock.fp.value = bad as unknown as string | null
      sendMod('p1', await cmd('lock'))
      await flush()
      expect(room.isLocked()).toBe(false) // no readable cert on the connection ⇒ command dropped
    }
    // Sanity: with a readable, matching cert the SAME signed command enacts.
    mock.fp.value = 'remote-fp'
    sendMod('p1', await cmd('lock'))
    await flush()
    expect(room.isLocked()).toBe(true)
  })

  it('drops a REPLAYED host command (same token, same connection) — jti replay guard', async () => {
    await startWithHost()
    voice('p1', 'v1', 't1')
    const lobbyOnToken = await cmd('lobbyon') // capture ONE signed command (fixed jti)
    sendMod('p1', lobbyOnToken)
    await flush()
    expect(room.isLobby()).toBe(true)
    sendMod('p1', await cmd('lobbyoff')) // a fresh, distinct command (different jti) turns it back off
    await flush()
    expect(room.isLobby()).toBe(false)
    sendMod('p1', lobbyOnToken) // REPLAY the original lobbyon token — its jti was already seen
    await flush()
    expect(room.isLobby()).toBe(false) // dropped, not re-enacted
  })

  it('a signed lobbyon/lobbyoff toggles the gate', async () => {
    await startWithHost()
    voice('p1', 'v1', 't1')
    sendMod('p1', await cmd('lobbyon'))
    await flush()
    expect(room.isLobby()).toBe(true)
    sendMod('p1', await cmd('lobbyoff'))
    await flush()
    expect(room.isLobby()).toBe(false)
  })

  it('a signed kick removes the target member and tells their client to leave', async () => {
    await startWithHost()
    voice('p1', 'v1', 't1') // the host
    voice('p2', 'v2', 't2') // the member to remove
    mock.reset()
    sendMod('p1', await cmd('kick', { target: 'v2' }))
    await flush()
    expect(rosters().at(-1) ?? []).not.toContain('v2')
    expect(mock.sends.some((s) => s.id === 'p2' && s.msg.t === 'kick')).toBe(true)
  })

  it('rejects a command signed by a NON-host key (a stranger can not seize admin)', async () => {
    await startWithHost()
    voice('p1', 'v1', 't1')
    const stranger = await generateHostKeypair()
    sendMod('p1', await signHostCommand(stranger.privateKey, { room: 'test-room', fp: 'remote-fp', op: 'lock', now: sec() }))
    await flush()
    expect(room.isLocked()).toBe(false)
  })

  it('is CERT-BOUND: a command whose signed fp != the sender’s live fingerprint is rejected (no replay)', async () => {
    await startWithHost()
    voice('p1', 'v1', 't1')
    sendMod('p1', await cmd('lock', { fp: 'a-different-connection-fp' }))
    await flush()
    expect(room.isLocked()).toBe(false)
  })

  it('is ROOM-BOUND: a command minted for another room is rejected', async () => {
    await startWithHost()
    voice('p1', 'v1', 't1')
    sendMod('p1', await cmd('lock', { room: 'some-other-room' }))
    await flush()
    expect(room.isLocked()).toBe(false)
  })

  it('clears the verified host when that peer disconnects (admin does not linger past a migration)', async () => {
    await startWithHost()
    voice('p1', 'v1', 't1')
    sendMod('p1', await cmd('claim'))
    await flush()
    expect(room.hostId()).toBe('v1')
    mock.H.disconnect!('p1')
    expect(room.hostId()).toBe('')
  })
})

describe('soft host (name tier) — whoever joins under the committed name is the host', () => {
  const flush = async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
  }
  const voiceNamed = (connId: string, voiceId: string, token: string, name: string) =>
    mock.H.message!(connId, { t: 'voice', on: true, cam: false, name, voiceId, token })
  const lastRoster = () => mock.log.filter((e) => e.msg?.t === 'roster').at(-1)

  const startNameHost = async (hostName: string, lobbyOnStart = false) => {
    room.close() // drop the default authority from beforeEach
    mock.reset()
    room = joinRoom('test-room', { hostName, ...(lobbyOnStart ? { lobbyOnStart: true } : {}) })
    await flush() // claim → becomeAuthority
    mock.reset()
  }

  it('a peer announcing under the host name becomes the host on the roster', async () => {
    await startNameHost('Alex')
    voiceNamed('p1', 'v1', 't1', 'Alex')
    expect(room.hostId()).toBe('v1')
    expect(lastRoster()?.msg.host).toBe('v1')
  })

  it('matches the name case/whitespace-insensitively', async () => {
    await startNameHost('Alex')
    voiceNamed('p1', 'v1', 't1', '  alex ')
    expect(room.hostId()).toBe('v1')
  })

  it('first match HOLDS — a later same-name peer can not steal the host slot', async () => {
    await startNameHost('Alex')
    voiceNamed('p1', 'v1', 't1', 'Alex')
    voiceNamed('p2', 'v2', 't2', 'Alex')
    expect(room.hostId()).toBe('v1') // not v2
  })

  it('a non-matching name is just a guest (no host)', async () => {
    await startNameHost('Alex')
    voiceNamed('p1', 'v1', 't1', 'Sam')
    expect(room.hostId()).toBe('')
  })

  it('the coordinator itself becomes host when it announces under the name (setSelf)', async () => {
    await startNameHost('Alex')
    room.link.setSelf(true, false, 'Alex', '', 'hv', undefined)
    expect(room.hostId()).toBe('hv')
  })

  it('reclaims by name after the host disconnects (slot frees, named peer rejoins)', async () => {
    await startNameHost('Alex')
    voiceNamed('p1', 'v1', 't1', 'Alex')
    expect(room.hostId()).toBe('v1')
    mock.H.disconnect!('p1')
    expect(room.hostId()).toBe('') // host left → admin cleared
    voiceNamed('p1b', 'v1', 't1', 'Alex') // rejoin under the name
    expect(room.hostId()).toBe('v1')
  })

  it('starts with the waiting room ON when requested (isLobby reflects it)', async () => {
    await startNameHost('Alex', true)
    expect(room.isLobby()).toBe(true)
  })

  it('with the waiting room ON, the soft host still claims the slot (no lobby deadlock)', async () => {
    // Regression: a lobby-on-start room used to HOLD the host-named peer at the lobby gate before
    // matchHostByName ran, so the host was never claimed and `?gl=1&ghn=…` rooms deadlocked (no host
    // means no one can admit anyone). The host name must bypass the start lobby.
    await startNameHost('Alex', true)
    voiceNamed('p1', 'v1', 't1', 'Alex') // announces under the host name
    expect(room.hostId()).toBe('v1') // becomes the host (was: held, hostId stayed '')
    expect(lastRoster()?.msg.host).toBe('v1')
  })

  it('with the waiting room ON, a non-host-name joiner is still HELD (lobby intact)', async () => {
    await startNameHost('Alex', true)
    voiceNamed('p2', 'v2', 't2', 'Sam') // not the host name → the lobby must still hold them
    expect(room.hostId()).toBe('') // a guest did not slip in as host
    expect((lastRoster()?.msg.members ?? []).map((m: { id: string }) => m.id)).not.toContain('v2') // not rostered
  })

  it('a committed host KEY disables the name tier (the strong tier wins — only a signed claim sets the host)', async () => {
    const kp = await generateHostKeypair()
    const pub = await exportHostPublicKey(kp.publicKey)
    room.close()
    mock.reset()
    room = joinRoom('test-room', { hostKey: pub, hostName: 'Alex' })
    await flush()
    mock.reset()
    voiceNamed('p1', 'v1', 't1', 'Alex') // name match must be IGNORED when a key is committed
    expect(room.hostId()).toBe('')
  })
})

describe('OIDC host (email tier) — the authority declares a verified member the host', () => {
  // declareHost is the core enactment; the AUTHORITY's react layer verifies the email (cert-bound,
  // peer-to-peer) before calling it. These tests exercise the core gating directly.
  const flush = async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
  }
  const startEmailHost = async (hostEmail = 'alice@acme.com') => {
    room.close()
    mock.reset()
    room = joinRoom('test-room', { hostEmail })
    await flush()
    mock.reset()
  }

  it('declareHost marks a current member the host', async () => {
    await startEmailHost()
    voice('p1', 'v1', 't1')
    room.declareHost('v1')
    expect(room.hostId()).toBe('v1')
  })

  it('is slot-free only — a second declare does NOT switch the host', async () => {
    await startEmailHost()
    voice('p1', 'v1', 't1')
    voice('p2', 'v2', 't2')
    room.declareHost('v1')
    room.declareHost('v2')
    expect(room.hostId()).toBe('v1')
  })

  it('is INERT when no host email is committed (no accidental admin in a plain room)', () => {
    // the default `room` from beforeEach committed no host email
    voice('p1', 'v1', 't1')
    room.declareHost('v1')
    expect(room.hostId()).toBe('')
  })

  it('ignores a non-member id', async () => {
    await startEmailHost()
    room.declareHost('nobody')
    expect(room.hostId()).toBe('')
  })

  it('clears the host on disconnect and re-declares on rejoin (reclaim)', async () => {
    await startEmailHost()
    voice('p1', 'v1', 't1')
    room.declareHost('v1')
    expect(room.hostId()).toBe('v1')
    mock.H.disconnect!('p1')
    expect(room.hostId()).toBe('')
    voice('p1b', 'v1', 't1') // rejoin on a fresh connection
    room.declareHost('v1')
    expect(room.hostId()).toBe('v1')
  })

  it('a committed host KEY disables the email tier (declareHost is inert)', async () => {
    const kp = await generateHostKeypair()
    const pub = await exportHostPublicKey(kp.publicKey)
    room.close()
    mock.reset()
    room = joinRoom('test-room', { hostKey: pub, hostEmail: 'alice@acme.com' })
    await flush()
    mock.reset()
    voice('p1', 'v1', 't1')
    room.declareHost('v1')
    expect(room.hostId()).toBe('')
  })
})

// Directed messaging (sendTo) is now peer-to-peer — see meshData.test.ts
// ("sendData reaches only the addressed peer").

describe('authority re-join on a lost id (split-brain heal)', () => {
  it('an authority whose id is re-claimed (onGone) re-enters the loop instead of sitting alone', async () => {
    const transport = await import('./transport')
    const before = vi.mocked(transport.claimRoom).mock.calls.length // 1: beforeEach's claim → becomeAuthority
    // Simulate: our WS dropped, a peer grabbed the freed authority id, and on reconnect the broker says it's taken.
    mock.H.gone?.('authority id re-claimed')
    await new Promise((r) => setTimeout(r, 1700)) // past RECLAIM_DELAY_MS (1500) → the loop re-claims / re-joins
    expect(vi.mocked(transport.claimRoom).mock.calls.length).toBeGreaterThan(before)
  })
})

describe('hostTierIsCryptographic — the caps trust gate (Fix 3)', () => {
  it('is true ONLY for a cryptographic host tier (key / OIDC email); false for soft-name / open', async () => {
    // Distributed capability grants are honored only from a crypto host (useCall caps dispatch reads this). A
    // soft-name / nameless-open room returns false, so a spoofable host id can never push a grant map.
    const pub = await exportHostPublicKey((await generateHostKeypair()).publicKey)
    const keyRoom = joinRoom('test-room', { hostKey: pub }) // password / key tier
    expect(keyRoom.hostTierIsCryptographic()).toBe(true)
    keyRoom.close()
    const oidcRoom = joinRoom('test-room', { hostEmail: 'host@acme.com' }) // OIDC email tier
    expect(oidcRoom.hostTierIsCryptographic()).toBe(true)
    oidcRoom.close()
    const nameRoom = joinRoom('test-room', { hostName: 'Alex' }) // soft-name: spoofable → NOT trusted
    expect(nameRoom.hostTierIsCryptographic()).toBe(false)
    nameRoom.close()
    const openRoom = joinRoom('test-room') // open room: no host at all
    expect(openRoom.hostTierIsCryptographic()).toBe(false)
    openRoom.close()
  })
})
