import type { AuthorityWire, CallMember, ClientWire } from './protocol'
import { type AuthorityTransport, type ClientTransport, claimRoom, connectToRoom, normalizeRoom, type PeerConfig } from './transport'
import { verifyHostCommand, type HostOp } from './hostKey'
import { setDiagField } from './diag'

/**
 * A pluggable room transport — claim the room (become authority) or connect to it
 * (become a participant). The default is real PeerJS (claimRoom/connectToRoom); an
 * in-memory implementation (see localBus.ts) lets apps unit-test against the REAL
 * room logic with no network.
 */
export interface RoomTransport {
  claim(room: string): Promise<{ transport: AuthorityTransport } | 'taken' | 'error'>
  connect(room: string): ClientTransport
}

/**
 * A room: claim-or-join. The first arrival claims the room's deterministic peer id
 * and becomes the AUTHORITY (keeps the call roster, broadcasts it, reaps silent
 * peers). Everyone else connects to it as a participant.
 *
 * Crude-but-effective AUTHORITY MIGRATION falls out of the loop: when the
 * authority disappears, every participant's transport gives up, re-enters the
 * loop, and races to claim the freed id — the broker arbitrates (exactly one
 * wins), the rest rejoin as participants. Call membership then SELF-HEALS:
 * useCall re-announces whenever an incoming roster lacks us, so the fresh
 * authority rebuilds the roster within one round-trip, and the media mesh (which
 * never depended on the authority) keeps flowing meanwhile.
 */

export type RoomStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed'

/** What the call layer (useCall) needs from the room: PRESENCE only. Content
 *  (chat / co-browse / pay / ink) no longer rides the room — it's peer-to-peer over
 *  the data mesh (see core/mesh + useCall), so the authority never relays it. */
export interface RoomLink {
  /** Announce/clear our call membership (camera + avatar + dedicated media peer id,
   *  plus optional opaque host metadata that rides the roster). */
  setSelf(on: boolean, cam: boolean, name: string, avatar: string, voiceId: string, meta?: Record<string, unknown>): void
  /** Subscribe to call-roster broadcasts. */
  onRoster(cb: (members: CallMember[]) => void): void
  /** The host reset the room — clear ephemeral chat. Optional (online room only). */
  onReset?(cb: () => void): void
  /** Provide our cert-bound OIDC token so it rides our knock/announce — the authority
   *  verifies it before admitting us when the room requires identity. Re-announces so a
   *  pending verification resolves promptly. Optional (online room only). */
  setIdentityToken?(jwt: string): void
  /** Turn the authority identity gate on/off live (host control). Optional. */
  setRequireVerified?(on: boolean): void
  /** Provide our AI-agent key assertion so it rides our knock/announce — the authority
   *  verifies it against the room's allow-list before admitting us. Re-announces so a
   *  pending verification resolves promptly. Optional (online room only). */
  setAgentAssertion?(assertion: string): void
  /** Provide our network-access credit credential so it rides our knock/announce — the
   *  authority verifies it (signature + expiry + issuer) and keeps admitting us while it's
   *  fresh. Call ~every minute with a freshly-renewed credential; re-announces so the
   *  authority re-verifies promptly. Optional (online room only). */
  setAgentCredit?(credential: string): void
  /** Send a signed HOST moderation command (claim/admit/deny/lock/unlock/reset/kick) — the verified
   *  host signs it (core/hostKey.ts) and the coordinator verifies it against the link-committed host
   *  key before enacting. Drives admin without being the coordinator. Optional (online room only). */
  sendModCommand?(token: string): void
}

export interface Room {
  readonly room: string
  link: RoomLink
  status(): RoomStatus
  isAuthority(): boolean
  onChange(cb: () => void): void
  /** Lobby / knock-to-admit. With it on, a peer that connects is held until the host
   *  admits it — closing "a leaked link silently lets a stranger in (or lurk on the
   *  co-browse channel)". The control ops no-op unless you're the authority (host). */
  setLobby(on: boolean): void
  isLobby(): boolean
  /** Lock / unlock the room (host only). A locked room is sealed to NEW members —
   *  existing ones may still reconnect. Independent of the lobby. */
  setLocked(on: boolean): void
  isLocked(): boolean
  /** Reset the room (host only): tell everyone to clear their ephemeral chat. There's
   *  nothing stored to wipe — this just clears the open panels' scrollback. */
  resetRoom(): void
  /** Fires with the FULL current waiting list whenever it changes (knock / admit /
   *  deny / disconnect) — so the host UI never shows a ghost. Authority only. */
  onKnocks(cb: (list: { id: string; name: string; avatar: string }[]) => void): void
  admit(id: string): void
  deny(id: string): void
  /** Your own lobby status as a joiner: waiting for the host, admitted, refused, or
   *  turned away because the room is locked. */
  onLobby(cb: (status: 'waiting' | 'admitted' | 'denied' | 'locked' | 'unverified') => void): void
  /** Remove a call member by their media id — the host only. Their client is told to
   *  leave, and their token + media id are blocked from rejoining. No-op unless you're
   *  the authority, or for your own id (you can't remove yourself). The block is by
   *  STABLE identity: a peer that mints a fresh identity (new tab) can knock again — so
   *  for vetted re-entry, run with the lobby on (a kicked identity is refused at the
   *  door; with the lobby off the room is open to anyone with the link by design). */
  remove(memberId: string): void
  /** OIDC host (authority only): mark a member (by media id) the verified host, once we've verified they
   *  proved the room's committed host email. Slot-free + inert unless a host email is committed. No-op on
   *  a participant. See joinGateLink.ts `hostEmail` + useCall's declareHost. */
  declareHost(memberId: string): void
  /** Fires when the host removes US from the room — the call layer should leave. */
  onKicked(cb: () => void): void
  /** The current host's media id (the authority's own), or '' before the host has
   *  joined the call. Every client learns it from the roster, so the UI can label
   *  who the host is. */
  hostId(): string
  /** True iff a CRYPTOGRAPHIC host tier governs the room — a committed host KEY (password/key) or a
   *  committed host EMAIL (OIDC). A soft-name (or nameless open) room returns false: its host id is
   *  spoofable, so distributed capability grants from it must NOT be trusted (see useCall caps dispatch). */
  hostTierIsCryptographic(): boolean
  /** Introduce yourself to the host's lobby BEFORE joining the call — the name/avatar
   *  shown in the knock list. Buffered so the connect-time knock carries it, and
   *  re-sent if already connected, so a waiting joiner can type their name and have
   *  the host see it live. No-op for the host (it never knocks itself). */
  knock(name: string, avatar: string): void
  /** Re-establish the connection now (e.g. after media permission unlocks real ICE). */
  reconnect(): void
  close(): void
}

