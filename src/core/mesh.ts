import type { DataConnection, Peer } from 'peerjs'
import { safetyInfo, type SafetyInfo } from './safetyCode'
import { connInfo, statsToArray, type ConnInfo } from './connStats'
import { shouldRecoverMedia, redialPlan } from './mediaRecover'
import { debugEnabled } from './connDebug'
import { rosterHoldOn, ROSTER_HOLD_TIMEOUT_MS } from './rosterHold'

/**
 * Peer-to-peer voice/video mesh over PeerJS media calls. Each participant holds a
 * direct connection to every other (no media server). Extracted from a production card-game app
 * after a long day of real-device debugging — every rule below is paid for:
 *
 * - GLARE-FREE: exactly one side initiates each pair — the smaller peer id calls,
 *   the larger answers. Never both, never neither.
 * - NO RE-DIAL ON CAMERA TOGGLES: re-dialling whole connections per toggle crashes
 *   iOS WebKit *natively* (no JS error — the process dies). Every call therefore
 *   negotiates a two-way video lane up-front (each side sends a placeholder track
 *   until its camera is on, see media.ts) and a camera toggle is a silent
 *   RTCRtpSender.replaceTrack swap on the LIVE connections.
 * - OFFER BOTH SECTIONS ALWAYS: a voice-only caller's offer would contain no video
 *   m-line, and a WebRTC ANSWER can never add a section the offer omitted — the
 *   answerer's camera would be silently dropped, forever (nothing ever re-dials).
 *   PeerJS forwards `options.constraints` to createOffer (verified in 1.5.x).
 * - Tiles must gate video-vs-avatar on the roster's `cam` flag, NOT on track
 *   presence: the video lane always exists; only the frames change.
 */

export interface RosterMember {
  id: string
  cam: boolean
}

/** This side initiates a pair iff its id sorts first (a stable, glare-free rule). */
export function shouldInitiate(selfId: string, peerId: string): boolean {
  return selfId < peerId
}

/** A media lane the capability layer can gate per-recipient. `shareAudio` is the SECOND audio lane (a staged
 *  video clip's sound), parallel to the `share` video lane — negotiated up-front only when the client opts in
 *  (so the m-line set is unchanged for clients that don't). */
export type GateKind = 'audio' | 'video' | 'share' | 'shareAudio'

/**
 * Pure: the track a peer should receive on a lane, given whether it's ALLOWED to (its
 * capability grant), the real outgoing track, and the substitute placeholder. Allowed →
 * the real track. Withheld → a FLOWING placeholder (black video / silent audio) so the
 * lane stays alive (an iOS connection treats a sample-less audio lane as dead) and the
 * swap is reversible (the placeholder keeps the sender findable to restore later). If no
 * placeholder could be minted, withholding FAILS CLOSED → `null` (the caller stops sending
 * on that lane), so a capability gate never leaks the real track when the placeholder is
 * missing. Placeholders ~always succeed, so the null path is a rare safety net.
 */
export function gatedTrack(
  allowed: boolean,
  real: MediaStreamTrack | null,
  placeholder: MediaStreamTrack | null,
): MediaStreamTrack | null {
  if (allowed) return real
  return placeholder // withheld: placeholder, or null (fail closed) when none could be minted
}

/**
 * Map a media lane to ITS RTCRtpSender on a connection. The local stream's track order (see useCall) is
 * audio, video(camera), video(share) → transceivers sit in that stable m-line order, so the camera lane is
 * the FIRST video transceiver and the share lane the SECOND. We key off the RECEIVER's negotiated kind
 * (always set by the m-line) rather than the sender's track — a gated lane's sender track can be null, which
 * would break ordering. Returns null if that lane isn't negotiated (e.g. a peer with no share m-line). Pure +
 * exported so the per-lane addressing (the thing that keeps the two video lanes from clobbering each other)
 * is unit-testable.
 */
export function laneSender(pc: RTCPeerConnection, kind: GateKind): RTCRtpSender | null {
  const txs = pc.getTransceivers()
  if (kind === 'audio' || kind === 'shareAudio') {
    // mic = the FIRST audio transceiver; the staged-video sound = the SECOND (only present when both peers
    // opted into the share-audio lane → the m-line was negotiated). Mirrors the camera/share video split.
    const audio = txs.filter((t) => (t.receiver.track?.kind ?? t.sender.track?.kind) === 'audio')
    return (kind === 'shareAudio' ? audio[1] : audio[0])?.sender ?? null
  }
  const video = txs.filter((t) => (t.receiver.track?.kind ?? t.sender.track?.kind) === 'video')
  return (kind === 'share' ? video[1] : video[0])?.sender ?? null
}

export interface RosterPlan {
  /** Initiator pairs to dial: members we haven't connected to yet. */
  initiate: string[]
  /** Members no longer present — tear their connection down. */
  drop: string[]
}

/**
 * Decide which initiator-side connections to open or drop for a new roster, given
 * what we already dialled. Camera changes deliberately do NOT trigger anything here
 * (they're handled in-place via replaceTrack). Pure, so it's unit-tested without
 * real media.
 */
export function planRoster(
  selfId: string,
  next: readonly RosterMember[],
  dialled: ReadonlySet<string>,
): RosterPlan {
  const present = new Set<string>()
  const initiate: string[] = []
  for (const m of next) {
    if (m.id === selfId) continue
    present.add(m.id)
    if (!shouldInitiate(selfId, m.id)) continue // the other side dials this pair
    if (!dialled.has(m.id)) initiate.push(m.id)
  }
  const drop: string[] = []
  for (const id of dialled) if (!present.has(id)) drop.push(id)
  return { initiate, drop }
}

/**
 * Which peers this client ADMITS, capping HUMANS at `maxHumans` (self counts as 1 human; agents never count).
 * No eviction: a peer already admitted stays; a NEW human beyond the cap is excluded — so the first `maxHumans`
 * humans (previously-admitted kept first, then in roster order) are in; later humans are refused. This is the
 * collusion-resistant half of the room cap: the EXISTING honest peers refuse to connect to / answer an over-cap
 * peer, so a lone modified joiner can't force its way into an honest room. Pure. `maxHumans` null/≤0 ⇒ everyone.
 */
export function admitMembers(
  members: readonly { id: string; human: boolean }[],
  maxHumans: number | null,
  prevAdmitted: ReadonlySet<string>,
): Set<string> {
  if (!maxHumans || maxHumans <= 0) return new Set(members.map((m) => m.id))
  const present = new Map(members.map((m) => [m.id, m]))
  const admitted = new Set<string>()
  let humans = 1 // self
  // Keep previously-admitted members that are still present (no eviction), counting their humans.
  for (const id of prevAdmitted) {
    const m = present.get(id)
    if (!m) continue
    admitted.add(id)
    if (m.human) humans++
  }
  // Admit the rest in roster order — agents always; humans only while still under the cap.
  for (const m of members) {
    if (admitted.has(m.id)) continue
    if (!m.human) {
      admitted.add(m.id)
      continue
    }
    if (humans < maxHumans) {
      admitted.add(m.id)
      humans++
    }
  }
  return admitted
}