const SELF_KEY = '__self__'
const REAP_MS = 12000
const FREEZE_GAP_MS = 6000
const PING_MS = 2500
const RECLAIM_DELAY_MS = 1500
const MAX_TOKEN_CHARS = 8192 // identity-gate DoS guard — a real OIDC ID token is ~1KB
const MAX_ASSERTION_CHARS = 2048 // an agent key assertion is a tiny JSON payload + an ECDSA P-256 sig
// Grace past a credit credential's exp before the authority reaps the agent. The agent renews ~every
// minute (~60s TTL); this margin absorbs a slightly-late renewal so a live agent is never bounced.
const CREDIT_REAP_LEEWAY_SEC = 90

interface Slot {
  member: CallMember
  token?: string
  /** Epoch seconds when this declared agent's credit credential expires (credit-gated rooms only).
   *  Re-stamped on every verified announce; the reap loop drops the agent once it lapses. */
  agentCreditExp?: number
}

/** Who wants in, while the lobby is on. */
interface Knocker {
  name: string
  avatar: string
  token?: string
  /** The peer's media id, present once it has joined the call — the key that
   *  grandfathers a call we inherited at a host migration (media survives it). */
  voiceId?: string
}

/**
 * Decide how a newcomer enters while the lobby is on — pure, so the admit logic
 * (and the migration-grandfathering edge) is unit-testable without a live mesh:
 *  - `silent`: slide straight in, no host prompt — a returning already-admitted
 *    identity (its `token` was approved before) OR a peer we INHERITED mid-call at a
 *    host migration (its `voiceId` was in the roster we took over).
 *  - `queue`: hold them for the host and tell them they're waiting.
 */
export function admitDecision(
  who: { token?: string; voiceId?: string },
  admittedTokens: ReadonlySet<string>,
  grandfathered: ReadonlySet<string>,
): 'silent' | 'queue' {
  if (who.token && admittedTokens.has(who.token)) return 'silent'
  if (who.voiceId && grandfathered.has(who.voiceId)) return 'silent'
  return 'queue'
}

/**
 * Whether a connecting peer has been removed by the host — matched on the STABLE
 * identity it presents (its per-tab token and/or its media id), so a reconnect under
 * a fresh connection id is still blocked. Pure, so the block is unit-testable.
 */
export function isKicked(
  who: { token?: string; voiceId?: string },
  kickedTokens: ReadonlySet<string>,
  kickedVoiceIds: ReadonlySet<string>,
): boolean {
  return !!(
    (who.token && kickedTokens.has(who.token)) ||
    (who.voiceId && kickedVoiceIds.has(who.voiceId))
  )
}

/**
 * Whether a locked room turns this entrant away. A locked room is sealed to NEW
 * members but still lets anyone who has EVER joined reconnect — recognised by the
 * stable token or media id they present matching a known identity (the caller passes
 * the set of everyone who's joined, which survives a disconnect). Pure.
 */
export function lockedOut(
  who: { token?: string; voiceId?: string },
  knownTokens: ReadonlySet<string>,
  knownVoiceIds: ReadonlySet<string>,
): boolean {
  if (who.token && knownTokens.has(who.token)) return false
  if (who.voiceId && knownVoiceIds.has(who.voiceId)) return false
  return true
}

export interface IdentityGate {
  /** Live flag (the host can toggle it). When true the authority verifies before admit. */
  require: boolean
  /** When true, a DECLARED agent (one presenting an agent key assertion or a credit credential)
   *  must also present a VALID, unexpired credit credential to be admitted — re-verified on every
   *  announce and dropped on lapse. Humans (the jwt path) are unaffected. Default false → dormant.
   *  Set at room creation; a room that doesn't require it behaves exactly as today. */
  requireAgentCredits?: boolean
  /** Injected, OIDC-agnostic verifier: given a joiner's token and the REMOTE cert
   *  fingerprint of their presence connection, decide if they may enter. A joiner may
   *  instead present an `agentAssertion` (an AI agent's cert-bound key proof) and/or an
   *  `agentCredit` (a signed network-access credential). On success it may return the
   *  credential's `creditExp` (epoch seconds) so the authority can reap a lapsed agent. */
  verify: (
    jwt: string | undefined,
    remoteFp: string | null,
    agentAssertion?: string,
    agentCredit?: string,
  ) => Promise<{ ok: boolean; reason?: string; creditExp?: number }>
  /** Does verify() actually USE the cert fingerprint (cert-bound tokens, e.g. OIDC)? When
   *  true (default) a not-yet-readable fingerprint HOLDS the joiner until it is. Set false
   *  for credentials that don't bind to the connection (signed invites, name lists), so a
   *  null/late fingerprint never blocks them. */
  bindsFingerprint?: boolean
  /** Agent-only room: the gate admits the AGENT by its key, but HUMANS are open. When true, a joiner with
   *  no credential is rostered directly instead of being held (the room commits agentKeys but no human
   *  members/domains, so there is no human gate). Without it, `require:true` — needed to verify the agent —
   *  would also hold every human. */
  openHumans?: boolean
}

/** Normalize a display name for host matching (the SOFT host tier): trim + lowercase, so "Alice" and
 *  " alice " match. Empty stays empty (never matches). */
const normHostName = (s: string | undefined): string => (s ?? '').trim().toLowerCase()