export interface VoiceMesh {
  /** Set the local stream used for dials/answers (called once, at join). */
  setLocalStream(stream: MediaStream | null): void
  /**
   * Swap the outgoing video on every LIVE connection in place (camera ↔ placeholder)
   * — no renegotiation, no re-dial, so iOS WebKit never sees connection churn.
   */
  replaceVideoTrack(track: MediaStreamTrack): void
  /**
   * Swap the outgoing SCREEN-SHARE on the dedicated SECOND video lane (the share lane), per-peer through the
   * gate — leaving the camera lane (lane 1) untouched, so a presenter keeps their face/avatar in their tile
   * while the share fills the stage. The lane is negotiated up-front (a dormant placeholder), so this is a
   * no-renegotiation replaceTrack like the camera swap. null restores the dormant placeholder (stop share).
   */
  replaceShareTrack(track: MediaStreamTrack | null): void
  /**
   * Swap the outgoing AUDIO on every LIVE connection in place (silent placeholder
   * → real mic). Same no-renegotiation guarantee as the video swap, so the mic can
   * be granted lazily on first unmute without iOS-crashing connection churn.
   */
  replaceAudioTrack(track: MediaStreamTrack): void
  /** A peer's incoming SCREEN-SHARE track — the 2nd video lane's receiver track — so the UI can render their
   *  share on the stage separately from their camera (lane 1). null if not connected or no share lane. */
  remoteShareTrack(id: string): MediaStreamTrack | null
  /** Swap the outgoing staged-video SOUND on the dedicated 2nd audio lane (per-peer through the gate), leaving
   *  the mic untouched. null restores the dormant placeholder. No-op if the lane wasn't negotiated. */
  replaceShareAudioTrack(track: MediaStreamTrack | null): void
  /** A peer's incoming staged-video SOUND — the 2nd audio lane's receiver track — so the UI can play it
   *  alongside their share video. null if not connected or the share-audio lane wasn't negotiated. */
  remoteShareAudioTrack(id: string): MediaStreamTrack | null
  /** Reconcile connections to match the roster (members include self; we skip it). */
  setRoster(members: readonly RosterMember[]): void
  /** Gate which peers we'll CONNECT TO / ANSWER — the answerer-side half of the room human-cap (setRoster only
   *  governs who we dial). `() => true` (the default) accepts everyone, so an uncapped room is unaffected. */
  setAdmit(fn: (peerId: string) => boolean): void
  /** Peer ids whose P2P sig data channel is currently OPEN (still reachable peer-to-peer). Lets useCall HOLD a peer
   *  in the displayed roster across a broker flap that dropped it (rosterHold). */
  liveMeshPeers(): string[]
  /**
   * Send an opaque content message to EVERY connected peer over the peer-to-peer data
   * channel (chat / co-browse / pay / ink). No authority relays it — each peer holds a
   * direct DTLS-encrypted DataConnection. You never receive your own back.
   */
  broadcastData(msg: unknown): void
  /** Send an opaque content message to ONE peer by id over the data channel. */
  sendData(toId: string, msg: unknown): void
  /** Bytes currently queued in a peer's data channel (the underlying RTCDataChannel's
   *  bufferedAmount), or 0 if not open. A chunked sender reads this to apply BACKPRESSURE —
   *  pause feeding chunks while the queue is high so a big file doesn't balloon memory or
   *  overrun the channel. The max over all peers is the relevant figure for a broadcast. */
  dataBufferedAmount(toId: string): number
  /** True iff this peer currently has a LIVE (open) data link. A long streamed send polls this to ABORT
   *  the moment its link drops (PeerJS closes the channel on a send error / ICE blip) — so it doesn't keep
   *  pushing the file's tail (or an `xend`) over a re-dialled link with a gap, which would corrupt/fail the
   *  transfer. The drop is recovered by the receiver's resume (`xresume`), not by blindly carrying on. */
  dataLinkOpen(toId: string): boolean
  /** Subscribe to content messages from other peers (with the sender's id). SINGLE
   *  slot — last caller wins (useCall is the sole consumer; it fans out internally). */
  onData(cb: (fromId: string, msg: unknown) => void): void
  /** Fires when a data link to a peer (re)opens — on the first connect AND after a self-heal re-dial. Lets
   *  the receiver kick a stalled transfer back to life the INSTANT its link returns (a fast `xresume`),
   *  instead of waiting the full stall timeout. SINGLE slot (useCall is the sole consumer). */
  onDataLinkOpen(cb: (peerId: string) => void): void
  /** Fires when a peer GRACEFULLY leaves — we received its `bye` over the P2P sig channel. Lets the roster drop it
   *  IMMEDIATELY (overriding rosterHold, which can't otherwise tell a leave from a broker flap). SINGLE slot. */
  onPeerLeft(cb: (peerId: string) => void): void
  /**
   * The safety code (SAS) for one live peer — derived from the ACTUAL pair of DTLS
   * certificates, so two honest peers see the same emoji and a MITM is exposed.
   * Null when that peer isn't connected or the browser won't surface the negotiated
   * remote cert (then there's no honest code to show — never faked). See safetyCode.ts.
   */
  safetyCodeFor(peerId: string): Promise<SafetyInfo | null>
  /** Connection diagnostic for this peer (direct/relay + RTT + packet loss) from
   *  getStats, or null if it isn't connected yet / stats are unavailable. */
  connectionInfoFor(peerId: string): Promise<ConnInfo | null>
  /**
   * Per-peer media perception gate (capabilities `see-screen` / `hear-audio`). The
   * predicate decides, per peer + lane, whether that peer may RECEIVE the real track;
   * when it may not, the mesh substitutes a flowing placeholder on JUST that peer's
   * connection — a targeted replaceTrack (the same iOS-safe swap as a camera toggle,
   * never a re-dial). Supply the call-lifetime placeholders alongside. Re-applied on
   * every track swap and new dial; pass a null gate to disable. Optional: the LAN /
   * preview backends don't implement it (data-channel gating still applies there).
   */
  setMediaGate?(
    gate: ((peerId: string, kind: GateKind) => boolean) | null,
    placeholders?: { video: MediaStreamTrack | null; audio: MediaStreamTrack | null },
  ): void
  /** Re-apply the current media gate to every live connection (call when a grant, or
   *  whether we're screen-sharing, changes). No-op until setMediaGate is configured. */
  applyMediaGate?(): void
  close(): void
}

interface Link {
  pc: RTCPeerConnection // OWNED media pc — signaling rides the data channel, not PeerJS/the broker (L3/L4 enabler)
  initiatedByUs: boolean
  polite: boolean // perfect-negotiation role: the non-initiator rolls back on a glare (simultaneous offers)
  makingOffer: boolean
  remoteSet: boolean // a remote description has been applied → buffered ICE can be added
  pendingIce: RTCIceCandidateInit[] // ICE that arrived before the remote description
  relay: boolean // L4: this pc was escalated to relay-only (iceTransportPolicy:'relay')
}

/** A direct data connection to one peer, with a small until-open send buffer (a
 *  DataConnection isn't writable the instant it's created). */
interface DataLink {
  conn: DataConnection
  buf: unknown[]
  /** When this link was dialed (wireLink). Lets the heartbeat spot a sig channel stuck 'connecting' — ICE up
   *  but the data channel never OPENED — which peerjs never reports via close/error, and re-establish it. */
  since: number
  /** Last time ANY data arrived on this channel (init = since). A channel peerjs reports OPEN but that carries
   *  nothing — no 'mh' keepalive for seconds — is a dead-but-open SCTP (seen over relay on iOS PWA): the peer
   *  looks connected yet the offer/heartbeat never flows. The watchdog re-establishes it off staleness here. */
  lastRecv: number
}

export function createVoiceMesh(opts: {
  peer: Peer
  selfId: string
  onRemote: (id: string, stream: MediaStream | null) => void
  /** RTCConfiguration for the OWNED media pcs (iceServers; per-pc iceTransportPolicy for L4 relay). PeerJS still
   *  owns the data + presence connections — we only take over MEDIA so its signaling can ride the data channel. */
  rtcConfig?: RTCConfiguration
}): VoiceMesh {
  const { peer, selfId, onRemote, rtcConfig } = opts
  const links = new Map<string, Link>()
  let local: MediaStream | null = null
  let closed = false
  let admit: (peerId: string) => boolean = () => true // room human-cap gate (setAdmit); default accepts everyone

  // Drop GRACE: a transient roster gap (a broker reconnect shrinks the roster for ~a round-trip on flaky cellular)
  // must NOT tear down established media/data — it's P2P/TURN and never needed the broker (room.ts: "the media mesh
  // keeps flowing meanwhile"). When a peer vanishes from the roster we wait this long; if they reappear we cancel
  // the teardown (no flinch); only SUSTAINED absence (a real leave) drops them. Without this, every WS blip dropped
  // ALL media and re-dialled → a connection storm that overwrote the live video stream with empty re-dials.
  const DROP_GRACE_MS = 7000
  const pendingMediaDrop = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingDataDrop = new Map<string, ReturnType<typeof setTimeout>>()

  // L1 media recovery (docs/media-control-plane.md — "data channel as master"). The heartbeat (below) measures our
  // INBOUND media per pc; a link carrying ~0 media for RECOVER_AFTER_MS — whether it never connected (stalled ICE)
  // or went half-open (ice=connected but dead) — is recovered by ONE side (the initiator) re-dialling, the other
  // nudging it over the reliable data channel ({t:'mh-dead'}). Bounded. This is the SINGLE recovery path — it
  // replaces the old armMediaWatchdog + armDropWatch, so no competing timers fight each other. createMediaPc closes
  // the dead pc first, so a re-create is a fresh setup, never live churn (which crashes iOS WebKit). Two triggers
  // feed it: the heartbeat's no-flow detection (half-open) and the pc's 'failed' state (a hard ICE death).
  const RECOVER_AFTER_MS = 9000 // ~4-5 zero-flow heartbeats — absorbs the connect + first byte-delta before acting
  const MIN_FLOW_KBPS = 1
  const MAX_RECOVER = 3
  // Stuck-connect watchdog (heartbeat, below). A signaling-socket flap DURING setup can strand a peer in a limbo
  // peerjs never surfaces: the sig DataConnection reaches ICE-connected but its data channel never OPENS (no
  // close/error → wireLink's teardown re-dial never fires), and/or a media pc hangs at ice=new. Neither the
  // never-dialed heal (a link EXISTS) nor L1 recovery (never 'connected', never 'failed') owns it. Confirmed on an
  // iPhone PWA: WS close 1006 → pc0 ever=ø, pc1 ice=new, silent. Past STUCK_MS we force a clean re-establish;
  // bounded by MAX_RECOVER so a genuinely hostile path can't churn (live churn crashes iOS WebKit).
  const STUCK_MS = 8000
  // A sig channel peerjs reports OPEN but that has carried NO data for this long is dead-but-open (a stalled SCTP
  // over relay — seen intermittently on iOS PWA: pc0 ice=connected but ever=ø, so the media offer/heartbeat never
  // flows and the peer is silent). Both sides send an 'mh' keepalive every ~2s over sig, so a live channel refreshes
  // lastRecv well within this; only a truly dead one trips it. The watchdog re-establishes it like a never-opened one.
  const SIG_DEAD_MS = 8000
  const stuckCount = new Map<string, number>()
  // Mesh diagnostics (OFF by default). Per-lane data-channel lifecycle + the media-recovery decision, so a future
  // "why did the sig heartbeat go missing / why did media churn" is ANSWERABLE from logs instead of inferred (the data
  // channel layer was a blind spot). Enable with localStorage['kbz.debug']='1' (the conn-debug flag) or
  // window.__kbzMeshLog=true (the agent driver sets it from MESH_DEBUG). The '[kibitz]' prefix makes the agent's
  // console-forwarder (agent.mjs — matches /kibitz/) ship these to CloudWatch. Read-only; never alters behaviour.
  const meshLogOn = () => {
    try {
      return debugEnabled() || !!(globalThis as { __kbzMeshLog?: boolean }).__kbzMeshLog
    } catch {
      return false
    }
  }
  const mlog = (...a: unknown[]) => {
    if (meshLogOn())
      try {
        console.log('[kibitz][mesh]', ...a)
      } catch {
        /* logging must never throw */
      }
  }
  const sid = (id: string) => (id || '').slice(0, 6) // short peer id for readable logs
  const lastFlow = new Map<string, number>() // peer id → last ms media flowed (seeded at link creation)
  const recoverCount = new Map<string, number>() // peer id → re-dials spent (reset the moment media flows)
  // Per current-pc: has inbound media EVER flowed on it? A pc that reaches ice=connected but never receives (STUN
  // passes over a prflx pair, the media 5-tuple is dropped by 4G CGNAT — the one-way case) drives redialPlan to skip
  // the gentle rungs and go RELAY-only. Reset on each fresh pc (createMediaPc); set true when the heartbeat sees flow.
  const everFlowed = new Map<string, boolean>()
  // SESSION-STICKY "was this peer EVER a real, media-connected participant?" (unlike everFlowed, which resets to false
  // on every redial). rosterHold holds a roster-ABSENT peer through a broker flap ONLY if it's in here — a peer whose
  // media NEVER flowed and then vanishes was never real (a GHOST: sig channel + 'mh' keepalive up, but media never
  // connected — the 4G half-open case). Holding those forever kept the agent "not alone" so it never hit the empty-
  // room self-exit → its slot stayed locked → re-summon deduped and failed. Set once on first flow; cleared on a clean
  // drop / teardown.
  const peerFlowedOnce = new Set<string>()
  // Instrumentation only (the conn-debug overlay reads globalThis.__kbzMeshHeal). Per peer: m-recreate SENT (initiator)
  // / RECV (answerer) / rebuilds. Comparing the two devices separates "the heal signal was LOST on the 4G link"
  // (initiator ↑≥1, answerer ↓0) from "RTP never flowed despite a completed handshake". Pure counters, no behavior.
  const healStats = new Map<string, { s: number; r: number; rb: number }>()
  const bumpHeal = (id: string, k: 's' | 'r' | 'rb') => {
    const h = healStats.get(id) ?? { s: 0, r: 0, rb: 0 }
    h[k]++
    healStats.set(id, h)
    try {
      const pub: Record<string, { s: number; r: number; rb: number }> = {}
      for (const [pid, v] of healStats) pub[sid(pid)] = v
      ;(globalThis as unknown as { __kbzMeshHeal?: unknown }).__kbzMeshHeal = pub
    } catch {
      /* overlay-only; never let telemetry throw into the mesh */
    }
  }
  const presentPeers = new Set<string>() // the current media roster (synced in setRoster) — "is this peer still here?"
  const leftPeers = new Set<string>() // peers that sent a graceful `bye` — excluded from the hold + not re-dialled
  const pendingRelay = new Set<string>() // L4: peers whose next REBUILD should be relay-only (from an m-recreate{relay})
  // STICKY relay latch (vs the one-shot pendingRelay above): once a link escalates to relay, EVERY future pc for
  // that peer stays relay for the rest of the session — a self-heal / re-dial can't silently downgrade it back to
  // the dead prflx pair (the 4G churn). Set when a relay pc is created OR a relay-tagged m-sdp/m-recreate arrives;
  // cleared only on the peer leaving (so a fresh re-join starts direct-first again). No-op under FORCE_RELAY (all
  // pcs are already relay, so nothing escalates and this never populates).
  const relayLatched = new Set<string>()

  // --- Per-peer media perception gate (capability layer, docs/agent-platform.md §media).
  // The real outgoing track per lane (what an ALLOWED peer receives), the substitute
  // placeholders (what a WITHHELD peer receives — a flowing black/silent track), and the
  // gate predicate. Each is applied per-connection via a targeted replaceTrack, so a peer
  // lacking `see-screen`/`hear-audio` never gets those frames/samples — sender-side, no
  // re-dial. Inert (every peer allowed) until setMediaGate configures a real predicate.
  let mediaGate: ((peerId: string, kind: GateKind) => boolean) | null = null
  const gatePh: Record<GateKind, MediaStreamTrack | null> = { audio: null, video: null, share: null, shareAudio: null }
  const realTrack: Record<GateKind, MediaStreamTrack | null> = { audio: null, video: null, share: null, shareAudio: null }
  // Per-LANE latch (not one shared boolean): the fail-closed warn is the only operator-visible signal that media is
  // being dropped for a missing placeholder, so the first lane to fail-close must not silence it for the others.
  const failClosedWarned: Record<GateKind, boolean> = { audio: false, video: false, share: false, shareAudio: false }

  // Apply the gate for ONE lane to ONE connection: swap that lane's sender to the track the
  // peer is entitled to. ALLOWED → the real track. WITHHELD → a flowing placeholder (which keeps
  // the sender findable so a later grant can restore the real track). If a placeholder could NOT
  // be minted, withholding FAILS CLOSED — `gatedTrack` returns null and we replaceTrack(null), so
  // a withheld peer gets nothing rather than leaking the real media (a capability gate must never
  // fail open). Placeholders ~always mint; the null path is a rare safety net (we warn once).
  const applyKind = (id: string, pc: RTCPeerConnection, kind: GateKind) => {
    if (!pc) return
    const allowed = !mediaGate || mediaGate(id, kind)
    const want = gatedTrack(allowed, realTrack[kind], gatePh[kind])
    if (allowed && !want) return // nothing negotiated on this lane yet — leave it
    if (!allowed && !want && !failClosedWarned[kind]) {
      failClosedWarned[kind] = true
      // eslint-disable-next-line no-console
      console.warn(`[kibitz] media gate: no ${kind} placeholder — failing CLOSED (withheld peers get no ${kind})`)
    }
    // Address the lane's OWN sender (per-transceiver), not "any sender of this kind" — the two video lanes
    // (camera + share) are both kind:'video', so a kind match would clobber both.
    const sender = laneSender(pc, kind)
    if (sender && sender.track !== want) {
      void sender.replaceTrack(want).catch(() => {
        /* sender gone mid-swap — the connection is closing anyway */
      })
    }
  }
  const applyConn = (id: string, pc: RTCPeerConnection) => {
    applyKind(id, pc, 'audio')
    applyKind(id, pc, 'video')
    applyKind(id, pc, 'share')
    applyKind(id, pc, 'shareAudio') // no-op when the lane wasn't negotiated (laneSender → null)
  }

  // --- Data mesh: a direct DataConnection to every peer, parallel to media, so
  // content (chat/co-browse/pay/ink) is peer-to-peer with no authority relay. Same
  // glare-free rule (smaller id dials) via planRoster, but independent of media —
  // camera toggles never touch it.
  const dataLinks = new Map<string, DataLink>()
  const dataDialled = new Set<string>()
  // BULK content channel: a SECOND DataConnection per peer (label 'bulk') that carries ALL {k} content +
  // chunk frames, so a big transfer can't head-of-line-block the media signaling that rides the primary
  // ('sig') connection — the exact stall that froze a painter mid-call. Dialed only AFTER the peer advertises
  // support (the {t:'cap'} handshake on sig), so we never open a 2nd connection to an OLD peer that can't tell
  // the two apart; those stay sig-only (broadcastData/dataBufferedAmount/dataLinkOpen transparently fall back
  // to the sig link). Same glare rule (smaller id dials), same self-heal re-dial.
  const bulkLinks = new Map<string, DataLink>()
  const bulkDialled = new Set<string>()
  const bulkCapable = new Set<string>() // peers that sent {t:'cap'} → safe to dial a 'bulk' connection to
  // Pending self-heal re-dials, keyed by peer id (one in flight per peer per channel; cancelled on close).
  const dataRedialTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const bulkRedialTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let onDataCb: ((fromId: string, msg: unknown) => void) | null = null
  let onDataLinkOpenCb: ((peerId: string) => void) | null = null
  let onPeerLeftCb: ((peerId: string) => void) | null = null

  // Self-heal: a data link can drop UNEXPECTEDLY mid-session — PeerJS closes the whole DataConnection when
  // a single `dataChannel.send()` throws (a TURN-relayed / congested link raises "Failure to send data"),
  // and an ICE blip closes it too. Without a re-dial the link is gone for good (planRoster skips a peer
  // still in the dialled set), so any in-flight transfer to that peer dies with no path to resume. So when a
  // link we INITIATED (we're this pair's smaller id ⇒ it's in the dialled set) drops while the peer is still
  // wanted, re-dial after a short backoff; the fresh link lets the receiver's `xresume` recover the
  // transfer. The answerer side can't dial (glare rule) — it relies on the initiator's re-dial. Both the sig
  // and bulk channels self-heal identically (role-parameterized).
  const REDIAL_DELAY_MS = 800
  const linksFor = (role: 'sig' | 'bulk') => (role === 'bulk' ? bulkLinks : dataLinks)
  const scheduleRedial = (id: string, role: 'sig' | 'bulk') => {
    const dialled = role === 'bulk' ? bulkDialled : dataDialled
    const timers = role === 'bulk' ? bulkRedialTimers : dataRedialTimers
    const links = linksFor(role)
    if (closed || !dialled.has(id) || timers.has(id)) return
    const t = setTimeout(() => {
      timers.delete(id)
      // Re-check at fire time: still wanted, still no live link, not closed (state may have moved on).
      if (closed || !dialled.has(id) || links.has(id)) return
      if (role === 'bulk') dialBulk(id)
      else dialData(id)
    }, REDIAL_DELAY_MS)
    timers.set(id, t)
  }

  // A direct data connection, role-parameterized: 'sig' (the primary) carries media signaling + heartbeat +
  // the bulk-capability handshake (and is the content fallback for old/pre-bulk peers); 'bulk' carries content
  // only. The two are independent SCTP associations, so a big transfer on 'bulk' can't head-of-line-block the
  // media-recovery signaling on 'sig'.
  const wireLink = (conn: DataConnection, role: 'sig' | 'bulk') => {
    const links = linksFor(role)
    const timers = role === 'bulk' ? bulkRedialTimers : dataRedialTimers
    const dialled = role === 'bulk' ? bulkDialled : dataDialled
    const link: DataLink = { conn, buf: [], since: Date.now(), lastRecv: Date.now() }
    links.set(conn.peer, link)
    // A fresh link supersedes any pending re-dial for this peer on THIS channel.
    const pending = timers.get(conn.peer)
    if (pending) {
      clearTimeout(pending)
      timers.delete(conn.peer)
    }
    conn.on('open', () => {
      for (const m of link.buf.splice(0)) {
        try {
          conn.send(m)
        } catch {
          /* connection died between open and flush */
        }
      }
      // Only for the CURRENT link (a re-dial may have superseded this conn between connect and open).
      if (!closed && links.get(conn.peer)?.conn === conn) {
        mlog('lane OPEN', role, sid(conn.peer))
        if (role === 'sig') {
          startMedia(conn.peer) // the SIG channel carries the media offer → start media now it's open (initiator-side)
          // Advertise that we speak the bulk protocol; the pair's initiator opens a 'bulk' connection on receipt.
          sendOver(link, { t: 'cap', bulk: 1 })
        } else {
          // Transfers ride the BULK channel ONLY (so their chunks never straddle channels), so the resume nudge
          // — useCall re-sends in-flight transfers — keys off BULK open, both on first connect and after a re-dial.
          onDataLinkOpenCb?.(conn.peer)
        }
      }
    })
    conn.on('data', (d) => {
      link.lastRecv = Date.now() // liveness: anything received (mh keepalive, m-sdp, content) proves the channel is alive
      if (role === 'sig') {
        // Graceful leave: the peer told us over the P2P sig channel it's leaving → drop it NOW (tear down its links
        // + tell useCall to remove its tile). Overrides rosterHold, which can't otherwise tell a leave from a broker
        // flap. The keepalive-silence timeout is only the backstop for UNGRACEFUL exits (crash — no bye sent).
        if (d && typeof d === 'object' && (d as { t?: unknown }).t === 'bye') {
          leftPeers.add(conn.peer) // excluded from the hold + not re-dialled; the media pc is reaped by the drop grace
          onRemote(conn.peer, null) // clear the peer's remote media immediately
          const dl = dataLinks.get(conn.peer)
          if (dl) {
            dataLinks.delete(conn.peer)
            try {
              dl.conn.close()
            } catch {
              /* ignore */
            }
          }
          onPeerLeftCb?.(conn.peer)
          return
        }
        // Media-health heartbeat (control plane — docs/media-control-plane.md): the peer reporting its INBOUND media
        // rate (= how our OUTBOUND is landing there). Internal control message — record it, do NOT forward to the app.
        if (d && typeof d === 'object' && (d as { t?: unknown }).t === 'mh') {
          const m = d as { v?: number; a?: number; ov?: number; oa?: number }
          const cur = mediaHealth.get(conn.peer) ?? { rxV: 0, rxA: 0, peerV: 0, peerA: 0, at: 0 }
          // peerV/peerA = what the peer RECEIVES from us; peerTxV/peerTxA = what the peer SENDS (ov/oa) — the latter
          // lets our recovery skip a peer that's just quiet instead of churning its alive link.
          mediaHealth.set(conn.peer, { ...cur, peerV: m.v ?? 0, peerA: m.a ?? 0, peerTxV: m.ov, peerTxA: m.oa, at: Date.now() })
          publishHealth()
          return
        }
        // L1 recovery nudge: the peer says our shared MEDIA link is dead → re-dial it if we're its initiator
        // (reDial() is a no-op for the non-initiator, so a stray nudge can't cause a glare). Internal — don't forward.
        if (d && typeof d === 'object' && (d as { t?: unknown }).t === 'mh-dead') {
          if (!closed) reDial(conn.peer)
          return
        }
        // Never-dialed nudge: an answerer with NO media link asks us, its initiator, to dial. The mirror of mh-dead
        // (which re-dials a DEAD link) for a link that was never created (a raced initial dial). startMedia is
        // idempotent + initiator-gated, so a stray nudge can't glare or double-dial. Internal — don't forward.
        if (d && typeof d === 'object' && (d as { t?: unknown }).t === 'm-dial') {
          if (!closed && shouldInitiate(selfId, conn.peer)) startMedia(conn.peer)
          return
        }
        // Bulk-capability advertisement → record it; if WE are this pair's initiator, open the 'bulk' connection.
        // An OLD peer never sends this, so we never dial 'bulk' to one (it can't tell the connections apart).
        if (d && typeof d === 'object' && (d as { t?: unknown }).t === 'cap') {
          bulkCapable.add(conn.peer)
          maybeDialBulk(conn.peer)
          return
        }
        // Media signaling (owned transport): offer/answer (m-sdp) + ICE (m-ice) ride the SIG channel, not the broker.
        if (d && typeof d === 'object' && /^m-(sdp|ice|recreate)$/.test(String((d as { t?: unknown }).t))) {
          onMediaSignal(conn.peer, d as { t?: string; d?: RTCSessionDescriptionInit; c?: RTCIceCandidateInit })
          return
        }
      }
      // Content. On BULK this is the normal path; on SIG it's the fallback for old/pre-bulk peers. Deliver only
      // from the CURRENT link for this peer — a re-dial replaces the link (the dialer closes the old conn first),
      // and a stale/duplicate conn could still fire a buffered 'data' after its replacement; drop it.
      if (!closed && links.get(conn.peer)?.conn === conn) onDataCb?.(conn.peer, d)
    })
    const teardown = () => {
      // Only act on the CURRENT link's drop — the dialer closes a prior conn before installing the new one
      // (and a clean roster-drop deletes the link first), so a stale teardown finds a different/absent link
      // and no-ops. A genuine unexpected drop of the live link → re-dial if we still want this peer + we initiated.
      if (links.get(conn.peer)?.conn === conn) {
        links.delete(conn.peer)
        const willRedial = !closed && dialled.has(conn.peer)
        mlog('lane CLOSE', role, sid(conn.peer), willRedial ? '→ re-dial scheduled' : '(no re-dial: not wanted / not our dial)')
        if (willRedial) scheduleRedial(conn.peer, role)
      }
    }
    conn.on('close', teardown)
    conn.on('error', teardown)
  }

  const dialData = (id: string) => {
    if (closed) return // data needs no local stream — unlike media
    const prev = dataLinks.get(id)
    if (prev) {
      dataLinks.delete(id)
      try {
        prev.conn.close()
      } catch {
        /* already closed */
      }
    }
    const conn = peer.connect(id, { reliable: true })
    if (conn) wireLink(conn, 'sig')
  }

  const dialBulk = (id: string) => {
    if (closed) return
    const prev = bulkLinks.get(id)
    if (prev) {
      bulkLinks.delete(id)
      try {
        prev.conn.close()
      } catch {
        /* already closed */
      }
    }
    const conn = peer.connect(id, { reliable: true, label: 'bulk' })
    if (conn) wireLink(conn, 'bulk')
  }

  // Open the bulk channel iff: the peer advertised support (cap), WE are the pair's initiator (we dialed its sig
  // link ⇒ the smaller id), and we don't already have / aren't already dialing one. Glare-free, exactly like sig.
  const maybeDialBulk = (id: string) => {
    if (closed || !bulkCapable.has(id) || !dataDialled.has(id)) return
    if (bulkDialled.has(id) || bulkLinks.has(id)) return
    bulkDialled.add(id)
    dialBulk(id)
  }

  // Someone opened a data connection to us. A 'bulk'-labelled one is the content channel; anything else (a 'sig'
  // dial, or an OLD peer's unlabelled connection) is the primary.
  const onIncomingData = (conn: DataConnection) => {
    if (!closed) wireLink(conn, conn.label === 'bulk' ? 'bulk' : 'sig')
  }
  peer.on('connection', onIncomingData)

  const sendOver = (link: DataLink | undefined, msg: unknown) => {
    if (!link) return
    const doSend = () => {
      if (link.conn.open) {
        try {
          link.conn.send(msg)
        } catch {
          /* dropped mid-send */
        }
      } else {
        link.buf.push(msg) // flushed on 'open'
      }
    }
    // DEV-ONLY fault-injection seam — statically removed from prod builds (import.meta.env.DEV is false there, so the
    // whole block is dead-code-eliminated). e2e/faults.mjs sets globalThis.__kbzFaults to DROP a named control message
    // (a 4G data-channel loss, e.g. 'm-recreate') or DELAY it (a laggy channel → late signals / glare, or a delayed
    // 'mh' heartbeat that used to churn a healthy link). See e2e/link-faults.mjs.
    if (import.meta.env.DEV) {
      const f = (globalThis as { __kbzFaults?: { dropTypes?: string[]; delayTypes?: string[]; delayMs?: number } }).__kbzFaults
      const mt = msg && typeof msg === 'object' ? (msg as { t?: unknown }).t : undefined
      if (f && typeof mt === 'string') {
        if (Array.isArray(f.dropTypes) && f.dropTypes.includes(mt)) return // simulate the loss
        if (Array.isArray(f.delayTypes) && f.delayTypes.includes(mt)) {
          setTimeout(doSend, f.delayMs ?? 800) // simulate a laggy channel — the message arrives late
          return
        }
      }
    }
    doSend()
  }

  // ── OWNED media transport (docs/media-control-plane.md "data channel as master") ───────────────────────────────
  // We create the media RTCPeerConnection ourselves and carry its signaling (offer/answer/ICE) over the RELIABLE
  // DATA channel — not PeerJS/the broker. That's the enabler for L3 (broker-independent ICE-restart) and L4 (per-pc
  // relay: iceTransportPolicy:'relay' on ONE pc). PeerJS still owns data + presence; we only took over MEDIA.
  // Glare-free via perfect-negotiation (MDN): the non-initiator is "polite" and rolls back on a simultaneous offer.
  const rtcFor = (relay: boolean): RTCConfiguration => ({ ...(rtcConfig ?? {}), ...(relay ? { iceTransportPolicy: 'relay' as const } : {}) })

  const createMediaPc = (id: string, initiatedByUs: boolean, relay = false): Link => {
    // Sticky relay: this call's `relay` ask OR an existing latch → relay; and any relay pc LATCHES the peer so the
    // decision is durable + both-sided (no rebuild can drop back to prflx). See relayLatched.
    const useRelay = relay || relayLatched.has(id)
    if (useRelay) relayLatched.add(id)
    everFlowed.set(id, false) // fresh pc — no media has flowed on it yet (drives redialPlan's connected-but-dead check)
    const prev = links.get(id)
    if (prev) {
      links.delete(id)
      try {
        prev.pc.close()
      } catch {
        /* already closed */
      }
    }
    const pc = new RTCPeerConnection(rtcFor(useRelay))
    const link: Link = { pc, initiatedByUs, polite: !shouldInitiate(selfId, id), makingOffer: false, remoteSet: false, pendingIce: [], relay: useRelay }
    links.set(id, link)
    lastFlow.set(id, Date.now()) // start L1's no-flow clock; the heartbeat refreshes it once media flows
    // Local tracks in the stream's order → transceivers in laneSender's expected order (mic, camera, share,
    // share-audio), so the per-lane gate + remoteShare* mapping carry over. Ensure both base kinds exist so a
    // camera-off / muted peer can still RECEIVE the other side (peer.call used offerToReceiveAudio/Video for this).
    if (local) for (const t of local.getTracks()) pc.addTrack(t, local)
    const kinds = () => pc.getTransceivers().map((t) => t.receiver.track?.kind ?? t.sender.track?.kind)
    if (!kinds().includes('audio')) pc.addTransceiver('audio')
    if (!kinds().includes('video')) pc.addTransceiver('video')
    pc.ontrack = (e) => {
      if (!closed) onRemote(id, e.streams[0] ?? new MediaStream([e.track]))
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) sendOver(dataLinks.get(id), { t: 'm-ice', c: e.candidate.toJSON() })
    }
    pc.onnegotiationneeded = () => {
      void (async () => {
        try {
          link.makingOffer = true
          await pc.setLocalDescription()
          const ld = pc.localDescription
          // PLAIN {type,sdp} — PeerJS's serializer can't encode a native RTCSessionDescription (it arrives empty).
          // Carry the relay latch ON the offer (not a separate, droppable m-recreate) so the answerer/self-heal
          // learns "this link is relay" atomically with the SDP it already processes — a lost signal can no longer
          // strand the pair asymmetric (one relay, one prflx = the 4G-dead `pair=p/r`).
          if (ld) sendOver(dataLinks.get(id), { t: 'm-sdp', d: { type: ld.type, sdp: ld.sdp }, relay: relayLatched.has(id) })
        } catch {
          /* transient — L1 recovery re-offers */
        } finally {
          link.makingOffer = false
        }
      })()
    }
    pc.onconnectionstatechange = () => {
      // ICE gave up (a hard death the heartbeat's no-flow check would only catch later) → recover now.
      if (pc.connectionState === 'failed' && !closed && presentPeers.has(id)) recover(id)
    }
    applyConn(id, pc) // gate this peer from the first frame (withheld lanes → placeholder)
    return link
  }

  // Media signaling arriving over the data channel (perfect-negotiation, MDN pattern).
  const onMediaSignal = (id: string, msg: { t?: string; d?: RTCSessionDescriptionInit; c?: RTCIceCandidateInit }) => {
    void (async () => {
      if (closed) return
      let link = links.get(id)
      if (msg.t === 'm-recreate') {
        bumpHeal(id, 'r') // answerer RECEIVED the heal signal (↓). If a stuck 4G peer shows mR↓0, the signal was lost.
        // The peer is recovering a dead link by rebuilding — drop our (also-dead) pc so its incoming offer creates a
        // fresh one with fresh senders on BOTH sides (matches what PeerJS's re-dial did implicitly). If the peer
        // escalated to relay (L4), mark it so OUR rebuilt pc relays too → the pair meets on TURN.
        if (link) {
          try {
            link.pc.close()
          } catch {
            /* ignore */
          }
          links.delete(id)
        }
        if ((msg as { relay?: boolean }).relay) {
          pendingRelay.add(id)
          relayLatched.add(id) // sticky: stay relay for the rest of the session
        } else pendingRelay.delete(id) // clear only the one-shot hint — never UN-latch (sticky)
        return
      }
      if (msg.t === 'm-sdp' && msg.d) {
        // A relay-tagged offer/answer LATCHES this side to relay too — carried ON the SDP, so it survives even when
        // the separate m-recreate was dropped on a degraded channel (the loss that stranded the pair asymmetric).
        // Set BEFORE the (self-heal) createMediaPc below so the rebuilt pc picks it up via relayLatched.
        if ((msg as { relay?: boolean }).relay) relayLatched.add(id)
        // SELF-HEAL a lost m-recreate (the 4G half-open): an OFFER arriving on a link whose pc is dead (closed/failed)
        // can't be answered on that pc — the offer IS the peer's re-dial. Drop the stale link so the offer rebuilds a
        // fresh one, exactly as an m-recreate would have. Recovery then survives even when the m-recreate signal was
        // dropped on a degraded data channel — the re-dial's offer no longer depends on a second, separately-lost msg.
        if (link && msg.d.type === 'offer' && (link.pc.connectionState === 'closed' || link.pc.connectionState === 'failed')) {
          try {
            link.pc.close()
          } catch {
            /* ignore */
          }
          links.delete(id)
          link = undefined
        }
        if (!link) {
          if (!admit(id)) return // room human-cap: refuse an over-cap peer's first offer
          link = createMediaPc(id, false, pendingRelay.has(id)) // answerer, first contact (relay if L4-escalated)
          pendingRelay.delete(id)
        }
        const pc = link.pc
        const desc = msg.d
        const collision = desc.type === 'offer' && (link.makingOffer || pc.signalingState !== 'stable')
        if (collision && !link.polite) return // impolite peer ignores a colliding offer (its own will win)
        try {
          if (collision) await Promise.all([pc.setLocalDescription({ type: 'rollback' }), pc.setRemoteDescription(desc)])
          else await pc.setRemoteDescription(desc)
          link.remoteSet = true
          for (const c of link.pendingIce.splice(0)) {
            try {
              await pc.addIceCandidate(c)
            } catch {
              /* stale candidate */
            }
          }
          if (desc.type === 'offer') {
            await pc.setLocalDescription()
            const la = pc.localDescription
            if (la) sendOver(dataLinks.get(id), { t: 'm-sdp', d: { type: la.type, sdp: la.sdp }, relay: relayLatched.has(id) })
          }
        } catch {
          /* transient — recovery re-offers */
        }
      } else if (msg.t === 'm-ice' && msg.c && link) {
        if (link.remoteSet)
          try {
            await link.pc.addIceCandidate(msg.c)
          } catch {
            /* stale */
          }
        else link.pendingIce.push(msg.c) // buffer until the remote description lands
      }
    })()
  }

  // L1 recovery actions. recover() is the trigger (heartbeat no-flow / a peer's nudge / a pc 'failed'); reDial()
  // re-creates the media pc (initiator-only, bounded) whose onnegotiationneeded re-offers over the data channel.
  // createMediaPc closes the dead pc FIRST, so it's a fresh setup, never live churn (which crashes iOS WebKit).
  const reDial = (id: string) => {
    if (closed || !shouldInitiate(selfId, id) || !local) return // only the initiator drives recovery (no glare)
    // DATA CHANNEL AS MASTER: the whole media re-dial (m-recreate + offer/answer + ICE) signals over the sig data
    // channel, so re-dialling while it's CLOSED is futile churn — it tears down the live media pc, then stalls with no
    // path to re-offer. Defer instead: the data channel heals itself (scheduleRedial → the broker, independent of
    // media) and the 2s heartbeat re-fires media recovery once the channel is back. Don't even spend a budget slot.
    if (!dataLinks.get(id)?.conn?.open) {
      mlog('reDial DEFER', sid(id), '(sig channel down — let it self-heal first; media follows)')
      return
    }
    const n = recoverCount.get(id) ?? 0
    if (n >= MAX_RECOVER) {
      mlog('reDial BUDGET-EXHAUSTED', sid(id), `${n}/${MAX_RECOVER}`)
      return // bounded — a hostile network won't be fixed by churning
    }
    recoverCount.set(id, n + 1)
    lastFlow.set(id, Date.now()) // give the attempt RECOVER_AFTER_MS to connect before judging it again
    const link = links.get(id)
    // Pick the rung (mediaRecover.redialPlan). Gentlest → heaviest: ICE-restart (n=0), re-create (n=1), relay-only (n≥2)
    // — EXCEPT a pc that reached ice=connected but NEVER carried media (connected && !everFlowed) is the 4G-CGNAT
    // one-way case (prflx passes STUN, media dropped): it SKIPS the gentle rungs (they'd reconnect to the same dead
    // prflx pair) and goes RELAY-only immediately, so the CGNAT'd peer receives over its own stable TURN relay.
    const plan = redialPlan(n, { connected: !!link && link.pc.connectionState === 'connected', everFlowed: !!everFlowed.get(id) })
    mlog('reDial', sid(id), `attempt ${n + 1}/${MAX_RECOVER}`, plan.iceRestart ? 'ICE-restart' : plan.relay ? 'recreate-relay' : 'recreate')
    // L3: in-place ICE-restart — re-gather a dead PATH over the data channel, keeping senders. Only when the plan
    // allows it (skipped for a connected-but-never-flowed pc → straight to the relay re-create below).
    if (plan.iceRestart && link && link.pc.connectionState !== 'closed' && link.pc.signalingState === 'stable') {
      try {
        link.pc.restartIce() // → onnegotiationneeded → re-offer with fresh ICE over the data channel
        return
      } catch {
        /* not restartable → fall through to a full re-create */
      }
    }
    // n=1: full re-create (cycling policy). n≥2 OR connected-but-dead: full re-create RELAY-ONLY — force THIS link
    // through TURN (per-pc; everyone else keeps cycling).
    const relay = plan.relay
    bumpHeal(id, 's') // initiator SENT the heal signal (↑) over the P2P data channel
    sendOver(dataLinks.get(id), { t: 'm-recreate', relay })
    bumpHeal(id, 'rb') // and rebuilt our own pc
    createMediaPc(id, true, relay)
  }
  const recover = (id: string) => {
    lastFlow.set(id, Date.now()) // cooldown: don't re-trigger (self or nudge) for another RECOVER_AFTER_MS — let this attempt land
    if (shouldInitiate(selfId, id)) reDial(id)
    else sendOver(dataLinks.get(id), { t: 'mh-dead' }) // not our pair to dial → ask the initiator to re-create
  }

  // Start media with a peer once their DATA channel is open (it carries our offer). Initiator-only — the answerer
  // builds its pc reactively on the first m-sdp. Idempotent: skip if a link already exists.
  const startMedia = (id: string) => {
    if (closed || !local || links.has(id)) return
    if (!shouldInitiate(selfId, id) || !presentPeers.has(id)) return
    if (!dataLinks.get(id)?.conn?.open) return // the offer rides the data channel — wait until it's open
    createMediaPc(id, true) // onnegotiationneeded → offer over the data channel
  }

  // ── Media-health heartbeat (P1 of the media control plane — docs/media-control-plane.md) ─────────
  // Every HEARTBEAT_MS, measure our INBOUND media rate per media pc (getStats) and report it to that peer over the
  // RELIABLE data channel; record theirs in return. A half-open pc (ice=connected but no media) then shows up on
  // the channel that never fails: "I receive 0" and/or "peer reports receiving 0". P1 = detection + observability
  // ONLY — it publishes a snapshot for the debug overlay and takes NO recovery action yet (that's P2+).
  const HEARTBEAT_MS = 2000
  // peerTxV/peerTxA = the peer's reported OUTBOUND rate (its mh.ov/oa) — lets recovery tell a real half-open (peer
  // sending, we get ~0) from a peer that's just quiet (a mic-less agent / a muted human), which must NOT be re-dialed.
  const mediaHealth = new Map<string, { rxV: number; rxA: number; peerV: number; peerA: number; peerTxV?: number; peerTxA?: number; at: number }>()
  const mediaStatsLast = new Map<string, { v: number; a: number; tv: number; ta: number; t: number }>()
  // rosterHold liveness: a peer is "still here" only if its SIG data channel is OPEN *and* we've heard from it
  // within ROSTER_HOLD_TIMEOUT_MS (its 'mh' keepalive — sent even without media, see the heartbeat below). During a
  // broker flap the keepalive keeps flowing P2P (media dead, data channel up — the field capture) so the peer stays;
  // a real leave/crash STOPS it → the peer clears. `conn.open` alone was not enough: it LINGERS after an abrupt
  // teardown (no clean close frame), which stranded a departed peer's tile forever + duplicated it on rejoin.
  const heard = (id: string) => Date.now() - (mediaHealth.get(id)?.at ?? 0) < ROSTER_HOLD_TIMEOUT_MS
  const peerAlive = (id: string) => !leftPeers.has(id) && !!dataLinks.get(id)?.conn?.open && heard(id)
  const liveMeshPeers = () => {
    const out: string[] = []
    for (const [id, l] of dataLinks) if (!leftPeers.has(id) && l.conn?.open && heard(id)) out.push(id)
    return out
  }
  const publishHealth = () => {
    if (typeof window === 'undefined') return
    try {
      const now = Date.now()
      const snap: Record<string, { rxV: number; rxA: number; peerV: number; peerA: number; age: number }> = {}
      for (const [id, h] of mediaHealth) snap[id] = { rxV: h.rxV, rxA: h.rxA, peerV: h.peerV, peerA: h.peerA, age: h.at ? now - h.at : -1 }
      ;(window as unknown as { __kbzMediaHealth?: unknown }).__kbzMediaHealth = snap
    } catch {
      /* ignore */
    }
  }
  const heartbeat = setInterval(() => {
    if (closed) return
    // Never-dialed self-heal. The L1–L4 recovery ladder only re-dials an EXISTING half-open media pc (its triggers
    // — heartbeat no-flow, pc 'failed', the mh-dead nudge — all key off a media pc's getStats/state). So a media
    // link that was NEVER created (a missed/raced INITIAL dial — e.g. the iPhone as initiator over relay) has no
    // escape: the answerer waits forever, no media pc, channels=0/3, silent. Each tick, for a PRESENT peer whose
    // sig channel is up but who has NO media link: the INITIATOR re-runs startMedia (idempotent — a no-op once a
    // link exists), and the ANSWERER nudges the initiator with `m-dial` (the mirror of mh-dead: that recovers a
    // DEAD link, this recovers a link that never existed). Self-stops the instant a media link forms.
    for (const id of presentPeers) {
      if (links.has(id) || !dataLinks.get(id)?.conn?.open) continue
      if (shouldInitiate(selfId, id)) startMedia(id)
      else sendOver(dataLinks.get(id), { t: 'm-dial' })
    }
    // Stuck-connect watchdog — the WS-flap limbo (see STUCK_MS above). THREE states peerjs leaves hanging and no
    // other recovery reclaims:
    //   • sig NEVER OPENED — ICE up but conn.open false past STUCK_MS (peerjs fires no close/error → wireLink's
    //     teardown re-dial never runs);
    //   • sig OPEN BUT DEAD — conn.open true yet no data (not even the 2s 'mh' keepalive) for SIG_DEAD_MS: a stalled
    //     SCTP over relay (iOS PWA: pc0 ice=connected, ever=ø). peerjs reports it OPEN, so the never-opened check
    //     above skips it — but the media offer never flows, so the peer is silent. THIS was the missed case;
    //   • media pc that never reached 'connected' (stuck at ice=new).
    // For a PRESENT peer past the deadline: drop a stranded/stale media pc (the never-dialed heal re-creates it next
    // tick once the sig channel is healthy) and — dialer-only, so no glare — re-establish the sig channel (dialData
    // closes the old conn first: a clean re-establish, not live churn). Bounded by MAX_RECOVER; reset once media flows.
    for (const id of presentPeers) {
      const now2 = Date.now()
      const dl = dataLinks.get(id)
      const mlink = links.get(id)
      const sigStuck = !!dl && !dl.conn.open && now2 - dl.since > STUCK_MS
      const sigDead = !!dl && dl.conn.open && now2 - dl.lastRecv > SIG_DEAD_MS
      const sigBroken = sigStuck || sigDead
      const mediaStuck = !!mlink && !everFlowed.get(id) && mlink.pc.connectionState !== 'connected' && now2 - (lastFlow.get(id) ?? now2) > STUCK_MS
      if (!sigBroken && !mediaStuck) continue
      const n = stuckCount.get(id) ?? 0
      if (n >= MAX_RECOVER) continue // bounded — a genuinely hostile path won't be fixed by more churn
      stuckCount.set(id, n + 1)
      mlog('stuck-connect', sid(id), `sig=${sigStuck ? 'never-open' : sigDead ? 'dead-open' : 'ok'} media=${mediaStuck} → re-establish ${n + 1}/${MAX_RECOVER}`)
      // A media pc built over a broken/dead sig channel is stale too — drop it so a fresh sig re-dials it clean.
      if ((mediaStuck || sigBroken) && mlink) {
        links.delete(id)
        try {
          mlink.pc.close()
        } catch {
          /* already closed */
        }
      }
      if (sigBroken && dataDialled.has(id)) dialData(id) // only the side that dialed re-establishes (no glare)
    }
    // rosterHold liveness keepalive: for any peer we have an OPEN sig channel to but NO media link, media isn't
    // carrying the 'mh' heartbeat — send a bare one so BOTH sides keep a fresh last-heard time over the DATA
    // channel alone. That's the signal that tells a still-connected peer (broker flap: data up, media dead) from
    // one that actually left (channel closes / keepalive stops → mediaHealth.at goes stale → dropped). Covers
    // roster-absent HELD peers too — dataLinks outlives the roster via the drop grace. Media peers emit 'mh' below.
    for (const [id, dl] of dataLinks) {
      if (!dl.conn?.open || links.has(id)) continue
      sendOver(dl, { t: 'mh', v: 0, a: 0, ov: 0, oa: 0 })
    }
    for (const [id, link] of links) {
      const pc = link.pc
      if (!pc) continue
      void pc
        .getStats()
        .then((stats) => {
          if (closed) return
          let v = 0
          let a = 0
          let tv = 0
          let ta = 0
          stats.forEach((report) => {
            const r = report as { type?: string; kind?: string; mediaType?: string; bytesReceived?: number; bytesSent?: number }
            if (r.type === 'inbound-rtp') {
              if ((r.kind || r.mediaType) === 'video') v += r.bytesReceived ?? 0
              else if ((r.kind || r.mediaType) === 'audio') a += r.bytesReceived ?? 0
            } else if (r.type === 'outbound-rtp') {
              if ((r.kind || r.mediaType) === 'video') tv += r.bytesSent ?? 0
              else if ((r.kind || r.mediaType) === 'audio') ta += r.bytesSent ?? 0
            }
          })
          const now = Date.now()
          const last = mediaStatsLast.get(id)
          const kbps = (cur2: number, prev: number) => (last && now > last.t ? Math.max(0, Math.round(((cur2 - prev) * 8) / (now - last.t))) : 0)
          const rxV = kbps(v, last?.v ?? 0)
          const rxA = kbps(a, last?.a ?? 0)
          const txV = kbps(tv, last?.tv ?? 0)
          const txA = kbps(ta, last?.ta ?? 0)
          mediaStatsLast.set(id, { v, a, tv, ta, t: now })
          const cur = mediaHealth.get(id) ?? { rxV: 0, rxA: 0, peerV: 0, peerA: 0, at: 0 }
          mediaHealth.set(id, { ...cur, rxV, rxA })
          // Report OUR inbound (v/a) AND OUR outbound (ov/oa) to the peer — the outbound lets the peer tell a
          // half-open (we're sending but it gets ~0) from us being legitimately quiet (we send ~0), so it won't churn.
          sendOver(dataLinks.get(id), { t: 'mh', v: rxV, a: rxA, ov: txV, oa: txA })
          publishHealth()
          // L1: media flowing → reset the clock + budget; sustained zero past RECOVER_AFTER_MS → recover (re-dial).
          if (rxV + rxA >= MIN_FLOW_KBPS) {
            lastFlow.set(id, now)
            everFlowed.set(id, true) // this pc HAS carried inbound media → not the connected-but-dead prflx/CGNAT case
            stuckCount.delete(id) // connected + flowing → clear the stuck-connect budget so a LATER flap starts fresh
            peerFlowedOnce.add(id) // session-sticky: a REAL participant → rosterHold may now hold it through a flap
            // Reset the recovery budget only when BOTH directions flow (the peer's reported inbound too). A one-way
            // half-open (OUR outbound dead, our inbound fine) must NOT reset on our healthy inbound — else the
            // initiator loops on the gentle ICE-restart and never escalates to a re-create / relay.
            const h = mediaHealth.get(id)
            if (h && h.peerV + h.peerA >= MIN_FLOW_KBPS) recoverCount.delete(id)
          } else {
            // Data channel as master: re-dial ONLY a real half-open — the peer reports it IS sending (peerTx>0) but
            // we receive ~0. A peer that's simply QUIET (a mic-less voice agent, or a muted human → peerTx~0) is
            // alive-but-silent; re-dialing would only CHURN the link (it did — the agent's replies stopped arriving).
            // peerTx unknown (older peer that doesn't report outbound) → historical behavior (recover). This is why
            // the agent's constant keep-alive dither is no longer needed.
            const h = mediaHealth.get(id)
            const peerTx = h && h.peerTxV != null ? h.peerTxV + (h.peerTxA ?? 0) : null
            const sinceFlowMs = now - (lastFlow.get(id) ?? now)
            const willRecover = shouldRecoverMedia(
              { inboundKbps: rxV + rxA, sinceFlowMs, peerOutboundKbps: peerTx, neverFlowed: !everFlowed.get(id), connected: pc.connectionState === 'connected' },
              { minFlowKbps: MIN_FLOW_KBPS, recoverAfterMs: RECOVER_AFTER_MS },
            )
            // The diagnostic that was missing: WHY the watchdog acted (or didn't). peerTx=UNKNOWN means no `mh`
            // heartbeat is arriving over sig — the exact state that drove the churn; sigOpen tells us if the lane is up.
            mlog('no-flow', sid(id), `in=${rxV + rxA}kbps since=${sinceFlowMs}ms peerTx=${peerTx == null ? 'UNKNOWN(no mh)' : peerTx + 'kbps'} sigOpen=${!!dataLinks.get(id)?.conn?.open}`, '→', willRecover ? 'RECOVER' : peerTx != null && peerTx < MIN_FLOW_KBPS ? 'skip(peer quiet)' : 'skip(unconfirmed)')
            if (willRecover) recover(id)
            else if (peerTx != null && peerTx < MIN_FLOW_KBPS) lastFlow.set(id, now) // quiet-but-alive → reset the clock so the half-open timer starts only once the peer actually sends
          }
        })
        .catch(() => {})
    }
  }, HEARTBEAT_MS)

  return {
    setLocalStream: (stream) => {
      local = stream
      // Seed the gate's notion of the real outgoing track per lane (so a withheld peer's
      // placeholder swaps back to the right track when re-granted).
      realTrack.audio = stream?.getAudioTracks()[0] ?? null
      realTrack.video = stream?.getVideoTracks()[0] ?? null
      realTrack.share = stream?.getVideoTracks()[1] ?? null // 2nd video track = the screen-share lane (see useCall)
      realTrack.shareAudio = stream?.getAudioTracks()[1] ?? null // 2nd audio track = the staged-video sound lane (opt-in)
      // Re-create any existing media pcs with the new stream's tracks (a true stream-object swap; camera toggles use
      // replaceVideoTrack and never reach here), then start media with present initiator peers (the offer rides the
      // data channel, buffering until it opens).
      for (const [id, link] of [...links]) createMediaPc(id, link.initiatedByUs)
      for (const id of presentPeers) startMedia(id)
    },
    // Swap the outgoing video on every LIVE connection — but PER PEER through the gate, so
    // a screen share is withheld (placeholder substituted) from a peer lacking `see-screen`.
    replaceVideoTrack: (track) => {
      realTrack.video = track
      for (const [id, { pc }] of links) applyKind(id, pc, 'video')
    },
    // The SECOND video lane — the screen-share. Swaps the real screen onto the pre-negotiated share sender
    // (per-peer through the gate), leaving the camera lane untouched. null restores the dormant placeholder.
    replaceShareTrack: (track) => {
      realTrack.share = track
      for (const [id, { pc }] of links) applyKind(id, pc, 'share')
    },
    // The peer's incoming share = the 2nd video transceiver's receiver track (same lane order as laneSender:
    // camera = 1st video transceiver, share = 2nd). Stable across the sender's replaceTrack swaps, so the UI
    // can wrap it in a MediaStream once and keep it.
    remoteShareTrack: (id) => {
      const pc = links.get(id)?.pc
      if (!pc) return null
      const video = pc.getTransceivers().filter((t) => (t.receiver.track?.kind ?? t.sender.track?.kind) === 'video')
      return video[1]?.receiver.track ?? null
    },
    // Same per-peer gate for audio: a peer lacking `hear-audio` keeps the silent placeholder.
    replaceAudioTrack: (track) => {
      realTrack.audio = track
      for (const [id, { pc }] of links) applyKind(id, pc, 'audio')
    },
    // The SECOND audio lane — a staged video clip's sound. Swaps the real audio onto the pre-negotiated
    // share-audio sender (per-peer through the gate), leaving the mic lane untouched. null restores the dormant
    // placeholder. No-op on a peer without the lane negotiated (laneSender → null).
    replaceShareAudioTrack: (track) => {
      realTrack.shareAudio = track
      for (const [id, { pc }] of links) applyKind(id, pc, 'shareAudio')
    },
    // The peer's incoming share-audio = the 2nd audio transceiver's receiver track (same order as laneSender:
    // mic = 1st audio, share-audio = 2nd). null if the lane wasn't negotiated with this peer.
    remoteShareAudioTrack: (id) => {
      const pc = links.get(id)?.pc
      if (!pc) return null
      const audio = pc.getTransceivers().filter((t) => (t.receiver.track?.kind ?? t.sender.track?.kind) === 'audio')
      return audio[1]?.receiver.track ?? null
    },
    setMediaGate: (gate, placeholders) => {
      mediaGate = gate
      if (placeholders) {
        gatePh.audio = placeholders.audio
        gatePh.video = placeholders.video
        gatePh.share = placeholders.video // withhold the share lane with the same black video placeholder
        gatePh.shareAudio = placeholders.audio // withhold the staged-video sound with the silent audio placeholder
      }
      for (const [id, { pc }] of links) applyConn(id, pc)
    },
    applyMediaGate: () => {
      for (const [id, { pc }] of links) applyConn(id, pc)
    },
    // Content prefers the BULK channel; falls back to the SIG link for a peer without a bulk connection yet
    // (old / pre-handshake). Every peer has a sig link, so iterate those keys for the broadcast.
    broadcastData: (msg) => {
      for (const id of dataLinks.keys()) sendOver(bulkLinks.get(id) ?? dataLinks.get(id), msg)
    },
    sendData: (toId, msg) => sendOver(bulkLinks.get(toId) ?? dataLinks.get(toId), msg),
    dataBufferedAmount: (toId) => {
      // Transfers ride the BULK channel; its RTCDataChannel buffer is what the chunk feeder watches for backpressure.
      const conn = bulkLinks.get(toId)?.conn
      // Before it's open there's nothing queued there (our own pre-open buffer holds it instead), so report 0.
      return (conn?.open && conn.dataChannel?.bufferedAmount) || 0
    },
    // The CONTENT-TRANSFER channel's readiness — useCall gates a transfer's START on this. Transfers ride BULK
    // only (so chunks never straddle channels), so this is bulk-open. A peer without a bulk link (old/pre-
    // handshake) isn't sent a transfer until it opens one; single messages still reach it via the sig fallback.
    dataLinkOpen: (toId) => !!bulkLinks.get(toId)?.conn?.open,
    onData: (cb) => {
      onDataCb = cb
    },
    onDataLinkOpen: (cb) => {
      onDataLinkOpenCb = cb
    },
    onPeerLeft: (cb) => {
      onPeerLeftCb = cb
    },
    safetyCodeFor: async (peerId) => {
      const pc = links.get(peerId)?.pc
      return pc ? safetyInfo(pc) : null
    },
    connectionInfoFor: async (peerId) => {
      const pc = links.get(peerId)?.pc
      if (!pc) return null
      try {
        return connInfo(statsToArray(await pc.getStats()))
      } catch {
        return null
      }
    },
    setAdmit: (fn) => {
      admit = typeof fn === 'function' ? fn : () => true
    },
    liveMeshPeers,
    setRoster: (members) => {
      // A peer present in THIS roster cancels any pending drop — its media/data never flinched (survived the
      // signaling blip). Do this first, before planRoster, so a reappearance always wins over a stale drop timer.
      const present = new Set(members.filter((m) => m.id !== selfId).map((m) => m.id))
      presentPeers.clear()
      for (const id of present) presentPeers.add(id) // sync the mesh-level "who's here" (read by teardown recovery)
      for (const id of present) {
        const m = pendingMediaDrop.get(id)
        if (m) {
          clearTimeout(m)
          pendingMediaDrop.delete(id)
        }
        const d = pendingDataDrop.get(id)
        if (d) {
          clearTimeout(d)
          pendingDataDrop.delete(id)
        }
      }
      // Media DROP: any media link (initiator OR answerer role) whose peer is no longer present → grace, then close.
      // A transient roster gap re-syncs within a round-trip (cancelled above), so only a SUSTAINED absence tears
      // down. Drive off `links` (not planRoster) so answerer-side links are reaped too.
      for (const [id] of links) {
        if (present.has(id) || pendingMediaDrop.has(id)) continue
        pendingMediaDrop.set(
          id,
          setTimeout(function dropMedia() {
            pendingMediaDrop.delete(id)
            if (closed || presentPeers.has(id)) return // came back during the grace → keep it
            // rosterHold: gone from the roster but still P2P-alive (fresh heartbeat) ⇒ a broker flap, not a leave.
            // Keep the working link; re-arm the grace to re-check. A real leave stops the heartbeat → torn down then.
            if (rosterHoldOn() && peerAlive(id) && peerFlowedOnce.has(id)) {
              pendingMediaDrop.set(id, setTimeout(dropMedia, DROP_GRACE_MS))
              return
            }
            const link = links.get(id)
            if (link) {
              links.delete(id)
              try {
                link.pc.close()
              } catch {
                /* ignore */
              }
              onRemote(id, null)
            }
            recoverCount.delete(id) // a clean leave must not trigger a re-create
            relayLatched.delete(id) // fresh direct-first on a future re-join
            lastFlow.delete(id)
            peerFlowedOnce.delete(id) // reset the sticky flag so a rejoin re-earns rosterHold from scratch
          }, DROP_GRACE_MS),
        )
      }
      // Media START: a present peer gets media via startMedia (initiator creates the pc + offers over the data
      // channel; the answerer builds reactively on the first m-sdp). Idempotent + role/stream/link-checked.
      for (const id of present) startMedia(id)
      // Reconcile the data mesh over the SAME roster (its own dialled set — data
      // connections are independent of media, so they survive media re-dials). Same drop grace.
      const data = planRoster(selfId, members, dataDialled)
      for (const id of data.drop) {
        if (pendingDataDrop.has(id)) continue
        pendingDataDrop.set(
          id,
          setTimeout(function dropData() {
            pendingDataDrop.delete(id)
            if (closed) return
            // rosterHold: still P2P-alive (fresh heartbeat) ⇒ broker flap, not a leave. Keep the SIG channel (it
            // carries the heartbeat + presence that make this hold work) and re-check; a real leave stops it.
            if (rosterHoldOn() && peerAlive(id) && peerFlowedOnce.has(id)) {
              pendingDataDrop.set(id, setTimeout(dropData, DROP_GRACE_MS))
              return
            }
            const link = dataLinks.get(id)
            if (link) {
              dataLinks.delete(id)
              try {
                link.conn.close()
              } catch {
                /* ignore */
              }
            }
            dataDialled.delete(id) // do this BEFORE any teardown re-dial check (a clean leave must not re-dial)
            const pending = dataRedialTimers.get(id)
            if (pending) {
              clearTimeout(pending)
              dataRedialTimers.delete(id)
            }
            // Drop the peer's bulk channel too (clean leave ⇒ no self-heal re-dial).
            const bl = bulkLinks.get(id)
            if (bl) {
              bulkLinks.delete(id)
              try {
                bl.conn.close()
              } catch {
                /* ignore */
              }
            }
            bulkDialled.delete(id)
            bulkCapable.delete(id)
            const bPending = bulkRedialTimers.get(id)
            if (bPending) {
              clearTimeout(bPending)
              bulkRedialTimers.delete(id)
            }
          }, DROP_GRACE_MS),
        )
      }
      for (const id of data.initiate) {
        dataDialled.add(id)
        dialData(id)
      }
    },
    close: () => {
      closed = true
      peer.off('connection', onIncomingData)
      // Graceful leave: announce over each open P2P sig channel so peers drop us IMMEDIATELY — rosterHold can't
      // otherwise tell a leave from a broker flap. Capture the data/bulk conns and close them on a short delay so
      // the 'bye' flushes before the channel tears down (closing a channel the same tick as send() can drop it).
      // Best-effort — if the browser tears everything down first (a crash), the peer's keepalive-silence timeout
      // is the backstop.
      const dataConns = [...dataLinks.values(), ...bulkLinks.values()].map((l) => l.conn)
      for (const l of dataLinks.values()) {
        if (l.conn?.open)
          try {
            sendOver(l, { t: 'bye' })
          } catch {
            /* ignore */
          }
      }
      for (const { pc } of links.values()) {
        try {
          pc.close()
        } catch {
          /* ignore */
        }
      }
      setTimeout(() => {
        for (const conn of dataConns) {
          try {
            conn.close()
          } catch {
            /* ignore */
          }
        }
      }, 250)
      for (const t of dataRedialTimers.values()) clearTimeout(t)
      dataRedialTimers.clear()
      for (const t of bulkRedialTimers.values()) clearTimeout(t)
      bulkRedialTimers.clear()
      for (const t of pendingMediaDrop.values()) clearTimeout(t)
      pendingMediaDrop.clear()
      for (const t of pendingDataDrop.values()) clearTimeout(t)
      pendingDataDrop.clear()
      presentPeers.clear()
      pendingRelay.clear()
      relayLatched.clear()
      recoverCount.clear()
      lastFlow.clear()
      peerFlowedOnce.clear()
      clearInterval(heartbeat)
      mediaHealth.clear()
      mediaStatsLast.clear()
      links.clear()
      dataLinks.clear()
      dataDialled.clear()
      bulkLinks.clear()
      bulkDialled.clear()
      bulkCapable.clear()
    },
  }
}