export function joinRoom(
  room: string,
  opts?: {
    peer?: PeerConfig
    identity?: string
    transport?: RoomTransport
    gate?: IdentityGate
    hostKey?: JsonWebKey
    /** SOFT host (no crypto): whoever announces under this display name is the host. See joinGateLink.ts. */
    hostName?: string
    /** Start with the waiting room ON (the first authority only; migration inherits via the roster). */
    lobbyOnStart?: boolean
    /** OIDC host: the committed host EMAIL. Just an enable-flag here — the AUTHORITY verifies a member's
     *  cert-bound identity (peer-to-peer, in the react layer) and calls `declareHost` once it sees this
     *  email; core only gates `declareHost` on this being set. See joinGateLink.ts + useCall getIdentity. */
    hostEmail?: string
  },
): Room {
  // Stable per-tab token: lets the authority replace our old call entry when we
  // reconnect under a new connection id (no duplicate tiles). A host app can pass
  // its OWN stable identity (per-user/per-seat/per-session) so dedupe + resume are
  // deterministic across reconnects; otherwise we mint a random per-tab token.
  const token = opts?.identity || Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  // Authority-level identity gate (see IdentityGate). `require` is live (host toggle);
  // `identityToken` is our own cert-bound token, attached to our knock/announce so the
  // authority can verify us before admitting.
  let gateRequire = !!opts?.gate?.require
  const gateRequireCredits = !!opts?.gate?.requireAgentCredits // authority-side: gate declared agents on a valid credit
  const gateVerify = opts?.gate?.verify
  const gateBindsFp = opts?.gate?.bindsFingerprint ?? true // OIDC binds; invites/names don't
  const humansOpen = opts?.gate?.openHumans ?? false // agent-only room: admit credential-less humans directly
  let identityToken: string | undefined
  // Our AI-agent key assertion (set when we mount as an agent) — attached to knock/announce so
  // the authority verifies it against the room's allow-list before admitting us.
  let agentAssertion: string | undefined
  // Our network-access credit credential (set when we mount as a paid agent) — attached to
  // knock/announce so the authority verifies it and keeps admitting us; refreshed ~every minute.
  let agentCredit: string | undefined
  // The room's committed host PUBLIC key (decoded from the link by EVERY peer), against which any
  // coordinator verifies signed host commands. Absent → the room has no admin. See core/hostKey.ts.
  const committedHostKey = opts?.hostKey
  // The SOFT host tier (no crypto): the committed host display name (normalized). Whoever the authority
  // sees announce under it becomes the host. Ignored when a host KEY is committed (the strong tier wins).
  const committedHostName = committedHostKey ? '' : normHostName(opts?.hostName)
  // OIDC host tier: the committed host email (an ENABLE flag for declareHost — the authority verifies the
  // identity itself, peer-to-peer, then declares). Disabled when a host KEY is committed (strong tier wins).
  const committedHostEmail = committedHostKey ? '' : normHostName(opts?.hostEmail)
  // Send a signed host moderation command — wired per role (the authority self-injects since it IS the
  // host; a participant relays to the coordinator). Null until a role is established.
  let sendModFn: ((token: string) => void) | null = null

  let status: RoomStatus = 'connecting'
  let authority = false
  let closed = false
  let rosterCb: ((m: CallMember[]) => void) | null = null
  let lastRoster: CallMember[] = []
  let changeCb: (() => void) | null = null
  // Outgoing membership announcements are role-dependent; rewired by the loop.
  let sendSelf: RoomLink['setSelf'] | null = null
  // The latest announcement, BUFFERED so it survives a role that isn't wired yet:
  // the Join button enables as soon as `room` exists, which can be BEFORE the room
  // finishes claiming (sendSelf still null) — without this, that join announce is
  // dropped and the caller never appears in the roster until they re-announce (e.g.
  // by toggling the camera). Replayed when a role is established / the channel
  // (re)opens, so it also re-announces after a reconnect.
  let lastSelf: Parameters<RoomLink['setSelf']> | null = null
  let teardownRole: (() => void) | null = null
  // Lobby: joiner-side status callbacks + authority-only ops (rewired per role).
  let knocksCb: ((list: { id: string; name: string; avatar: string }[]) => void) | null = null
  let lobbyCb: ((status: 'waiting' | 'admitted' | 'denied' | 'locked' | 'unverified') => void) | null = null
  // Last-known lobby/locked settings (read off rosters) — survive a role change, so a
  // migrated authority re-applies them and isLobby()/isLocked() reflect them.
  let lastLobbyOn = !!opts?.lobbyOnStart // the first authority starts the waiting room on; migration inherits via the roster
  let lastLockedOn = false
  let setLobbyFn: ((on: boolean) => void) | null = null
  let isLobbyFn: (() => boolean) | null = null
  // Drop the authority's per-connection "already verified" memory (re-enabling the gate
  // forces everyone to re-prove). Assigned inside becomeAuthority where idVerified lives.
  let resetVerifiedFn: (() => void) | null = null
  let setLockedFn: ((on: boolean) => void) | null = null
  let isLockedFn: (() => boolean) | null = null
  let resetFn: (() => void) | null = null
  let resetCb: (() => void) | null = null
  let admitFn: ((id: string) => void) | null = null
  let denyFn: ((id: string) => void) | null = null
  // Remove-participant (authority-only) + the joiner-side "you were removed" signal.
  let removeFn: ((memberId: string) => void) | null = null
  let kickedCb: (() => void) | null = null
  // OIDC host: the authority marks a member (by media id) the verified host once it has checked their
  // committed email — see declareHost on the Room. Authority-only (null on a participant).
  let declareHostFn: ((memberId: string) => void) | null = null
  // The current host's media id — set by the authority on every roster, learned by a
  // participant off the roster wire. Survives a role change (so hostId() is stable).
  let lastHostId = ''
  // Knock identity (the name/avatar the host sees before admitting). Buffered so the
  // connect-time knock carries it; sendKnock re-sends it (participant role only) so a
  // waiting joiner can introduce themselves live.
  let lastKnockName = ''
  let lastKnockAvatar = ''
  let sendKnock: (() => void) | null = null

  const setStatus = (s: RoomStatus) => {
    if (closed && s !== 'closed') return
    status = s
    changeCb?.()
  }
  const deliverRoster = (members: CallMember[]) => {
    lastRoster = members
    setDiagField('role', authority ? 'auth' : 'cli') // ?debug: am I the host (authority) or a client?
    setDiagField('peers', String(members.length)) // ?debug: how many this side actually rosters
    rosterCb?.(members)
    changeCb?.()
  }

  // --- Authority role --------------------------------------------------------

  const becomeAuthority = (transport: AuthorityTransport) => {
    authority = true
    sendKnock = null // the host never knocks itself
    const members = new Map<string, Slot>() // keyed by data-connection id (or SELF_KEY)
    const lastSeenAt = new Map<string, number>()
    let lastTick = Date.now()

    // --- Lobby (knock-to-admit). OFF → today's behaviour, exactly. ON → a connecting
    // peer is held in `pending` and receives NOTHING until the host admits it, which
    // also closes the silent-lurker hole (relays go to `admitted` only). ----------
    let lobbyOn = lastLobbyOn // a migrated authority re-applies the inherited setting
    let locked = lastLockedOn // sealed-to-new-members, also inherited across migration
    const admitted = new Set<string>() // connection ids allowed (used only when lobbyOn)
    const pending = new Map<string, Knocker>()
    const admittedTokens = new Set<string>() // identities re-admitted silently on reconnect
    // Removed peers: blocked by stable identity (token / media id) so a reconnect under
    // a fresh connection id stays out, plus a fast set of the live connection ids we've
    // already slammed the door on (so EVERY message from them is dropped, lobby or not).
    const kickedTokens = new Set<string>()
    const kickedVoiceIds = new Set<string>()
    const kickedConns = new Set<string>()
    // Verified HOST (signed-command moderation): the media id + connection id of the peer that proved
    // the link-committed host key. The roster's `host` field = verifiedHostId. Reset on migration (a
    // fresh authority starts with no host) and on the host's own disconnect; the host re-proves with a
    // `claim` command. SELF_KEY as the conn means WE are the host (coordinator + host).
    let verifiedHostId = ''
    let verifiedHostConn = ''
    // SOFT host (name tier): when a host name is committed and the slot is free, the FIRST member we see
    // announce under that name becomes the host. First-match-holds (a later same-name peer can't steal a
    // taken slot); the slot frees on the host's disconnect, so the named peer reclaims on rejoin. Returns
    // whether it changed, so the caller can broadcast. No-op once a host is set, or in the key tier.
    const matchHostByName = (memberId: string, connId: string, name: string): boolean => {
      if (!committedHostName || verifiedHostId || normHostName(name) !== committedHostName) return false
      verifiedHostId = memberId
      verifiedHostConn = connId
      admitted.add(connId) // the host is IN — it is never held by its own start-on lobby
      return true
    }
    // Grandfather the call we INHERITED: voiceIds already in the roster when we took
    // over are pre-approved, so an authority migration doesn't bounce the existing
    // call back to the lobby (media survives the migration → each peer still holds
    // its voiceId and presents it on reconnect). Empty for a fresh, first authority.
    const grandfathered = new Set(lastRoster.map((m) => m.id))
    // Identities (token + media id) of everyone who has EVER joined this call — kept
    // across disconnects so a member whose connection drops can reconnect into a
    // LOCKED room (a lock seals out strangers, not people who were already in). Seeded
    // with the roster we inherited at a migration, so they too can come back.
    const seenTokens = new Set<string>()
    const seenVoiceIds = new Set<string>(lastRoster.map((m) => m.id))
    const emitKnocks = () =>
      knocksCb?.([...pending].map(([id, p]) => ({ id, name: p.name, avatar: p.avatar })))

    const roster = (): CallMember[] => [...members.values()].map((s) => s.member)
    const rosterMsg = (): AuthorityWire => {
      lastHostId = verifiedHostId // hostId() = the VERIFIED host (proved the host key), not the coordinator
      return { t: 'roster', members: roster(), lobby: lobbyOn, host: verifiedHostId, locked }
    }
    // Relay to admitted peers only. Lobby off → everyone (today's transport.broadcast).
    const fanout = (msg: AuthorityWire, exceptId?: string) => {
      if (!lobbyOn) return transport.broadcast(msg, exceptId)
      for (const id of admitted) if (id !== exceptId) transport.send(id, msg)
    }
    const admitNow = (id: string, info: Knocker) => {
      const wasPending = pending.delete(id)
      admitted.add(id)
      if (info.token) admittedTokens.add(info.token)
      transport.send(id, { t: 'lobby', status: 'admitted' })
      transport.send(id, rosterMsg()) // catch them up
      if (wasPending) emitKnocks()
    }
    // The single entry decision (knock OR a gated join attempt): slide a known/
    // grandfathered peer straight in, else hold them for the host. Re-queues are
    // quiet — only a brand-new entry pings the joiner, only a real identity change
    // re-renders the host's list — so a waiting peer's 3s re-announce doesn't churn.
    const gateEntry = (id: string, info: Knocker) => {
      if (admitDecision(info, admittedTokens, grandfathered) === 'silent') {
        admitNow(id, info)
        return
      }
      const prev = pending.get(id)
      pending.set(id, info)
      if (!prev) transport.send(id, { t: 'lobby', status: 'waiting' })
      if (!prev || prev.name !== info.name || prev.avatar !== info.avatar) emitKnocks()
    }
    const broadcast = () => {
      fanout(rosterMsg()) // carries members + lobby + host
      deliverRoster(roster())
    }

    transport.onConnect((id) => {
      lastSeenAt.set(id, Date.now())
      // With the lobby on, hold the newcomer until they knock + are admitted — don't
      // leak the roster to someone who isn't in. Off → catch them up as before.
      if (lobbyOn) return
      transport.send(id, rosterMsg())
    })
    // Identity gate (authority-level): a required room verifies a joiner's cert-bound
    // token BEFORE they can appear in the roster. A joiner with no token yet, or whose
    // presence cert isn't readable yet, is held QUIETLY (their 3s re-announce retries);
    // a token that fails (bad signature / wrong cert / off-domain) is told 'unverified'.
    // `idVerified` persists per connection; grandfathered (inherited) members and
    // already-verified connections skip it, so migration + re-announces never re-verify.
    const idVerified = new Set<string>()
    const verifying = new Set<string>()
    const creditExpById = new Map<string, number>() // connection id → verified credit exp (credit-gated rooms)
    resetVerifiedFn = () => idVerified.clear()
    const gateIdentity = async (id: string, msg: ClientWire) => {
      if (verifying.has(id)) return
      const jwt = (msg as { jwt?: string }).jwt
      const asn = (msg as { agentAssertion?: string }).agentAssertion
      const credit = (msg as { agentCredit?: string }).agentCredit
      if (!jwt && !asn && !credit) {
        // No credential. Normally a quiet HOLD (the joiner signs in + re-announces) — and we must NOT call
        // verify here (no "unverified" spam, no re-verify on every 3s re-announce). BUT an AGENT-ONLY room
        // (agentKeys, no human members) opens humans: admit a credential-less joiner DIRECTLY via the
        // openHumans flag the host set from the manifest. Without this, every human in an agent room was
        // dropped here before they could be rostered → only the agent appeared → the split roster.
        if (humansOpen && lastSeenAt.has(id) && !idVerified.has(id)) {
          setDiagField('gate', 'ok:open')
          idVerified.add(id)
          handle(id, msg)
        }
        return
      }
      // Reject an oversized credential synchronously, BEFORE the async verify path — a real ID
      // token is ~1KB, an agent assertion smaller, a credit credential ~1KB; anything large is abuse.
      if (
        (jwt && jwt.length > MAX_TOKEN_CHARS) ||
        (asn && asn.length > MAX_ASSERTION_CHARS) ||
        (credit && credit.length > MAX_TOKEN_CHARS)
      ) {
        transport.send(id, { t: 'lobby', status: 'unverified' })
        return
      }
      verifying.add(id)
      try {
        const fp = await transport.remoteFingerprint(id)
        // An agent assertion is ALWAYS cert-bound (it names our fingerprint), so a not-yet-
        // readable fp must HOLD it even in a room whose human credential isn't fp-bound.
        if ((gateBindsFp || !!asn) && fp === null) return // fp not readable yet — the re-announce retries
        // verify() must not strand us with an unhandled rejection: a thrown verify is a
        // HOLD (neither admit nor deny — fail-closed for admission; the re-announce retries).
        const res = await gateVerify!(jwt, fp, asn, credit).catch(() => ({ ok: false, hold: true }) as const)
        // The connection may have dropped during the awaits — onDisconnect cleared its
        // liveness. Bail rather than re-add a ghost member the reap loop would never see.
        if (!lastSeenAt.has(id)) return
        if ('hold' in res) return // transient verify error — don't deny, let them retry
        if (!res.ok) {
          setDiagField('gate', `DENY:${res.reason ?? '?'}`) // ?debug: WHY a joiner was refused
          transport.send(id, { t: 'lobby', status: 'unverified' })
          return
        }
        setDiagField('gate', 'ok') // ?debug: this joiner passed the gate
        // A credit-gated declared agent is re-verified on EVERY announce so its rolling expiry is
        // re-stamped (and a lapsed agent is reaped). We add to idVerified only long enough for the
        // immediate re-process to pass the gate, then drop it so the next announce re-verifies.
        const creditAgent = gateRequireCredits && (!!credit || !!asn)
        if (typeof res.creditExp === 'number') creditExpById.set(id, res.creditExp)
        idVerified.add(id)
        handle(id, msg) // re-process now that they're verified — lobby/roster proceed
        if (creditAgent) idVerified.delete(id)
      } finally {
        verifying.delete(id)
      }
    }
    // Enact a verified host command (called only after verifyHostCommand passes). `connId` is the
    // sender's connection id (or SELF_KEY for a self-originated command). Each op routes to the SAME
    // internal moderation logic the legacy authority API uses.
    const enactMod = (op: HostOp, target: string | undefined, claimerVoiceId: string, connId: string) => {
      switch (op) {
        case 'claim':
          verifiedHostId = claimerVoiceId
          verifiedHostConn = connId
          broadcast() // announce who the host is
          break
        case 'lobbyon':
          setLobbyFn?.(true)
          break
        case 'lobbyoff':
          setLobbyFn?.(false)
          break
        case 'lock':
          setLockedFn?.(true)
          break
        case 'unlock':
          setLockedFn?.(false)
          break
        case 'reset':
          resetFn?.()
          break
        case 'kick':
          if (target) removeFn?.(target)
          break
        case 'admit':
          if (target) admitFn?.(target)
          break
        case 'deny':
          if (target) denyFn?.(target)
          break
      }
    }
    // Seen command ids (jti) → block a captured command being REPLAYED within its freshness window. LRU-capped
    // (commands expire in ~120s, so a small window suffices); a command without a jti (old client) isn't guarded.
    const seenJti = new Map<string, number>()
    const JTI_MAX = 256
    // Verify a signed host command, then enact. `connId` = the sender's connection id, or null when the
    // command is self-originated (the coordinator IS the host — no remote fp to bind to; the signature
    // alone proves the key). No host key committed → every command is dropped (open room = no admin).
    const handleMod = async (token: string, connId: string | null) => {
      if (!committedHostKey || !token || token.length > MAX_TOKEN_CHARS) return
      const remoteFp = connId ? await transport.remoteFingerprint(connId) : undefined
      if (connId && !remoteFp) return // no readable cert on this connection ⇒ fail closed. null OR '' OR undefined:
                                      // never verify a remote mod command without the cert binding (transport
                                      // contracts string|null, but don't let a stray ''/undefined skip the bind).
      const res = await verifyHostCommand(token, {
        hostKey: committedHostKey,
        // The claimer signs against the NORMALIZED room id (useCall uses the room salt), so verify
        // against the same — the raw join id may be a non-normalized hash variant. normalizeRoom is
        // idempotent on real codes, so this is a no-op for them and a robustness fix for the rest.
        room: normalizeRoom(room),
        now: Math.floor(Date.now() / 1000),
        ...(remoteFp ? { remoteFp } : {}),
      })
      if (!res.ok) return
      if (res.jti) {
        if (seenJti.has(res.jti)) return // replay: this exact command already enacted — drop it
        seenJti.set(res.jti, Date.now())
        if (seenJti.size > JTI_MAX) seenJti.delete(seenJti.keys().next().value as string) // LRU cap (oldest out)
      }
      const claimerVoiceId = connId ? members.get(connId)?.member.id ?? '' : members.get(SELF_KEY)?.member.id ?? ''
      enactMod(res.op, res.target, claimerVoiceId, connId ?? SELF_KEY)
    }
    sendModFn = (token) => void handleMod(token, null) // we're the authority → self-inject (we ARE the host)

    const handle = (id: string, msg: ClientWire) => {
      lastSeenAt.set(id, Date.now())
      // Door slammed: a removed peer is blocked by the stable identity it presents
      // (token / media id on a voice or knock), and once identified its live
      // connection is remembered so EVERY later message is dropped too — closing the
      // co-browse lurk hole even with the lobby off. We re-tell their client to leave.
      const ident = msg.t === 'voice' || msg.t === 'knock' ? { token: msg.token, voiceId: msg.voiceId } : undefined
      if (kickedConns.has(id) || (ident && isKicked(ident, kickedTokens, kickedVoiceIds))) {
        kickedConns.add(id)
        transport.send(id, { t: 'kick' })
        return
      }
      // A signed host moderation command — verify against the committed host key + enact (handleMod).
      if (msg.t === 'mod') {
        void handleMod(msg.token, id)
        return
      }
      // Locked room: turn away a NEW entrant (a knock, or a voice-on join attempt) —
      // an existing member reconnecting is recognised by token/media id and slides past.
      if (locked && (msg.t === 'knock' || (msg.t === 'voice' && msg.on))) {
        if (lockedOut({ token: msg.token, voiceId: msg.voiceId }, seenTokens, seenVoiceIds)) {
          transport.send(id, { t: 'lobby', status: 'locked' })
          return
        }
      }
      // Identity gate: verify a joiner's cert-bound token before ANY rostering. Held or
      // denied inside gateIdentity, which re-enters here once verified. Grandfathered
      // (inherited) members and already-verified connections pass straight through.
      const inherited = msg.t === 'voice' && !!msg.voiceId && grandfathered.has(msg.voiceId)
      // An agent presents a key assertion: gate it against the allow-list even when the room
      // doesn't require HUMANS to verify (open-for-people-but-pre-authorized-agents, and
      // agent-only rooms). A room with no gate at all (gateVerify undefined) stays open.
      const hasAgentAssertion = (msg.t === 'voice' || msg.t === 'knock') && !!msg.agentAssertion
      // A declared agent in a credit-gated room is gated on its credit even with no manifest key:
      // presenting a credit credential routes it through the gate (which the verifier enforces).
      const hasAgentCredit = (msg.t === 'voice' || msg.t === 'knock') && !!msg.agentCredit
      if (
        gateVerify &&
        !idVerified.has(id) &&
        !inherited &&
        (msg.t === 'knock' || (msg.t === 'voice' && msg.on)) &&
        (gateRequire || hasAgentAssertion || (gateRequireCredits && hasAgentCredit))
      ) {
        void gateIdentity(id, msg)
        return
      }
      if (msg.t === 'knock') {
        // Nothing to gate when off — the voice announce flow is unchanged.
        if (lobbyOn) gateEntry(id, { name: msg.name || 'Guest', avatar: msg.avatar ?? '', token: msg.token, voiceId: msg.voiceId })
        return
      }
      // Lobby gate: a peer that hasn't been admitted can't appear in the roster. A JOIN
      // attempt (voice-on) is an implicit knock — it surfaces them to the host with a
      // waiting status instead of vanishing. This catches a peer that was already
      // connected when the host locked (its connect-knock predated the gate), and
      // grandfathers a peer we inherited mid-call (its voiceId admits it here). Content
      // is peer-to-peer now, gated by ROSTER membership: a non-admitted peer is never
      // in the roster, so no one's data mesh dials it and it learns no one's voiceId.
      // The committed SOFT host announcing under the host name (slot still free) must NOT be held by a
      // start-on lobby: the early return below skips matchHostByName (~648), so the host is never claimed
      // and a lobby-on-start room (?gl=1&ghn=…) deadlocks — with no host, nobody can admit anyone. Only the
      // first claimant bypasses; once verifiedHostId is set the lobby gates everyone, name-spoofers included.
      const claimingSoftHost = msg.t === 'voice' && !!committedHostName && !verifiedHostId && normHostName(msg.name) === committedHostName
      if (lobbyOn && !admitted.has(id) && msg.t === 'voice' && msg.on && !claimingSoftHost) {
        gateEntry(id, { name: msg.name || 'Guest', avatar: msg.avatar ?? '', token: msg.token, voiceId: msg.voiceId })
        if (!admitted.has(id)) return // still waiting → don't process the announce yet
      }
      if (msg.t === 'voice') {
        if (msg.on && msg.voiceId) {
          // A reconnecting participant rejoins under a NEW connection id; drop any
          // stale entry for the SAME person (matched by token) — no duplicates.
          if (msg.token) {
            for (const [k, v] of members) if (k !== id && v.token === msg.token) members.delete(k)
          }
          members.set(id, {
            member: { id: msg.voiceId, name: msg.name || 'Guest', cam: msg.cam, avatar: msg.avatar ?? '', meta: msg.meta },
            token: msg.token,
            agentCreditExp: creditExpById.get(id),
          })
          // Remember this identity so they can reconnect even into a locked room.
          if (msg.token) seenTokens.add(msg.token)
          seenVoiceIds.add(msg.voiceId)
          // Soft host: if they announced under the committed host name, mark them the host (slot-free only).
          matchHostByName(msg.voiceId, id, msg.name || '')
        } else {
          members.delete(id)
        }
        broadcast()
      } else if (msg.t === 'leave') {
        admitted.delete(id)
        if (pending.delete(id)) emitKnocks()
        if (members.delete(id)) broadcast()
      }
      // pings: liveness only (already recorded above)
    }
    transport.onMessage(handle)
    transport.onDisconnect((id) => {
      lastSeenAt.delete(id)
      admitted.delete(id)
      kickedConns.delete(id)
      idVerified.delete(id)
      verifying.delete(id)
      creditExpById.delete(id)
      const wasHost = id === verifiedHostConn
      if (wasHost) {
        verifiedHostId = '' // the host left → the room loses its admin until someone re-claims
        verifiedHostConn = ''
      }
      if (pending.delete(id)) emitKnocks()
      if (members.delete(id) || wasHost) broadcast()
    })
    transport.onGone(() => {
      // We LOST the authority — our id was re-claimed by another peer while our WS was down (the cellular-drop
      // case). Tear down this role and re-enter the loop: it finds the new authority and connects as a participant,
      // healing the split-brain instead of leaving us a stale, alone authority. Guard against a double-fire.
      if (closed || !teardownRole) return
      teardownRole()
      teardownRole = null
      setStatus('reconnecting')
      setTimeout(() => void loop(), RECLAIM_DELAY_MS)
    })

    // Beacon + reap. The freeze-gap guard avoids mass-reaping after OUR tab slept.
    const heartbeat = setInterval(() => {
      transport.broadcast({ t: 'ping' })
      const now = Date.now()
      const gap = now - lastTick
      lastTick = now
      let changed = false
      if (gap > FREEZE_GAP_MS) {
        // We were frozen (tab slept) — treat everyone as freshly seen, don't reap.
        for (const id of lastSeenAt.keys()) lastSeenAt.set(id, now)
      } else {
        for (const [id, seen] of lastSeenAt) {
          if (now - seen > REAP_MS) {
            lastSeenAt.delete(id)
            if (members.delete(id)) changed = true
          }
        }
        // Credit lapse: drop a declared agent whose credit credential expired and wasn't renewed.
        // A renewing agent re-stamps its exp on every announce, so this fires ONLY on a stopped /
        // out-of-credits agent. Dormant unless the room requires agent credits. (Same freeze guard
        // as the silence reap above — we don't mass-drop after our own tab slept.)
        if (gateRequireCredits) {
          const nowSec = Math.floor(now / 1000)
          for (const [id, slot] of members) {
            if (id === SELF_KEY) continue
            if (slot.agentCreditExp != null && nowSec >= slot.agentCreditExp + CREDIT_REAP_LEEWAY_SEC) {
              lastSeenAt.delete(id)
              creditExpById.delete(id)
              if (members.delete(id)) changed = true
              transport.send(id, { t: 'kick' }) // tell the agent its credential lapsed
            }
          }
        }
      }
      // Re-broadcast the roster EVERY tick so membership is eventually-consistent,
      // not fire-and-forget. A participant whose join-time announce raced the data
      // channel (or was dropped) receives a roster without itself and re-announces
      // (the self-heal in useCall), and anyone who missed an earlier roster gets the
      // current one. Without this, a lost announce leaves the call split until a
      // manual re-announce (e.g. toggling the camera) — the bug this fixes. Cheap
      // for small calls; only re-render ourselves when membership actually changed.
      fanout(rosterMsg())
      if (changed) deliverRoster(roster())
    }, PING_MS)

    sendSelf = (on, cam, name, avatar, voiceId, meta) => {
      if (on && voiceId) {
        members.set(SELF_KEY, { member: { id: voiceId, name: name || 'Guest', cam, avatar, meta } })
        // Soft host: the coordinator IS the host when it announces under the committed host name.
        matchHostByName(voiceId, SELF_KEY, name || '')
      } else {
        members.delete(SELF_KEY)
      }
      broadcast()
    }
    setLobbyFn = (on) => {
      lobbyOn = on
      lastLobbyOn = on // keep the inheritable setting in sync (for migration)
      if (on) {
        // Turning it on keeps existing call members in; anyone else connected (incl. a
        // silent lurker) is dropped from the relay and must knock to get back.
        admitted.clear()
        for (const k of members.keys()) if (k !== SELF_KEY) admitted.add(k)
      } else {
        for (const [pid, info] of pending) admitNow(pid, info) // reopening → let them all in
      }
      broadcast() // the lobby flag rides the roster — tell everyone it changed
    }
    isLobbyFn = () => lobbyOn
    setLockedFn = (on) => {
      locked = on
      lastLockedOn = on // inheritable across migration
      broadcast() // the locked flag rides the roster
    }
    isLockedFn = () => locked
    resetFn = () => {
      fanout({ t: 'reset' })
      resetCb?.() // clear the host's own chat too
    }
    admitFn = (pid) => {
      const info = pending.get(pid)
      if (info) admitNow(pid, info)
    }
    denyFn = (pid) => {
      if (pending.delete(pid)) emitKnocks()
      transport.send(pid, { t: 'lobby', status: 'denied' })
    }
    // OIDC host: mark a member the verified host. The authority's react layer has ALREADY verified that
    // this member proved the committed host email (cert-bound, peer-to-peer via getIdentity); core just
    // enacts it. Slot-free only (first verified host holds, like the name tier) + inert unless a host
    // email is committed. The slot frees on the host's disconnect, so a re-signed-in host re-declares.
    declareHostFn = (memberId) => {
      if (!committedHostEmail || !memberId || verifiedHostId) return
      let conn = ''
      for (const [cid, slot] of members) if (slot.member.id === memberId) { conn = cid; break }
      if (!conn) return // not a current member
      verifiedHostId = memberId
      verifiedHostConn = conn
      broadcast()
    }
    removeFn = (memberId) => {
      // Never remove yourself; the host leaves via the normal leave button.
      if (!memberId || memberId === members.get(SELF_KEY)?.member.id) return
      // Block this identity from rejoining by media id (and by token if we can see
      // the live connection), then tell that client to leave and drop it from the call.
      kickedVoiceIds.add(memberId)
      let target: string | undefined
      for (const [cid, slot] of members) {
        if (cid !== SELF_KEY && slot.member.id === memberId) {
          target = cid
          if (slot.token) kickedTokens.add(slot.token)
          break
        }
      }
      if (target !== undefined) {
        kickedConns.add(target)
        transport.send(target, { t: 'kick' })
        members.delete(target)
        admitted.delete(target)
        if (pending.delete(target)) emitKnocks()
      }
      broadcast() // drop their tile for everyone
    }
    teardownRole = () => {
      clearInterval(heartbeat)
      sendSelf = null
      setLobbyFn = null
      isLobbyFn = null
      resetVerifiedFn = null
      setLockedFn = null
      isLockedFn = null
      resetFn = null
      admitFn = null
      denyFn = null
      removeFn = null
      declareHostFn = null
      sendModFn = null
      transport.close()
    }
    if (lastSelf) sendSelf(...lastSelf) // replay an announce made before this role existed
    setStatus('connected')
    broadcast() // a (possibly migrated-to) authority starts fresh; self-heal refills it
  }

  // --- Participant role ------------------------------------------------------

  const becomeParticipant = () => {
    authority = false
    const transport = opts?.transport ? opts.transport.connect(room) : connectToRoom(room, opts?.peer)
    let waiting = false
    // Knock = "I'd like in" — carries the self-asserted name/avatar the host sees
    // while we wait. Reads the buffered knock identity (Room.knock), falling back to
    // the call name, then 'Guest'. Harmless when the lobby is off (the authority
    // ignores it). Re-callable so a waiting joiner can rename themselves live.
    sendKnock = () =>
      transport.send({
        t: 'knock',
        name: lastKnockName || lastSelf?.[2] || 'Guest',
        avatar: lastKnockAvatar || lastSelf?.[3] || '',
        token,
        // Our media id once we've joined (lastSelf[4]) — lets a migrated authority
        // grandfather us back into the call it inherited rather than re-gate us.
        voiceId: lastSelf?.[4],
        jwt: identityToken, // cert-bound token (for an identity-gated room)
        agentAssertion, // an AI agent's cert-bound key assertion (allow-listed rooms)
        agentCredit, // an agent's network-access credit credential (credit-gated rooms)
      })
    transport.onOpen(() => {
      setStatus('connected')
      sendKnock?.()
      // (Re)announce now the channel is open — covers joining before the role
      // existed, a send that raced the channel opening, and reconnects.
      if (lastSelf) sendSelf?.(...lastSelf)
    })
    transport.onMessage((msg) => {
      if (msg.t === 'roster') {
        lastLobbyOn = msg.lobby ?? false // track the setting (so we'd re-apply it if we migrate)
        lastLockedOn = msg.locked ?? false
        lastHostId = msg.host ?? '' // learn who the host is (for role labels)
        deliverRoster(msg.members)
      } else if (msg.t === 'kick') kickedCb?.()
      else if (msg.t === 'reset') resetCb?.()
      else if (msg.t === 'lobby') {
        lobbyCb?.(msg.status)
        if (msg.status === 'waiting') waiting = true
        else if (msg.status === 'admitted') {
          // We were held in the lobby — our open-time announce was gated, so re-send it.
          if (waiting && lastSelf) sendSelf?.(...lastSelf)
          waiting = false
        }
      }
    })
    transport.onGone(() => {
      if (closed) return
      teardownRole = null
      sendSelf = null
      sendKnock = null
      transport.close()
      // The authority vanished — race to claim the freed id (see module docs).
      setStatus('reconnecting')
      setTimeout(() => void loop(), RECLAIM_DELAY_MS)
    })
    sendSelf = (on, cam, name, avatar, voiceId, meta) =>
      transport.send({ t: 'voice', on, cam, name: name || 'Guest', avatar, voiceId, token, meta, jwt: identityToken, agentAssertion, agentCredit })
    sendModFn = (token) => transport.send({ t: 'mod', token }) // relay a signed host command to the coordinator
    teardownRole = () => {
      sendSelf = null
      sendKnock = null
      sendModFn = null
      transport.close()
    }
  }

  // --- The claim-or-join loop ------------------------------------------------

  // A generation counter makes a manual reconnect() safe against the async claim:
  // each loop run takes the latest gen, and a run whose gen is stale (a newer loop
  // started while it awaited claimRoom) bails instead of establishing a 2nd role.
  let loopGen = 0
  const loop = async () => {
    const gen = ++loopGen
    if (closed) return
    const claimed = await (opts?.transport ? opts.transport.claim(room) : claimRoom(room, opts?.peer))
    if (closed || gen !== loopGen) {
      if (typeof claimed === 'object') claimed.transport.close()
      return
    }
    if (claimed === 'taken') becomeParticipant()
    else if (claimed === 'error') setTimeout(() => void loop(), 3000)
    else becomeAuthority(claimed.transport)
  }
  void loop()

  return {
    room,
    link: {
      setSelf: (...args) => {
        lastSelf = args // buffer so a role wired up later can replay it (see lastSelf)
        sendSelf?.(...args)
      },
      onRoster: (cb) => {
        rosterCb = cb
        if (lastRoster.length) cb(lastRoster)
      },
      onReset: (cb) => (resetCb = cb),
      setIdentityToken: (jwt) => {
        identityToken = jwt
        // Re-announce so an authority gating us re-verifies right away (not only on the
        // next ~3s re-announce): replay our knock + our last self-announce with the token.
        sendKnock?.()
        if (lastSelf) sendSelf?.(...lastSelf)
      },
      setRequireVerified: (on) => {
        // Re-enabling the gate must RE-verify everyone: drop the per-connection "already
        // verified" memory so each live member re-proves on its next announce (a token
        // that expired while the gate was off no longer slides). Members inherited at
        // migration stay trusted via `grandfathered`, not `idVerified`.
        if (on && !gateRequire) resetVerifiedFn?.()
        gateRequire = on
      },
      setAgentAssertion: (a) => {
        agentAssertion = a
        // Re-announce so the authority verifies our key right away (not only on the next
        // ~3s re-announce): replay our knock + last self-announce carrying the assertion.
        sendKnock?.()
        if (lastSelf) sendSelf?.(...lastSelf)
      },
      setAgentCredit: (c) => {
        agentCredit = c
        // Re-announce so the authority re-verifies the fresh credential right away (the agent
        // calls this ~every minute): replay our knock + last self-announce carrying the credit.
        sendKnock?.()
        if (lastSelf) sendSelf?.(...lastSelf)
      },
      sendModCommand: (token) => sendModFn?.(token),
    },
    status: () => status,
    isAuthority: () => authority,
    onChange: (cb) => (changeCb = cb),
    setLobby: (on) => setLobbyFn?.(on),
    isLobby: () => (isLobbyFn ? isLobbyFn() : lastLobbyOn),
    setLocked: (on) => setLockedFn?.(on),
    isLocked: () => (isLockedFn ? isLockedFn() : lastLockedOn),
    resetRoom: () => resetFn?.(),
    onKnocks: (cb) => (knocksCb = cb),
    admit: (id) => admitFn?.(id),
    deny: (id) => denyFn?.(id),
    remove: (memberId) => removeFn?.(memberId),
    declareHost: (memberId) => declareHostFn?.(memberId),
    onKicked: (cb) => (kickedCb = cb),
    hostId: () => lastHostId,
    hostTierIsCryptographic: () => !!committedHostKey || !!committedHostEmail,
    onLobby: (cb) => (lobbyCb = cb),
    knock: (name, avatar) => {
      lastKnockName = name || ''
      lastKnockAvatar = avatar || ''
      sendKnock?.() // re-introduce live if we're already a connected participant
    },
    // Force a fresh connection — used when media permission is newly granted, so
    // the data link re-gathers ICE candidates (iOS Safari only exposes real local
    // addresses after getUserMedia; the first attempt was stuck on mDNS). Only a
    // not-yet-connected PARTICIPANT needs it; the host and a healthy link are left
    // alone. The loopGen guard makes the re-entrant loop() safe.
    reconnect: () => {
      if (closed || authority || status === 'connected') return
      teardownRole?.()
      teardownRole = null
      sendSelf = null
      setStatus('connecting')
      void loop()
    },
    close: () => {
      closed = true
      teardownRole?.()
      teardownRole = null
      status = 'closed'
    },
  }
}
