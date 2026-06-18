import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AUDIO,
  type CamFacing,
  createPlaceholderAudioTrack,
  createPlaceholderVideoTrack,
  isIOS,
  stopStream,
  VIDEO,
  videoConstraints,
} from '../core/media'
import type { VoiceMesh } from '../core/mesh'
import type { SafetyInfo } from '../core/safetyCode'
import type { ConnInfo } from '../core/connStats'
import { type CallMedia, peerJsMedia } from '../core/callMedia'
import { inkColor } from './ink'
import type { AppMessage, CallMember, ChatMessage, ContentMsg, InkEvent, PayRequest } from '../core/protocol'
import type { RoomLink } from '../core/room'
import {
  type AcceptedProvider,
  type IdentityConfig,
  type IdentityProvider,
  type VerifiedIdentity,
  discoveryIssuerFor,
  issuersFor,
  verifyPeerIdentity,
  verifyPeerMulti,
} from '../core/identity'
import { emailCodeProvider } from '../core/emailProvider'
import { getGrant } from '../core/grant'
import { certFingerprint, generatePinnedCert } from '../core/identityCert'
import { nonceForFingerprint } from '../core/oidcBinding'
import { signAgentAssertion, importAgentPrivateKey } from '../core/agentKey'
import { unsealHostKey, importHostPrivateKey, signHostCommand, type HostOp } from '../core/hostKey'
import { createJwksResolver } from '../core/oidcJwks'
import { providerFor } from '../core/identityProviders'
import { evaluateRosterGate, peerCleared, type RosterGateView } from '../core/rosterGate'
import { canAct, canPerceive, defaultGrant, effectiveGrant, sanitizeGrant, type Grant } from '../core/capabilities'
import { checkRetired, type RetirementCheck } from '../core/minVersion'

/** This build's SemVer (baked by the vite configs); falls back to 0.0.0 in any unsubstituted context. */
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'
/** The deployment's kill-switch file, at the ORIGIN this bundle was served from (so a self-hoster
 *  controls their own floor, and kibitz.chat can retire its own pinned /v<x>/widget.js builds). */
const MIN_VERSION_URL = (() => {
  try {
    return new URL('/min-version.json', import.meta.url).href
  } catch {
    return '/min-version.json'
  }
})()

// Feature negotiation (COMPATIBILITY.md): the capability tags THIS build speaks. Advertised on the
// roster so a newer peer can see what an older one supports and down-level. Versioned + additive —
// add tags, never repurpose. (Old builds simply don't list a tag they don't have.)
const ENGINE_FEATURES: readonly string[] = [
  'chat.v1',
  'app.v1',
  'ink.v1',
  'pay.v1',
  'caps.v1',
  'identity.v1',
  'schema.v1',
]
// Reserved roster-meta key carrying { v: engineVersion, f: features } — rides the existing `meta`
// channel (no protocol change), and is STRIPPED from the app-facing `participant.meta` so the app's
// namespace stays clean (the engine version/features surface as `participant.engine`/`features`).
// The key is a compatibility CONTRACT (a peer that predates it just leaves it absent); see
// versionSkew.test.ts. Exported so that test can pin the strip/passthrough both ways.
export const META_ENGINE = '~kbz'
export function readEngineMeta(meta: Record<string, unknown> | undefined): {
  engine?: string
  features?: readonly string[]
  appMeta: Record<string, unknown>
} {
  if (!meta || typeof meta !== 'object') return { appMeta: {} }
  const { [META_ENGINE]: e, ...appMeta } = meta as Record<string, unknown>
  const em = (e && typeof e === 'object' ? e : {}) as { v?: unknown; f?: unknown }
  return {
    engine: typeof em.v === 'string' ? em.v : undefined,
    // Bound the list: it's self-asserted by the peer (advisory, not trusted) and rides every roster.
    features: Array.isArray(em.f)
      ? (em.f.filter((x) => typeof x === 'string').slice(0, FEATURES_MAX) as string[])
      : undefined,
    appMeta,
  }
}

// Caps applied on RECEIVE — content now arrives directly from peers, so the trust
// boundary is here, not a central relay. (Senders also cap, belt-and-suspenders.)
const CHAT_MAX_LEN = 500
const PAY_URL_MAX = 512
const PAY_NOTE_MAX = 80
const JWT_MAX = 8192 // a Google RS256 ID token is ~1KB; this is a generous DoS guard
const SCHEMA_NAME_MAX = 120 // schema identifiers are short labels (e.g. 'whist.view')
const SCHEMA_CAP = 200 // bound the discovered-schema map across many peers × many schemas
const SCHEMA_PER_PEER = 25 // ...and per peer, so one peer can't evict everyone else's schemas
const OWN_SCHEMA_CAP = 50 // bound how many distinct schemas WE publish (no app needs more)
const FEATURES_MAX = 64 // bound a peer's advertised feature-tag list (self-asserted, untrusted)
// App messages are OPAQUE developer payloads (co-browse / shared game state), so their shape is
// the app's business — but unbounded P2P app data is a memory/CPU DoS vector. A generous
// serialized-size backstop: an oversized app payload is DROPPED on receive (an untrusted peer
// can't flood us) and not sent. Rate-limiting, schema validation, and backpressure stay the
// app's responsibility (the engine is a transport); this is only the safety ceiling. Best-effort:
// payloads JSON can't serialize (Blob/ArrayBuffer/Map) skip the check — those are the app's to bound.
export const APP_MAX_BYTES = 256 * 1024
export const appPayloadTooBig = (data: unknown): boolean => {
  try {
    return JSON.stringify(data).length > APP_MAX_BYTES
  } catch {
    return false // not JSON-serializable — can't measure cheaply; let it through (app's call)
  }
}
// Send-side: same check, but tell the developer their payload was dropped (vs the silent
// receive-side drop of a peer's oversized message). Bounding the payload is the app's job.
const tooBigToSend = (data: unknown): boolean => {
  if (!appPayloadTooBig(data)) return false
  // eslint-disable-next-line no-console
  console.warn(`[kibitz] app payload exceeds ${APP_MAX_BYTES} bytes — not sent; bound it in your app`)
  return true
}
const IDTOKEN_CAP = 100 // bound the per-peer token/verify maps in a long-lived widget

/** Evict the oldest entry once a Map exceeds `cap` (insertion-order, so departed peers
 *  age out first). Stale entries are never READ — getIdentity is only called for current
 *  participants — so this just bounds memory. */
function capMap<V>(map: Map<string, V>, cap = IDTOKEN_CAP): void {
  while (map.size > cap) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** The display name for a sender id, from the roster (never the wire — unspoofable). */
export function rosterName(roster: readonly CallMember[], id: string): string {
  return roster.find((m) => m.id === id)?.name || 'Guest'
}

/** Narrow an opaque mesh message to a known content envelope, or null. */
export function asContent(msg: unknown): ContentMsg | null {
  if (!msg || typeof msg !== 'object') return null
  const k = (msg as { k?: unknown }).k
  return k === 'chat' || k === 'app' || k === 'pay' || k === 'ink' || k === 'idtoken' || k === 'caps' || k === 'schema'
    ? (msg as ContentMsg)
    : null
}

/** The room seam useCall needs — satisfied by both the online Room and the
 * offline LanRoom (it only ever touches `link`). */
export interface CallRoom {
  link: RoomLink
  /** Optional: re-establish the data connection (after media permission unlocks
   *  real ICE candidates on iOS). Absent on the preview/LAN rooms. */
  reconnect?(): void
  /** Am I the room authority? Used to decide whether to BROADCAST capability grants.
   *  Absent on preview/LAN rooms → treated as not-authority (no distribution). */
  isAuthority?(): boolean
  /** The current authority's media id — used to ACCEPT a capability broadcast only from the
   *  authority (a non-authority peer can't forge grants). '' / absent → no trusted source. */
  hostId?(): string
  // Direct authority moderation (online Room only; absent on preview/LAN). Used by the SOFT-host tier,
  // which has no key to sign with — these no-op unless we're the coordinator, scoping it accordingly.
  setLobby?(on: boolean): void
  setLocked?(on: boolean): void
  resetRoom?(): void
  admit?(id: string): void
  deny?(id: string): void
  remove?(memberId: string): void
  /** OIDC host: mark a member the verified host once we've verified their committed email (authority only). */
  declareHost?(memberId: string): void
}

/** One rendered chat line. */
export interface ChatItem extends ChatMessage {
  id: number
  self: boolean
  /** A private (directed) message — sent to / received from one person only. */
  dm?: boolean
  /** Self lines only: the recipient's display name of a DM we sent. */
  to?: string
}

/** An app self-describing the shape of its `app` messages / shared view, so an agent (or any peer)
 *  can discover how to interpret them without out-of-band docs. Published over the data mesh and
 *  attributed to the sender by the roster. The latest published entry wins per (from, name). */
export interface SchemaInfo {
  /** Publisher's media peer id (matches the roster). */
  from: string
  /** A stable identifier for the schema (e.g. 'whist.view', 'cobrowse'). */
  name: string
  /** The schema's own version, app-defined (e.g. '1.0.0'). */
  version: string
  /** The schema document — a JSON Schema, an example payload, or any structured-clone-able shape. */
  schema: unknown
}

const CHAT_KEEP = 50

/** Append a line to the capped chat buffer (pure — oldest lines fall off). */
export function appendChat(list: readonly ChatItem[], item: ChatItem, keep = CHAT_KEEP): ChatItem[] {
  const next = [...list, item]
  return next.length > keep ? next.slice(next.length - keep) : next
}

/** New, incoming (not our own) chat lines present in `next` but not in `prev`, matched by id.
 *  Pure — lets a headless controller fire a 'chat' event for only freshly-received messages
 *  (robust to the capped buffer dropping old lines). */
export function newChatLines(prev: readonly ChatItem[], next: readonly ChatItem[]): ChatItem[] {
  const seen = new Set(prev.map((c) => c.id))
  return next.filter((c) => !c.self && !seen.has(c.id))
}

/** One person in the call, ready to render. */
export interface CallParticipant {
  id: string
  name: string
  /** Camera on — THE flag that decides video-vs-avatar (the video lane always exists). */
  cam: boolean
  /** Emoji avatar shown (voice-reactive) when the camera is off; '' = initials. */
  avatar: string
  stream: MediaStream | null
  isSelf: boolean
  /** Self only: mirror the video (true for the front camera; rear shows as-is —
   *  never for a screen/tab share, which would flip the text). */
  mirror?: boolean
  /** Self only: this video lane is a screen/tab SHARE, not the camera. */
  sharing?: boolean
  /** Opaque host-app metadata from the roster (seat, userId…); {} if none. */
  meta: Record<string, unknown>
  /** The engine SemVer this peer is running, advertised on the roster (undefined for an older
   *  build that predates feature advertising). SELF-ASSERTED (a peer sets its own roster meta) —
   *  advisory for observability + down-level negotiation, never a security/authorization signal. */
  engine?: string
  /** The capability tags this peer's build claims (e.g. 'caps.v1','schema.v1'). Self-asserted, like
   *  `engine` — use to down-level a feature, not to gate trust. See COMPATIBILITY.md. */
  features?: readonly string[]
}

/** One local capability-audit event (host-visible; nothing stored or sent). `blocked` = a peer's
 *  act was dropped because its grant forbade it; `granted` = its grant was changed. */
export interface AuditEntry {
  ts: number
  id: string
  kind: 'blocked' | 'granted'
  detail: string
}

export interface CallController {
  ready: boolean
  inCall: boolean
  participants: readonly CallParticipant[]
  rosterCount: number
  micOn: boolean
  camOn: boolean
  avatar: string
  /** A FATAL/persistent problem the user must act on (build retired, couldn't connect) — shown as the
   *  red banner. Transient mic/camera/share hiccups go to `notice`, not here. */
  error: string | null
  /** A transient, non-alarming heads-up (e.g. "mic access was blocked") — shown as a brief, neutral
   *  toast that auto-dismisses. The mic/camera button on/off state already conveys the result, so these
   *  never linger as a red banner. Null when nothing's showing. */
  notice: string | null
  /** Set when this build has been retired by the deployment's min-version floor (the kill-switch):
   *  the engine refuses to connect. Carries the operator's `message`. Null = build is current. */
  retired: RetirementCheck | null
  join: () => Promise<boolean>
  leave: () => void
  /** Turn the mic on/off. An explicit deviceId (e.g. the pre-join's chosen mic, desktop) selects that input. */
  toggleMic: (deviceId?: string) => void
  /** Free a captured-but-muted mic on iOS (stop the hardware → no recording indicator / app-switch
   *  click). No-op unless iOS + muted + a real mic is captured. Call from a user gesture. */
  releaseMutedMic: () => void
  /** iOS: capture the mic while staying muted, so a live call's voice routes to a Bluetooth/car device
   *  right away (it only routes while the mic is engaged). Pair with setKeepMicCaptured(true). */
  engageMic: () => void
  /** Hold the mic captured even while muted (don't let releaseMutedMic free it) — for Car mode, so the
   *  call audio stays on the car. */
  setKeepMicCaptured: (on: boolean) => void
  /** Turn the camera on/off. When turning ON, defaults to the front cam unless an explicit facing is
   *  given; an explicit deviceId (the pre-join's chosen camera, desktop) wins over facing. */
  toggleCam: (facing?: CamFacing, deviceId?: string) => Promise<void>
  /** Switch front/rear camera (mobile); true when more than one camera exists. */
  flipCam: () => Promise<void>
  canFlip: boolean
  /** Audio OUTPUT device id ('' = system default) — which speaker plays remote audio. */
  speakerId: string
  /** Choose the audio output device (HTMLMediaElement.setSinkId; desktop Chromium, no-op elsewhere). */
  setSpeaker: (deviceId: string) => void
  /** You are publishing a screen/tab share (rather than the camera). */
  sharing: boolean
  /** Share your screen/tab via the browser picker (getDisplayMedia). Returns false
   *  if blocked/cancelled. Replaces the camera on the video lane while active. */
  shareScreen: () => Promise<boolean>
  /** Publish an externally-captured video track (e.g. an extension's chrome.tabCapture
   *  stream) on the video lane — the same swap path as the camera, no re-dial. */
  shareTrack: (track: MediaStreamTrack) => Promise<boolean>
  /** Stop sharing and return the video lane to off. */
  stopShare: () => void
  /** Publish a custom outgoing audio track (song / TTS); null restores the silent placeholder. */
  publishAudioTrack: (track: MediaStreamTrack | null) => void
  setAvatar: (avatar: string) => void
  /** Attach opaque metadata to yourself (seat, userId…) — rides the roster so every
   *  peer can map you to its own domain. Kibitz never reads it. Keep it small. */
  setMeta: (meta: Record<string, unknown>) => void
  /** Ephemeral room chat (call members; capped buffer, nothing stored anywhere).
   *  Carried peer-to-peer over the data mesh — no authority relays it. */
  chat: readonly ChatItem[]
  /** Send a chat line. With `to` (a participant id) it's a PRIVATE message to just
   *  that person (point-to-point); without, it's broadcast to the room. */
  sendChat: (text: string, to?: string) => void
  /** Broadcast an opaque app message to every other call member (co-browse / shared
   *  state), peer-to-peer. You never receive your own back. */
  sendApp: (data: unknown) => void
  /** Send an opaque app message to ONE participant by id, peer-to-peer (directed). */
  sendAppTo: (to: string, data: unknown) => void
  /** Subscribe to app messages from other peers. */
  onApp: (cb: (m: AppMessage) => void) => void
  /** Send a "pay me" link (provider's rail; Kibitz never touches funds). With `to`
   *  it goes privately to that one participant; without, to the whole room. */
  sendPay: (label: string, url: string, to?: string) => void
  /** Subscribe to incoming pay requests (attributed by roster). */
  onPay: (cb: (p: PayRequest) => void) => void
  /** Broadcast a shared pointer / annotation event (you render your own locally). */
  sendInk: (e: InkEvent) => void
  /** Subscribe to others' pointer / annotation events. `color` is the mover's OWN stamped colour
   *  (same for every receiver); fall back to inkColor(from) if an older sender didn't stamp it. */
  onInk: (cb: (from: string, name: string, e: InkEvent, color?: string) => void) => void
  /** Publish a schema describing your `app` messages / shared view so other peers — especially
   *  agents — can self-discover how to read them (COMPATIBILITY.md / agent protocol). Broadcast
   *  over the data mesh and re-sent to anyone who joins later, so discovery is order-independent.
   *  Re-publishing the same `name` replaces the prior one. Keep it small (it rides the data mesh). */
  registerSchema: (name: string, version: string, schema: unknown) => void
  /** Every schema currently known — yours and every peer's, each attributed by `from`. */
  getSchemas: () => readonly SchemaInfo[]
  /** Subscribe to schemas as peers publish them (fires once per publish, attributed by roster).
   *  Returns an unsubscribe function. Unlike `onApp`/`onInk`, multiple listeners can coexist. */
  onSchema: (cb: (s: SchemaInfo) => void) => () => void
  /**
   * The per-peer safety code (SAS) for a participant — the emoji both of you compare
   * aloud to rule out a man-in-the-middle, plus the remote DTLS fingerprint it came
   * from. Null for yourself, the preview/LAN-without-cert case, or a peer that hasn't
   * finished connecting. Pairwise and honest (derived from real certs, never faked).
   */
  getSafetyCode: (participantId: string) => Promise<SafetyInfo | null>
  /** Connection diagnostic for a participant — direct/relay + RTT + packet loss, or
   *  null if not yet connected. Read from getStats(). */
  getConnectionInfo: (participantId: string) => Promise<ConnInfo | null>
  /** Opt-in identity verification (L3) is configured (a provider + client_id). When
   *  false everything below is inert and the call stays fully account-free. */
  identityEnabled: boolean
  /** Your own verified identity once you've signed in (null until then). */
  selfIdentity: VerifiedIdentity | null
  /** Render the provider's sign-in button into `container` and, on success, broadcast
   *  your cert-bound ID token to peers. Resolves true if you signed in. */
  signInIdentity: (container: HTMLElement, method?: 'google' | 'email') => Promise<boolean>
  /** The cert-bound nonce an EXTERNAL sign-in surface must echo (passed to GIS/email) so the
   *  token it mints binds to THIS connection. Null until the cert is ready. For embedders that
   *  run sign-in on another origin (e.g. the extension's kibitz.chat popup) — pair with
   *  `provideIdentityToken`. */
  identityNonce: () => Promise<string | null>
  /** Adopt a cert-bound token obtained out-of-page (signed against `identityNonce()`), exactly
   *  as an in-page sign-in would: verify, hand to the gate, broadcast. Resolves true if adopted. */
  provideIdentityToken: (jwt: string) => Promise<boolean>
  /** Mount AS an AI agent: adopt the agent's own private signing key (a JWK the operator holds)
   *  so we present a cert-bound key assertion the authority checks against the room's allow-list
   *  — an agent enters by its OWN key, no human. Kept fresh for reconnects. True if adopted. */
  provideAgentKey: (privateKeyJwk: JsonWebKey) => Promise<boolean>
  /** Mount AS a paid agent: forward a short-lived network-access credit credential (fetched from a
   *  trusted issuer) so it rides our announce — a credit-gated authority verifies it and keeps
   *  admitting us. Call ~every minute with a freshly-renewed credential. No-op until the link exists. */
  provideAgentCredit: (credential: string) => void
  /** Claim the verified-HOST role: unseal the link's sealed host private key (`sealedBlob`) with
   *  `password`, then sign + send a cert-bound `claim`. Returns false on a wrong password / not-ready
   *  cert. Once claimed, `hostModerate` drives the room's moderation. See core/hostKey.ts. */
  claimHost: (password: string, sealedBlob: string) => Promise<boolean>
  /** Claim the SOFT host role (the name tier): adopt the committed host name + re-announce, so the
   *  authority recognizes us as the host by name. No crypto — any link-holder can do this. */
  claimHostByName: (hostName: string) => void
  /** OIDC host (authority only): mark a member the verified host once their cert-bound identity proved
   *  the room's committed host email. The Widget drives this from getIdentity/selfIdentity. */
  declareHost: (memberId: string) => void
  /** Drive host moderation. Password tier → a signed command (any seat). Soft (name) tier → the
   *  authority methods directly (effective only while we're the coordinator). */
  hostModerate: (op: HostOp, target?: string) => Promise<boolean>
  /** True when WE are the room's verified host (we proved the host key and the roster names us). The
   *  moderation UI is gated on this. */
  isVerifiedHost: boolean
  /**
   * A participant's cert-bound, verified identity, or null if they haven't proven one
   * (no token yet, not connected, or verification failed). Fully peer-to-peer: the
   * token's signature is checked against the provider's public keys and its nonce
   * against the cert THIS side actually handshook with — no server vouches.
   */
  getIdentity: (participantId: string) => Promise<VerifiedIdentity | null>
  /**
   * Verified-roster (docs/verification.md §7) — the live mutual, pre-share gate. Inert
   * (`active:false`, `canShare:true`) unless the room was created with a committed roster.
   * When active, content is HELD until I and every present peer have proven a listed
   * identity; `compromised` flags a present peer who proved an OFF-roster identity (an
   * intruder past admission). Drives the "verifying the room…" hold + the alarm in the UI.
   */
  rosterGate: RosterGateView
  /** A participant's effective capability Grant right now — an authority override (expiry-applied)
   *  else the default for its kind (human full, agent read-only). Drives the consent UI. */
  getCapabilityGrant: (id: string) => Grant
  /** Set (null clears) a participant's capability override; the engine enforces it per-peer.
   *  Authority action — distributing it to other peers is the consent layer's job. */
  setCapabilityGrant: (id: string, grant: Grant | null) => void
  /** Recent local capability-audit events for a participant (host-visible; nothing stored/sent) —
   *  acts blocked by its grant + grant changes. Newest first. */
  getAgentAudit: (id: string) => readonly AuditEntry[]
}

const AVATAR_KEY = 'kibitz.avatar'
const loadAvatar = () => {
  try {
    return localStorage.getItem(AVATAR_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * Drives a call in a room: mic/camera capture, the media mesh, and the roster.
 * Media runs on a DEDICATED PeerJS peer per participant — never the room's data
 * peer (media churn on a shared peer destabilises it). Calls join MUTED and
 * camera-off; both are opt-in. Camera toggles are replaceTrack swaps on the live
 * connections (never re-dials — that crashes iOS WebKit natively, see core/mesh).
 */
export function useCall(
  room: CallRoom | null,
  name: string,
  makeMedia: () => CallMedia = peerJsMedia,
  /** Demo preview: no peers, so join without grabbing the mic (skip that prompt). */
  preview = false,
  /** OPT-IN identity verification (L3). Absent → fully account-free (default). */
  idConfig?: IdentityConfig,
  /** Room id — salts the cert→nonce binding so a token can't be replayed into another
   *  room. Both peers pass the same room, so it matches; omit and binding is cert-only. */
  roomSalt?: string,
  /** A cert the Widget pre-generated and pinned on the PRESENCE peer too (authority
   *  gate). When given, the media mesh reuses it, so ONE token verifies for both the
   *  authority (over presence) and peers (over media). Absent → useCall generates its
   *  own media cert (peer-to-peer badge only). */
  sharedCert?: RTCCertificate | null,
  /** Verified-roster (docs/verification.md §7): the committed member identities (emails,
   *  for the cert-bound `google` mode). When non-empty the mutual, pre-share gate turns ON
   *  — content is held until I and every present peer have proven a listed identity, and a
   *  present peer who proves an off-roster identity raises `compromised`. Absent/empty →
   *  the gate is inert and nothing about a normal room changes. */
  rosterMembers?: readonly string[] | null,
  /** Verified-roster allowed DOMAINS (the OIDC slots): a verified address at one of these is a
   *  member too. Combined with `rosterMembers` as the admission set. */
  rosterDomains?: readonly string[] | null,
  /** Accepted verification providers — peers' tokens are routed by issuer and verified against
   *  this list (Google, email-code, …). When set, peer-verify uses `verifyPeerMulti`; absent →
   *  the single-provider Google path from `idConfig` (back-compat for existing callers). */
  acceptProviders?: readonly AcceptedProvider[],
  /** Inject a sign-in provider (tests); otherwise built from idConfig.provider (google / microsoft /
   *  generic oidc — see providerFor). */
  makeProvider: (cfg: IdentityConfig) => IdentityProvider = providerFor,
  /** Privacy (Layer 3): force media/data through TURN so peers never see your IP (only the
   *  relay's). Fail-closed — no reachable TURN ⇒ the call can't connect rather than leak. */
  relayOnly = false,
): CallController {
  const [inCall, setInCall] = useState(false)
  const [micOn, setMicOn] = useState(false) // join MUTED by default
  const [camOn, setCamOn] = useState(false)
  const [avatar, setAvatarState] = useState<string>(loadAvatar)
  const [meta, setMetaState] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | null>(null)
  // A transient heads-up (mic/camera/share hiccup) — shown as a brief neutral toast, NOT the red error
  // banner, since the mic/camera button already conveys on/off. Auto-dismisses; the latest one wins.
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashNotice = useCallback((msg: string) => {
    setNotice(msg)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), 4500)
  }, [])
  useEffect(() => () => { if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current) }, [])
  // Min-version kill-switch (core/minVersion): if the deployment's floor retires THIS build,
  // we refuse to connect (a pinned/cached build can otherwise live forever in a P2P mesh).
  const [retired, setRetired] = useState<RetirementCheck | null>(null)
  const retiredRef = useRef<RetirementCheck | null>(null)
  const [roster, setRoster] = useState<CallMember[]>([])
  // Self preview/meter stream: the (shared) mic track — so your own emoji reacts to
  // your voice and the mic-wave works — plus the live camera track when it's on.
  const [selfStream, setSelfStream] = useState<MediaStream | null>(null)
  const [remote, setRemote] = useState<ReadonlyMap<string, MediaStream>>(new Map())
  const [selfVoiceId, setSelfVoiceId] = useState<string | null>(null)
  const [camFacing, setCamFacing] = useState<CamFacing>('user')
  const [canFlip, setCanFlip] = useState(false)
  // Audio OUTPUT device (which speaker to play remote audio through). '' = system default. Applied to
  // every playback element via useStream (HTMLMediaElement.setSinkId — desktop Chromium; a no-op where
  // unsupported). Kept in a ref so elements attached after a change still pick it up.
  const [speakerId, setSpeakerIdState] = useState('')
  const speakerIdRef = useRef('')
  const setSpeaker = useCallback((id: string) => {
    speakerIdRef.current = id || ''
    setSpeakerIdState(id || '')
  }, [])
  const [sharing, setSharing] = useState(false)
  const sharingRef = useRef(false)
  const facingRef = useRef<CamFacing>('user')
  const [chat, setChat] = useState<readonly ChatItem[]>([])
  const chatSeqRef = useRef(0)
  // Content (app/pay/ink) subscribers — registered by consumers, fired from the mesh.
  const appCbRef = useRef<((m: AppMessage) => void) | null>(null)
  const payCbRef = useRef<((p: PayRequest) => void) | null>(null)
  const inkCbRef = useRef<((from: string, name: string, e: InkEvent, color?: string) => void) | null>(null)
  // Schema discovery (#4): every schema we know, keyed by `${from} ${name}` (latest wins).
  // ownSchemasRef holds the ones WE published so we can re-broadcast them to late joiners.
  const schemasRef = useRef<Map<string, SchemaInfo>>(new Map())
  const ownSchemasRef = useRef<Map<string, { version: string; schema: unknown }>>(new Map())
  const schemaCbsRef = useRef<Set<(s: SchemaInfo) => void>>(new Set())

  // --- Opt-in identity (L3) — all inert unless idConfig is set ---------------------
  const [selfIdentity, setSelfIdentity] = useState<VerifiedIdentity | null>(null)
  const pinnedCertRef = useRef<RTCCertificate | null>(null) // ONE cert, pinned across the mesh
  const pinnedCertPromiseRef = useRef<Promise<RTCCertificate | null> | null>(null) // de-dupe concurrent gen
  const selfFpRef = useRef<string>('') // our pinned cert's fingerprint
  const selfJwtRef = useRef<string>('') // our signed, cert-bound ID token
  // AI-agent key (when we mount AS an agent): our own private signing key + the periodic
  // re-sign timer that keeps a fresh cert-bound assertion riding our announce (so a reconnect,
  // which the authority re-verifies, always has a non-stale assertion).
  const agentSignKeyRef = useRef<CryptoKey | null>(null)
  const agentRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const idTokensRef = useRef<Map<string, string>>(new Map()) // peerId → raw received jwt
  // Memoised verification per peer, invalidated when the jwt or the remote cert changes.
  const idCacheRef = useRef<Map<string, { jwt: string; fp: string; id: VerifiedIdentity | null }>>(new Map())
  const sentTokenToRef = useRef<Set<string>>(new Set()) // peers we've handed our token to
  const idConfigRef = useRef<IdentityConfig | undefined>(idConfig)
  idConfigRef.current = idConfig
  const acceptProvidersRef = useRef<readonly AcceptedProvider[] | undefined>(acceptProviders)
  acceptProvidersRef.current = acceptProviders
  const relayOnlyRef = useRef(relayOnly)
  relayOnlyRef.current = relayOnly
  const roomSaltRef = useRef<string | undefined>(roomSalt)
  roomSaltRef.current = roomSalt
  const sharedCertRef = useRef<RTCCertificate | null | undefined>(sharedCert)
  sharedCertRef.current = sharedCert
  // Verified-roster (docs §7). The live view is recomputed by a poll while in a call; a ref
  // mirrors it so the []-dep content senders/receiver can gate synchronously. A stable key
  // (the joined roster) drives the poll's effect dep without re-firing on array identity.
  const rosterKey = useMemo(
    () => `${(rosterMembers ?? []).join('\n')}|${(rosterDomains ?? []).join('\n')}`,
    [rosterMembers, rosterDomains],
  )
  const rosterMembersRef = useRef<readonly string[] | null | undefined>(rosterMembers)
  rosterMembersRef.current = rosterMembers
  const rosterDomainsRef = useRef<readonly string[] | null | undefined>(rosterDomains)
  rosterDomainsRef.current = rosterDomains
  const [rosterGate, setRosterGate] = useState<RosterGateView>(() =>
    evaluateRosterGate({ members: rosterMembers, domains: rosterDomains }),
  )
  const rosterGateRef = useRef(rosterGate)
  rosterGateRef.current = rosterGate
  // ── Participant capabilities (docs/agent-platform.md) ──────────────────────────────────────
  // A per-peer Grant of what it may perceive/emit. Authority overrides live in grantsRef
  // (set + distributed in the consent layer); absent an override a peer's grant is the default
  // for its KIND (humans full, agents read-only) — kind from the agent SDK's `meta.role`='agent'.
  // The engine ENFORCES it: receive-side drops a sender's data acts when it lacks `send-chat`;
  // send-side withholds from a recipient lacking `read-chat` / `receive-directed`. Inert for an
  // all-human room with no overrides (everyone is full), so non-agent rooms are unaffected.
  const grantsRef = useRef<Map<string, Grant>>(new Map())
  const nowSec = () => Math.floor(Date.now() / 1000)
  // The grant in force for a peer right now: an authority override (expiry-applied) else the kind
  // default (humans full, agents read-only). Kind from the agent SDK's `meta.role='agent'`. Self is
  // always full (we never gate our own perception/action locally). For an agent with no override we
  // also surface its self-disclosed `meta.backend`/`meta.egress` — a DISCLOSURE of where what-it-sees
  // goes (shown in the consent sheet), NOT a privilege it grants itself; a backend implies egress.
  const grantOf = useCallback((id: string): Grant => {
    if (id === voiceIdRef.current) return defaultGrant('human')
    const o = grantsRef.current.get(id)
    if (o) return effectiveGrant(o, nowSec())
    const meta = rosterRef.current.find((x) => x.id === id)?.meta
    if (meta?.role !== 'agent') return defaultGrant('human')
    const backend = typeof meta.backend === 'string' && meta.backend ? meta.backend.slice(0, 80) : undefined
    const egress = meta.egress === true || !!backend
    return { ...defaultGrant('agent'), ...(backend ? { backend } : {}), ...(egress ? { egress: true } : {}) }
  }, [])
  const grantOfRef = useRef(grantOf) // stable handle for the []-dep content callbacks
  grantOfRef.current = grantOf
  // Per-peer MEDIA perception gate (Phase 4): the mesh asks this, per peer + lane, whether the
  // peer may receive the real track — else it substitutes a flowing placeholder on just that
  // connection. AUDIO is gated by `hear-audio`. VIDEO is gated by `see-screen` ONLY while we're
  // screen-SHARING (the camera lane isn't capability-gated — there's no see-camera perceive — so
  // when not sharing every peer gets the video). Ref-stable: reads grantOfRef + sharingRef live.
  const mediaGate = useRef((peerId: string, kind: 'audio' | 'video'): boolean => {
    const g = grantOfRef.current(peerId)
    if (kind === 'audio') return canPerceive(g, 'hear-audio')
    return sharingRef.current ? canPerceive(g, 'see-screen') : true
  })
  // Capability audit (LOCAL-ONLY, host-visible): a small ring of high-signal events — an agent's
  // act BLOCKED by its grant (it tried to do what it isn't allowed) and grant CHANGES. No content is
  // stored, just capability-level facts. Drives the consent feed; nothing leaves the browser.
  const auditRef = useRef<AuditEntry[]>([])
  const logAudit = (id: string, kind: AuditEntry['kind'], detail: string) => {
    auditRef.current.push({ ts: Date.now(), id, kind, detail })
    if (auditRef.current.length > 80) auditRef.current.splice(0, auditRef.current.length - 80)
  }
  const logAuditRef = useRef(logAudit)
  logAuditRef.current = logAudit
  const getCapabilityGrant = useCallback((id: string): Grant => grantOf(id), [grantOf])
  // Distribution (b): the AUTHORITY broadcasts the full grant map to EVERYONE, so every peer
  // enforces the same grants (multi-human correctness), not just the host. A control message —
  // it bypasses the content gates. A non-authority's call is a no-op (only the host distributes).
  const broadcastCaps = useCallback(() => {
    if (!roomRef.current?.isAuthority?.()) return
    const grants: Record<string, Grant> = {}
    for (const [id, g] of grantsRef.current) grants[id] = g
    meshRef.current?.broadcastData({ k: 'caps', grants } satisfies ContentMsg)
  }, [])
  const broadcastCapsRef = useRef(broadcastCaps)
  broadcastCapsRef.current = broadcastCaps
  const setCapabilityGrant = useCallback(
    (id: string, grant: Grant | null) => {
      if (grant) grantsRef.current.set(id, sanitizeGrant(grant))
      else grantsRef.current.delete(id)
      logAudit(id, 'granted', grant ? `${[...grant.perceive, ...grant.act].join(', ') || 'nothing'}` : 'cleared')
      broadcastCaps() // push the change to every peer (host-distributed enforcement)
      meshRef.current?.applyMediaGate?.() // re-gate media (screen share / audio) to the new grant
    },
    [broadcastCaps],
  )
  const getAgentAudit = useCallback(
    (id: string): readonly AuditEntry[] => auditRef.current.filter((e) => e.id === id).slice(-6).reverse(),
    [],
  )
  const providerRef = useRef<IdentityProvider | null>(null)
  const jwksRef = useRef<ReturnType<typeof createJwksResolver> | null>(null)
  if (idConfig && !jwksRef.current) jwksRef.current = createJwksResolver()
  if (idConfig && !providerRef.current) providerRef.current = makeProvider(idConfig)

  const meshRef = useRef<VoiceMesh | null>(null)
  const mediaRef = useRef<CallMedia | null>(null)
  const voiceIdRef = useRef<string>('')
  const localRef = useRef<MediaStream | null>(null)
  const selfStreamRef = useRef<MediaStream | null>(null)
  const placeholderRef = useRef<MediaStreamTrack | null>(null)
  // The silent audio lane held until the real mic is granted on first unmute, and
  // a flag for whether we've swapped the real mic in yet (lazy-mic, no join prompt).
  const placeholderAudioRef = useRef<MediaStreamTrack | null>(null)
  const realMicRef = useRef(false)
  // DEDICATED, call-lifetime gating placeholders (Phase 4 media gate): substituted on a
  // per-peer basis to WITHHOLD a screen share / audio from a peer lacking `see-screen` /
  // `hear-audio`. Kept distinct from the lazy-mic/camera placeholders above (those get
  // stopped/removed during toggles) so the gate always has a live track to swap in.
  const gateVideoPhRef = useRef<MediaStreamTrack | null>(null)
  const gateAudioPhRef = useRef<MediaStreamTrack | null>(null)
  // Quick post-join re-announces, in case the first raced the data channel.
  const reannounceRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const rosterRef = useRef<CallMember[]>([])
  const micRef = useRef(false)
  // Car mode keeps the mic CAPTURED (iOS): a live call's voice audio only routes to a Bluetooth/car
  // device while the mic is engaged, so we hold it (muted via enabled=false) instead of freeing it.
  const keepMicCapturedRef = useRef(false)
  const camRef = useRef(false)
  const avatarRef = useRef(avatar)
  const metaRef = useRef<Record<string, unknown>>(meta)
  const togglingCamRef = useRef(false)
  const nameRef = useRef(name)
  nameRef.current = name
  const roomRef = useRef<CallRoom | null>(room)
  roomRef.current = room
  const makeMediaRef = useRef(makeMedia)
  makeMediaRef.current = makeMedia
  const previewRef = useRef(preview)
  previewRef.current = preview

  const announceSelf = useCallback((on: boolean) => {
    // Ride engine version + features on the roster under the reserved key (stripped on read).
    const meta = { ...metaRef.current, [META_ENGINE]: { v: APP_VERSION, f: ENGINE_FEATURES } }
    roomRef.current?.link.setSelf(on, camRef.current, nameRef.current, avatarRef.current, voiceIdRef.current, meta)
  }, [])

  const onRemote = useCallback((id: string, stream: MediaStream | null) => {
    setRemote((prev) => {
      const next = new Map(prev)
      if (stream) next.set(id, stream)
      else next.delete(id)
      return next
    })
  }, [])

  // Content arrives PEER-TO-PEER over the data mesh (no authority relays it). The
  // sender is the data connection's peer id; we attribute the name from the roster
  // (never the wire — unspoofable) and demux by kind. Receive-side caps are the trust
  // boundary now that messages come straight from peers.
  // INVARIANT: this is a stable ([]-dep) callback wired once to mesh.onData, so every
  // piece of state it reads MUST go through a ref (rosterRef, the cb refs, …) — reading
  // a state value directly would capture a stale closure.
  const dispatchContent = useCallback((from: string, raw: unknown) => {
    const c = asContent(raw)
    if (!c) return
    // Authority-distributed capability grants (Phase b): the room authority broadcasts the
    // whole per-peer grant map so EVERY peer enforces the same policy (not just host-local).
    // Accept it only from the current host id — a non-authority peer can't rewrite the policy.
    // It's control, not content, so it's handled before the roster/act gates (like idtoken).
    if (c.k === 'caps') {
      const host = roomRef.current?.hostId?.()
      if (host && from === host && !roomRef.current?.isAuthority?.()) {
        const next = new Map<string, Grant>()
        for (const [id, g] of Object.entries(c.grants ?? {})) next.set(id, sanitizeGrant(g as Partial<Grant>))
        grantsRef.current = next
        meshRef.current?.applyMediaGate?.() // enforce the distributed media grants locally too
      }
      return
    }
    // Verified-roster receive-side filter (docs §7): when the gate is active, drop any
    // content from a peer we haven't verified onto the committed roster — an intruder's
    // chat/app/pay/ink never renders. The ID token is the ONE exception (it's how a peer
    // BECOMES verified), so let it through to verification below.
    if (c.k !== 'idtoken' && !peerCleared(rosterGateRef.current, from)) return
    // Capability enforcement (receive-side / ACT): a peer may only EMIT data content if its grant
    // includes `send-chat`. A read-only agent's chat/app/pay/ink is dropped by every honest peer,
    // so it can't post even with a modified client. The ID token is control, not content — exempt.
    if (c.k !== 'idtoken' && !canAct(grantOfRef.current(from), 'send-chat')) {
      if (rosterRef.current.find((x) => x.id === from)?.meta?.role === 'agent') logAuditRef.current(from, 'blocked', c.k)
      return
    }
    const name = rosterName(rosterRef.current, from)
    if (c.k === 'chat') {
      const text = (c.text || '').slice(0, CHAT_MAX_LEN).trim()
      if (!text) return
      chatSeqRef.current += 1
      setChat((prev) => appendChat(prev, { from, name, text, id: chatSeqRef.current, self: false, dm: !!c.dm }))
    } else if (c.k === 'app') {
      if (appPayloadTooBig(c.data)) return // DoS backstop: drop an oversized app payload from a peer
      appCbRef.current?.({ from, data: c.data })
    } else if (c.k === 'pay') {
      const url = (c.url || '').slice(0, PAY_URL_MAX).trim()
      if (url) payCbRef.current?.({ from, name, label: (c.label || '').slice(0, PAY_NOTE_MAX).trim() || undefined, url, dm: !!c.dm })
    } else if (c.k === 'ink') {
      // Prefer the mover's STAMPED name + colour (identical for every receiver, regardless of how the
      // data-peer id resolves); fall back to the roster name / inkColor(from) for older senders.
      const inkName = typeof c.n === 'string' && c.n.trim() ? c.n.slice(0, 40).trim() : name
      const inkCol = typeof c.c === 'string' && c.c ? c.c.slice(0, 32) : undefined
      inkCbRef.current?.(from, inkName, c.e, inkCol)
    } else if (c.k === 'schema') {
      // A peer self-describing its app/view shape (agent discovery). Bound the name and the
      // document (same DoS ceiling as app payloads); newest published entry wins per (from,name).
      const sName = typeof c.name === 'string' ? c.name.slice(0, SCHEMA_NAME_MAX).trim() : ''
      if (!sName || appPayloadTooBig(c.schema)) return
      const key = `${from} ${sName}`
      // Per-peer cap: one peer flooding distinct names can't evict everyone else's schemas from
      // the shared map (ids contain no spaces, so the `${from} ` prefix matches only that peer).
      if (!schemasRef.current.has(key)) {
        let mine = 0
        for (const k of schemasRef.current.keys()) if (k.startsWith(`${from} `)) mine++
        if (mine >= SCHEMA_PER_PEER) return
      }
      const info: SchemaInfo = {
        from,
        name: sName,
        version: typeof c.version === 'string' ? c.version.slice(0, 64) : '',
        schema: c.schema,
      }
      schemasRef.current.set(key, info)
      capMap(schemasRef.current, SCHEMA_CAP)
      schemaCbsRef.current.forEach((cb) => cb(info))
    } else if (c.k === 'idtoken') {
      // Stash the peer's signed token; verification (signature + cert binding) happens
      // lazily in getIdentity, since the connection's cert may not be readable yet.
      // Cap the length (a Google RS256 token is ~1KB) so a peer can't DoS us with a
      // multi-megabyte "jwt" that we'd then base64-decode and run through WebCrypto.
      if (typeof c.jwt === 'string' && c.jwt && c.jwt.length <= JWT_MAX) {
        idTokensRef.current.set(from, c.jwt)
        idCacheRef.current.delete(from) // a new token invalidates any cached result
        capMap(idTokensRef.current)
      }
    }
  }, [])

  // Verified-roster send gate (docs §7): a broadcast needs `canShare` (I and EVERY present
  // peer have proven a listed identity); a directed message needs only that ONE peer cleared
  // (others can't see it anyway). Inert — always true — when the gate isn't active.
  const sendAllowed = useCallback((to?: string): boolean => {
    const g = rosterGateRef.current
    if (g.active && (to ? !peerCleared(g, to) : !g.canShare)) return false
    // Capability (PERCEIVE): a DIRECTED message needs the recipient to allow directed data. A
    // broadcast's per-recipient withholding is done in broadcastContent, so it isn't blocked here.
    if (to && !canPerceive(grantOf(to), 'receive-directed')) return false
    return true
  }, [grantOf])

  // Send-side / PERCEIVE enforcement for broadcasts: deliver only to recipients whose grant allows
  // `read-chat`. A peer without it never receives the bytes (real sender-side withholding, not a
  // receiver drop). When everyone can perceive — the common case — it's the single fast broadcast.
  const broadcastContent = useCallback((msg: ContentMsg) => {
    const mesh = meshRef.current
    if (!mesh) return
    const others = rosterRef.current.filter((m) => m.id !== voiceIdRef.current)
    if (others.every((m) => canPerceive(grantOf(m.id), 'read-chat'))) {
      mesh.broadcastData(msg)
      return
    }
    for (const m of others) if (canPerceive(grantOf(m.id), 'read-chat')) mesh.sendData(m.id, msg)
  }, [grantOf])

  // Send to ONE peer (private, point-to-point) when `to` is given, else broadcast.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent is stable
  const sendChat = useCallback((text: string, to?: string) => {
    const t = (text || '').slice(0, CHAT_MAX_LEN).trim()
    if (!t || !meshRef.current || !sendAllowed(to)) return
    const msg = { k: 'chat', text: t, ...(to ? { dm: true as const } : {}) } satisfies ContentMsg
    if (to) meshRef.current.sendData(to, msg)
    else broadcastContent(msg)
    // Local echo — no relay returns our own line to us anymore.
    chatSeqRef.current += 1
    setChat((prev) =>
      appendChat(prev, {
        from: voiceIdRef.current,
        name: nameRef.current.trim() || 'You',
        text: t,
        id: chatSeqRef.current,
        self: true,
        dm: !!to,
        to: to ? rosterName(rosterRef.current, to) : undefined,
      }),
    )
  }, [sendAllowed])

  const sendApp = useCallback((data: unknown) => {
    if (!sendAllowed() || tooBigToSend(data)) return
    broadcastContent({ k: 'app', data } satisfies ContentMsg)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent is stable
  }, [sendAllowed])
  const sendAppTo = useCallback((to: string, data: unknown) => {
    if (!sendAllowed(to) || tooBigToSend(data)) return
    meshRef.current?.sendData(to, { k: 'app', data } satisfies ContentMsg)
  }, [sendAllowed])
  const onApp = useCallback((cb: (m: AppMessage) => void) => {
    appCbRef.current = cb
  }, [])
  const sendPay = useCallback((label: string, url: string, to?: string) => {
    const u = (url || '').slice(0, PAY_URL_MAX).trim()
    if (!u || !meshRef.current || !sendAllowed(to)) return
    const msg = {
      k: 'pay',
      label: (label || '').slice(0, PAY_NOTE_MAX).trim() || undefined,
      url: u,
      ...(to ? { dm: true as const } : {}),
    } satisfies ContentMsg
    if (to) meshRef.current.sendData(to, msg)
    else broadcastContent(msg)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent is stable
  }, [sendAllowed])
  const onPay = useCallback((cb: (p: PayRequest) => void) => {
    payCbRef.current = cb
  }, [])
  const sendInk = useCallback((e: InkEvent) => {
    if (!sendAllowed()) return
    // Stamp our OWN display name AND colour on every ink event. The receiver labels + colours the
    // laser/pen from THESE, not from rosterName(from)/inkColor(from) — so they're identical for everyone
    // even if the data-peer id doesn't line up with the roster entry (the bug that made a viewer see the
    // wrong name AND an inconsistent colour). Only cleared peers' ink renders, so it's safe.
    broadcastContent({
      k: 'ink',
      e,
      n: nameRef.current.trim() || undefined,
      c: voiceIdRef.current ? inkColor(voiceIdRef.current) : undefined,
    } satisfies ContentMsg)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent is stable
  }, [sendAllowed])
  const onInk = useCallback((cb: (from: string, name: string, e: InkEvent, color?: string) => void) => {
    inkCbRef.current = cb
  }, [])

  // Schema discovery (#4): publish a description of our app/view shape so agents can self-discover
  // it. We keep our own published schemas in `ownSchemasRef` so we can re-broadcast them to peers
  // who join later (see the onRoster effect) — discovery must be order-independent. `schemasRef`
  // holds only PEERS' schemas (a broadcast never echoes home); getSchemas() merges in our own,
  // resolved to our current id so it's right even if we registered before joining.
  const registerSchema = useCallback(
    (name: string, version: string, schema: unknown) => {
      const n = (name || '').slice(0, SCHEMA_NAME_MAX).trim()
      // Gate the publish like any other content send: in a verified-roster room we don't share
      // until mutual pre-share clears (sendAllowed). Bound how many distinct schemas we publish.
      if (!n || tooBigToSend(schema) || !sendAllowed()) return
      const v = (version || '').slice(0, 64)
      ownSchemasRef.current.set(n, { version: v, schema })
      capMap(ownSchemasRef.current, OWN_SCHEMA_CAP)
      broadcastContent({ k: 'schema', name: n, version: v, schema } satisfies ContentMsg)
      // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent tracks sendAllowed
    },
    [sendAllowed],
  )
  const getSchemas = useCallback((): readonly SchemaInfo[] => {
    const own: SchemaInfo[] = [...ownSchemasRef.current].map(([name, { version, schema }]) => ({
      from: voiceIdRef.current,
      name,
      version,
      schema,
    }))
    return [...own, ...schemasRef.current.values()]
  }, [])
  const onSchema = useCallback((cb: (s: SchemaInfo) => void) => {
    schemaCbsRef.current.add(cb)
    return () => {
      schemaCbsRef.current.delete(cb)
    }
  }, [])
  // Re-publish our own schemas on every roster change so late joiners discover them
  // (order-independent), mirroring the caps re-broadcast. Gated by sendAllowed (same verified-roster
  // hold as registerSchema) and idempotent (latest-wins on receive). Held in a ref so the onRoster
  // effect calls a fresh closure that tracks the current sendAllowed/broadcastContent.
  const rebroadcastSchemas = useCallback(() => {
    if (!sendAllowed()) return
    for (const [name, { version, schema }] of ownSchemasRef.current) {
      broadcastContent({ k: 'schema', name, version, schema } satisfies ContentMsg)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent tracks sendAllowed
  }, [sendAllowed])
  const rebroadcastSchemasRef = useRef(rebroadcastSchemas)
  rebroadcastSchemasRef.current = rebroadcastSchemas

  // Min-version kill-switch: once at boot, ask the deployment's floor whether THIS build is
  // retired. Fail-open (a blip never blocks); if retired, the engine refuses to join (below).
  useEffect(() => {
    if (previewRef.current) return // the landing demo never dials — nothing to retire
    let alive = true
    void checkRetired(APP_VERSION, MIN_VERSION_URL).then((r) => {
      if (!alive || !r.retired) return
      retiredRef.current = r
      setRetired(r)
      setError(r.message || 'This version of Kibitz is out of date and has been retired. Reload the page.')
    })
    return () => {
      alive = false
    }
  }, [])

  // The host can reset the room → clear our ephemeral chat scrollback.
  useEffect(() => {
    room?.link.onReset?.(() => setChat([]))
  }, [room])

  const getSafetyCode = useCallback(
    (participantId: string): Promise<SafetyInfo | null> =>
      meshRef.current?.safetyCodeFor(participantId) ?? Promise.resolve(null),
    [],
  )

  const getConnectionInfo = useCallback(
    (participantId: string): Promise<ConnInfo | null> =>
      meshRef.current?.connectionInfoFor(participantId) ?? Promise.resolve(null),
    [],
  )

  // --- Identity (L3) — all no-ops unless idConfig is set ---------------------------
  const selfIdentityRef = useRef<VerifiedIdentity | null>(null)

  // Generate the pinned cert ONCE; join() and sign-in share it whichever runs first,
  // so the token's nonce (hash of this cert's fingerprint) matches the cert every peer
  // actually handshakes with.
  const ensurePinnedCert = useCallback((): Promise<RTCCertificate | null> => {
    if (pinnedCertRef.current) return Promise.resolve(pinnedCertRef.current)
    // Prefer the Widget-pinned shared cert (also on the presence peer → one token gates
    // both the authority and peers). Only generate our own when there isn't one.
    if (sharedCertRef.current) {
      pinnedCertRef.current = sharedCertRef.current
      selfFpRef.current = certFingerprint(sharedCertRef.current) ?? ''
      return Promise.resolve(sharedCertRef.current)
    }
    // Share ONE in-flight generation between concurrent callers (join + sign-in in the
    // same tick) so they don't each mint a different cert — which would desync the
    // nonce (signed against one fingerprint) from the cert the mesh actually presents.
    if (!pinnedCertPromiseRef.current) {
      pinnedCertPromiseRef.current = generatePinnedCert().then((cert) => {
        if (cert) {
          pinnedCertRef.current = cert
          selfFpRef.current = certFingerprint(cert) ?? ''
        }
        pinnedCertPromiseRef.current = null
        return cert
      })
    }
    return pinnedCertPromiseRef.current
  }, [])

  // Hand our signed token to any roster peer we haven't yet (sign-in + new joiners).
  const shareSelfToken = useCallback(() => {
    const jwt = selfJwtRef.current
    const mesh = meshRef.current
    if (!jwt || !mesh) return
    for (const m of rosterRef.current) {
      if (m.id === voiceIdRef.current || sentTokenToRef.current.has(m.id)) continue
      mesh.sendData(m.id, { k: 'idtoken', jwt } satisfies ContentMsg)
      sentTokenToRef.current.add(m.id)
    }
  }, [])

  // Verify OUR OWN freshly-signed token exactly as peers will (signature + cert binding) — via
  // verifyPeerMulti when accepted providers are configured (Google/email-code), else the single
  // Google config. Best-effort: if keys are unreachable we skip the local badge but still
  // broadcast the token, so peers verify it once they can reach the provider's keys.
  const selfVerify = useCallback(async (jwt: string, certFp: string): Promise<VerifiedIdentity | null> => {
    const now = Math.floor(Date.now() / 1000)
    const providers = acceptProvidersRef.current
    if (providers && providers.length) {
      const v = await verifyPeerMulti({ jwt, remoteFp: certFp, providers, now, salt: roomSaltRef.current }).catch(() => null)
      return v && v.ok ? v.identity : null
    }
    const cfg = idConfigRef.current
    const resolver = jwksRef.current
    if (!cfg || !resolver) return null
    const jwks = await resolver.resolve(discoveryIssuerFor(cfg))
    const v = await verifyPeerIdentity({ jwt, remoteFp: certFp, audience: cfg.clientId, issuer: issuersFor(cfg), jwks, now, salt: roomSaltRef.current })
    return v.ok ? v.identity : null
  }, [])

  // Adopt a freshly-obtained token — from our own in-page sign-in OR a token minted by an
  // external sign-in surface (e.g. the extension's kibitz.chat verify popup, which signs with
  // the nonce from `identityNonce()`). Verify it locally as peers will, hand it to the room
  // gate, and deliver it to the roster. Returns true if adopted (broadcast), even when the
  // local badge couldn't be computed (keys unreachable). Stale-guarded against a cert that
  // rotated/teardown while a late dialog resolved.
  const ingestSelfToken = useCallback(
    async (jwt: string, certFp: string): Promise<boolean> => {
      if (selfFpRef.current !== certFp) return false
      selfJwtRef.current = jwt
      // Hand the token to the room so it rides our knock/announce — an identity-gated authority
      // verifies it (against our presence cert) before admitting us.
      roomRef.current?.link.setIdentityToken?.(jwt)
      try {
        const identity = await selfVerify(jwt, certFp)
        if (identity && selfFpRef.current === certFp) {
          selfIdentityRef.current = identity
          setSelfIdentity(identity)
        }
      } catch {
        /* keys unreachable — peers still verify the broadcast token */
      }
      if (selfFpRef.current !== certFp) return false // torn down during verify
      sentTokenToRef.current.clear() // (re)deliver to everyone now we have a token
      shareSelfToken()
      return true
    },
    [shareSelfToken, selfVerify],
  )

  const signInIdentity = useCallback(
    async (container: HTMLElement, method: 'google' | 'email' = 'google'): Promise<boolean> => {
      // Pick the local sign-in provider: Google (built from idConfig) or email-code (our backend).
      const provider =
        method === 'email'
          ? emailCodeProvider({ room: roomSaltRef.current ?? '', grant: getGrant() ?? undefined })
          : providerRef.current
      if (!provider) return false
      await ensurePinnedCert()
      const certFp = selfFpRef.current
      if (!certFp) {
        setError("Couldn't prepare a secure identity on this device.")
        return false
      }
      const nonce = await nonceForFingerprint(certFp, roomSaltRef.current)
      const res = await provider.signIn({ nonce, container })
      if (!res?.jwt) return false
      return ingestSelfToken(res.jwt, certFp)
    },
    [ensurePinnedCert, ingestSelfToken],
  )

  // The cert-bound nonce an EXTERNAL sign-in surface must echo so the token it mints binds to
  // THIS connection (the extension's kibitz.chat popup reads it, passes it to GIS/email, and
  // returns the token to `provideIdentityToken`). Null until our cert is ready. Same value
  // signInIdentity computes internally — exposed so signer and verifier can be different pages.
  const identityNonce = useCallback(async (): Promise<string | null> => {
    await ensurePinnedCert()
    const certFp = selfFpRef.current
    if (!certFp) return null
    return nonceForFingerprint(certFp, roomSaltRef.current)
  }, [ensurePinnedCert])

  // Adopt a cert-bound token obtained out-of-page (signed against `identityNonce()`), exactly as
  // an in-page sign-in would. Lets an embedder run the OIDC/email flow on a real https origin
  // (where GIS + our backend work) and hand the result back to the headless engine.
  const provideIdentityToken = useCallback(
    async (jwt: string): Promise<boolean> => {
      if (!jwt || jwt.length > JWT_MAX) return false
      await ensurePinnedCert()
      const certFp = selfFpRef.current
      if (!certFp) return false
      return ingestSelfToken(jwt, certFp)
    },
    [ensurePinnedCert, ingestSelfToken],
  )

  // AI-AGENT room entry: sign a fresh cert-bound assertion over (room, our DTLS fingerprint)
  // and hand it to the room so it rides our announce — the authority verifies it against the
  // room's allow-list before admitting us. `roomSalt` is the normalized room id, which equals
  // the manifest's `room`, so the assertion binds to the same room the allow-list was signed for.
  const refreshAgentAssertion = useCallback(async (): Promise<void> => {
    const key = agentSignKeyRef.current
    if (!key) return
    // The assertion's room MUST equal the manifest's room (== roomSalt). Signing with '' would
    // bind to no room and always be rejected — so wait for the salt rather than emit a dud.
    const room = roomSaltRef.current
    if (!room) return
    await ensurePinnedCert()
    const fp = selfFpRef.current
    if (!fp) return
    const assertion = await signAgentAssertion(key, { room, fp, now: Math.floor(Date.now() / 1000) })
    roomRef.current?.link.setAgentAssertion?.(assertion)
  }, [ensurePinnedCert])

  // Mount AS an agent: adopt the agent's own private signing key (a JWK the operator holds),
  // present a cert-bound assertion now, and keep it fresh on a timer (under the assertion's
  // freshness window) so a reconnect — which the authority re-verifies — never goes stale.
  const provideAgentKey = useCallback(
    async (privateKeyJwk: JsonWebKey): Promise<boolean> => {
      try {
        agentSignKeyRef.current = await importAgentPrivateKey(privateKeyJwk)
      } catch {
        return false
      }
      // Replace any prior timer BEFORE the await, so a throwing refresh can't strand the old one.
      if (agentRefreshRef.current) clearInterval(agentRefreshRef.current)
      agentRefreshRef.current = setInterval(() => void refreshAgentAssertion(), 4 * 60 * 1000)
      await refreshAgentAssertion()
      return true
    },
    [refreshAgentAssertion],
  )
  // Stop the re-sign timer when the call unmounts (no leaked interval).
  useEffect(() => () => void (agentRefreshRef.current && clearInterval(agentRefreshRef.current)), [])

  // Mount AS a paid agent: forward the latest network-access credit credential (opaque to us — the
  // operator's runner fetches it from a trusted issuer and re-supplies it ~every minute) to the room
  // so it rides our announce. The authority verifies it and keeps admitting us while it's fresh.
  const provideAgentCredit = useCallback((credential: string): void => {
    roomRef.current?.link.setAgentCredit?.(credential)
  }, [])

  // HOST admin: after claimHost unseals the link's host private key, hold it so we can sign cert-bound
  // moderation commands the coordinator verifies against the link-committed host PUBLIC key.
  const hostPrivRef = useRef<CryptoKey | null>(null)
  const claimHost = useCallback(
    async (password: string, sealedBlob: string): Promise<boolean> => {
      const jwk = await unsealHostKey(sealedBlob, password)
      if (!jwk) return false // wrong password / tampered blob
      let priv: CryptoKey
      try {
        priv = await importHostPrivateKey(jwk)
      } catch {
        return false
      }
      const room = roomSaltRef.current
      if (!room) return false
      await ensurePinnedCert()
      const fp = selfFpRef.current
      if (!fp) return false
      hostPrivRef.current = priv
      const token = await signHostCommand(priv, { room, fp, op: 'claim', now: Math.floor(Date.now() / 1000) })
      roomRef.current?.link.sendModCommand?.(token)
      return true
    },
    [ensurePinnedCert],
  )
  const hostModerate = useCallback(
    async (op: HostOp, target?: string): Promise<boolean> => {
      const priv = hostPrivRef.current
      if (priv) {
        // PASSWORD tier: sign a cert-bound command the coordinator verifies (works from any seat).
        const room = roomSaltRef.current
        if (!room) return false
        await ensurePinnedCert()
        const fp = selfFpRef.current
        if (!fp) return false
        const token = await signHostCommand(priv, { room, fp, op, ...(target ? { target } : {}), now: Math.floor(Date.now() / 1000) })
        roomRef.current?.link.sendModCommand?.(token)
        return true
      }
      // SOFT (name) tier: no key to sign with — drive the authority methods directly. These are no-ops
      // unless we're the coordinator, which scopes soft-host moderation to "the host IS the coordinator"
      // (the creator-stays flow). claim is implicit (by name), so it has no command here.
      const r = roomRef.current
      if (!r) return false
      switch (op) {
        case 'lobbyon': r.setLobby?.(true); break
        case 'lobbyoff': r.setLobby?.(false); break
        case 'lock': r.setLocked?.(true); break
        case 'unlock': r.setLocked?.(false); break
        case 'reset': r.resetRoom?.(); break
        case 'kick': if (target) r.remove?.(target); break
        case 'admit': if (target) r.admit?.(target); break
        case 'deny': if (target) r.deny?.(target); break
        case 'claim': break
      }
      return true
    },
    [ensurePinnedCert],
  )
  // SOFT host claim: adopt the committed host name as our display name and re-announce, so the authority
  // recognizes us as the host (name match). nameRef is set directly for a timing-safe announce; the Widget
  // also setName(hostName) to keep its own state + localStorage in sync.
  const claimHostByName = useCallback(
    (hostName: string) => {
      nameRef.current = hostName
      announceSelf(true)
    },
    [announceSelf],
  )
  // OIDC host: when WE'RE the authority and have verified a member proved the committed host email, mark
  // them the host. No-op on a participant / non-OIDC room (the room gates it). The Widget calls this from
  // an effect once getIdentity/selfIdentity resolves the matching email.
  const declareHost = useCallback((memberId: string) => {
    roomRef.current?.declareHost?.(memberId)
  }, [])

  // Verify a peer's cert-bound token, peer-to-peer. Memoised per (peer, jwt, cert) so
  // the UI can poll cheaply; null until they've sent a token AND we're connected.
  const getIdentity = useCallback(async (participantId: string): Promise<VerifiedIdentity | null> => {
    const cfg = idConfigRef.current
    const providers = acceptProvidersRef.current
    if (!cfg && !(providers && providers.length)) return null
    if (participantId === voiceIdRef.current) return selfIdentityRef.current
    const jwt = idTokensRef.current.get(participantId)
    if (!jwt) return null
    const fp = (await meshRef.current?.safetyCodeFor(participantId))?.remoteFp
    if (!fp) return null // connection not ready — the poll will retry
    const cached = idCacheRef.current.get(participantId)
    if (cached && cached.jwt === jwt && cached.fp === fp) return cached.id
    let id: VerifiedIdentity | null = null
    if (providers && providers.length) {
      // Multi-provider: route the token by its issuer to the right provider (Google / email-code).
      const r = await verifyPeerMulti({ jwt, remoteFp: fp, providers, now: Math.floor(Date.now() / 1000), salt: roomSaltRef.current }).catch(() => null)
      id = r && r.ok ? r.identity : null
    } else if (cfg) {
      // Single-provider (Google) back-compat path, with one JWKS-rotation retry.
      const resolver = jwksRef.current
      if (!resolver) return null
      const discovery = discoveryIssuerFor(cfg)
      const run = async () =>
        verifyPeerIdentity({
          jwt,
          remoteFp: fp,
          audience: cfg.clientId,
          issuer: issuersFor(cfg),
          jwks: await resolver.resolve(discovery),
          now: Math.floor(Date.now() / 1000),
          salt: roomSaltRef.current,
        })
      let result = await run().catch(() => null)
      if (result && !result.ok && /kid|signature/.test(result.reason)) {
        resolver.invalidate(discovery)
        result = await run().catch(() => null)
      }
      id = result && result.ok ? result.identity : null
    }
    idCacheRef.current.set(participantId, { jwt, fp, id })
    capMap(idCacheRef.current)
    return id
  }, [])

  // Track the roster; while in the call, reconcile the mesh to match it.
  useEffect(() => {
    if (!room) return
    room.link.onRoster((members) => {
      rosterRef.current = members
      setRoster(members)
      meshRef.current?.setRoster(members)
      // Self-heal: the roster authority can change/restart (host migration) and come
      // back EMPTY. If we're in the call but absent from an incoming roster,
      // re-announce ourselves — converges in one round-trip, token-deduped.
      if (mediaRef.current && voiceIdRef.current && !members.some((m) => m.id === voiceIdRef.current)) {
        announceSelf(true)
      }
      // If we've signed in, hand our cert-bound token to anyone newly present.
      shareSelfToken()
      // If we're the authority and hold capability grants, re-broadcast them on every
      // roster change so a NEW joiner enforces the current policy too (and so a freshly
      // promoted authority after a host migration re-publishes what it inherited).
      if (grantsRef.current.size) broadcastCapsRef.current()
      // Re-publish our app schemas so a peer that just joined can discover them (agent discovery).
      if (ownSchemasRef.current.size) rebroadcastSchemasRef.current()
    })
  }, [room, announceSelf, shareSelfToken])

  // Presence is NEVER fire-and-forget: while in the call, re-announce every few
  // seconds. Any transient drop during connection setup (or an authority restart)
  // then self-corrects within a tick — so a missing tile fixes itself instead of
  // waiting for the user to toggle their mic/camera to force the re-announce.
  // Re-announcing an unchanged roster is a no-op for the mesh (setRoster only acts
  // on real membership deltas), so this can't disrupt live media.
  useEffect(() => {
    if (!inCall) return
    const id = setInterval(() => {
      if (mediaRef.current) announceSelf(true)
    }, 3000)
    return () => clearInterval(id)
  }, [inCall, announceSelf])

  // Verified-roster (docs §7) — recompute the mutual, pre-share gate while in the call.
  // For each present peer we read its cert-bound verified identity (getIdentity, memoised
  // so this poll is cheap) and check it against the committed roster; our own verified
  // identity drives the self-gate. The result lands in BOTH state (for the UI) and a ref
  // (so the content senders/receiver above can gate synchronously). Inert — and reset to
  // the inert view — whenever there's no roster, so non-verified-roster rooms are untouched.
  useEffect(() => {
    const members = rosterMembersRef.current ?? []
    const domains = rosterDomainsRef.current ?? []
    if (members.length === 0 && domains.length === 0) {
      const inert = evaluateRosterGate({ members: null })
      rosterGateRef.current = inert
      setRosterGate(inert)
      return
    }
    if (!inCall) return
    let alive = true
    const recompute = async () => {
      const present = rosterRef.current.filter((m) => m.id !== voiceIdRef.current)
      const peers = await Promise.all(
        present.map(async (m) => ({ id: m.id, identity: (await getIdentity(m.id).catch(() => null))?.email ?? null })),
      )
      if (!alive) return
      const view = evaluateRosterGate({ members, domains, self: selfIdentityRef.current?.email ?? null, peers })
      rosterGateRef.current = view
      setRosterGate(view)
    }
    void recompute()
    const id = setInterval(recompute, 1500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [rosterKey, inCall, getIdentity])

  const teardown = useCallback(() => {
    reannounceRef.current.forEach(clearTimeout)
    reannounceRef.current = []
    meshRef.current?.close()
    meshRef.current = null
    mediaRef.current?.close()
    mediaRef.current = null
    voiceIdRef.current = ''
    setSelfVoiceId(null)
    stopStream(localRef.current)
    localRef.current = null
    // The placeholder may be swapped OUT of the stream while the camera is on —
    // stop it explicitly so the canvas capture is released either way.
    placeholderRef.current?.stop()
    placeholderRef.current = null
    // Same for the silent audio placeholder (gone once the real mic is swapped in).
    placeholderAudioRef.current?.stop()
    placeholderAudioRef.current = null
    // Release the dedicated media-gate placeholders (kept alive for the whole call).
    gateVideoPhRef.current?.stop()
    gateVideoPhRef.current = null
    gateAudioPhRef.current?.stop()
    gateAudioPhRef.current = null
    realMicRef.current = false
    stopStream(selfStreamRef.current)
    selfStreamRef.current = null
    setSelfStream(null)
    setRemote(new Map())
    setInCall(false)
    setCamOn(false)
    setMicOn(false)
    micRef.current = false
    camRef.current = false
    // Identity: drop the cert/token/cache so a fresh call mints a fresh cert and the
    // user re-signs (a new cert ⇒ a new binding). Leaves idConfig/provider/jwks intact.
    // Clearing selfFpRef also invalidates any sign-in still mid-dialog (it captured the
    // old fingerprint and bails when it no longer matches — see signInIdentity).
    pinnedCertRef.current = null
    pinnedCertPromiseRef.current = null
    selfFpRef.current = ''
    selfJwtRef.current = ''
    idTokensRef.current.clear()
    idCacheRef.current.clear()
    sentTokenToRef.current.clear()
    // Peers' published schemas are ephemeral to the call (a fresh call rediscovers them). Our OWN
    // schemas (ownSchemasRef) survive — the app registered them and we re-publish on reconnect.
    schemasRef.current.clear()
    selfIdentityRef.current = null
    setSelfIdentity(null)
    // Verified-roster: drop back to the inert view so a left/ended call never strands the
    // UI in a "verifying the room…" hold (a fresh call recomputes from scratch).
    const inertGate = evaluateRosterGate({ members: rosterMembersRef.current, domains: rosterDomainsRef.current })
    rosterGateRef.current = inertGate
    setRosterGate(inertGate)
  }, [])

  // Leave the call if the room/page goes away (only announce if we'd joined).
  useEffect(() => {
    return () => {
      if (mediaRef.current) announceSelf(false)
      teardown()
    }
  }, [teardown, announceSelf])

  const join = useCallback(async (): Promise<boolean> => {
    if (!roomRef.current || mediaRef.current) return false
    // Kill-switch: a retired build refuses to connect (the notice is already on `error`).
    if (retiredRef.current) {
      setError(retiredRef.current.message || 'This version of Kibitz has been retired — reload the page.')
      return false
    }
    // Join WITHOUT a microphone prompt or capture: negotiate a SILENT placeholder audio lane up front
    // (a real, flowing zero-gain track — see createPlaceholderAudioTrack — so even iOS completes the
    // connection), and swap the real mic in on first unmute via replaceTrack. NOT capturing the mic at
    // join matters in a car: starting mic capture makes iOS yank Bluetooth audio from the high-quality
    // A2DP media profile onto the narrowband HFP call profile, glitching the car link — so we stay on
    // A2DP until you actually choose to talk. Internet calls connect via STUN/TURN regardless of mic
    // permission; on a LAN, iOS exposes connectable (non-mDNS) candidates once you unmute (which grabs
    // the mic and re-establishes). Only if Web Audio is missing do we fall back to grabbing at join.
    const stream = new MediaStream()
    let grabbedRealMic = false
    if (!previewRef.current) {
      const micPlaceholder = createPlaceholderAudioTrack()
      if (micPlaceholder) {
        placeholderAudioRef.current = micPlaceholder
        stream.addTrack(micPlaceholder)
      } else {
        // No Web Audio: grab the mic at join, MUTED. Permission unlocks the real ICE
        // candidates; the track stays disabled until the user unmutes.
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: false })
          const t = mic.getAudioTracks()[0]
          if (t) {
            t.enabled = false
            stream.addTrack(t)
            grabbedRealMic = true
            // Permission just unlocked real candidates — re-establish the data link
            // (created at panel-open, before permission) so it connects now.
            roomRef.current?.reconnect?.()
          }
        } catch {
          flashNotice('Microphone access was blocked. Allow it in your browser to join the call.')
          return false
        }
      }
    }
    // The media backend (PeerJS online, or the relay hub offline). Stash it before
    // the async open so a leave/unmount mid-handshake tears it down (check below).
    const media = makeMediaRef.current()
    mediaRef.current = media
    try {
      // Negotiate a two-way video lane up-front via a placeholder track, so camera
      // toggles never re-dial (see core/media + core/mesh). Added BEFORE open() so
      // the mesh's first dials already carry the video lane.
      const placeholder = createPlaceholderVideoTrack()
      placeholderRef.current = placeholder
      if (placeholder) stream.addTrack(placeholder)

      // Mint the dedicated media-gate placeholders NOW — before any await — so the silent
      // audio one is created while the join tap's user-activation is still fresh (an
      // AudioContext needs a gesture to resume). They're never added to `local`; the mesh
      // substitutes them per-peer to withhold a share / audio from an unentitled peer.
      if (!previewRef.current) {
        gateVideoPhRef.current = createPlaceholderVideoTrack()
        gateAudioPhRef.current = createPlaceholderAudioTrack()
      }

      // Identity (opt-in): pin a shared cert so every connection presents the same one
      // — a single signed token then verifies for all peers. Generated lazily and
      // shared with sign-in (whichever happens first). Skipped entirely when off.
      const certificate = idConfigRef.current ? ((await ensurePinnedCert()) ?? undefined) : undefined
      // Per-peer media gate (Phase 4): hand the gate + dedicated placeholders to open() so the mesh
      // installs it BEFORE the local stream — a peer already dialling us is gated from its first
      // frame. Inert for an all-human room (every grant full → real tracks to everyone, no churn).
      const mediaGateOpt = previewRef.current
        ? undefined
        : { gate: mediaGate.current, placeholders: { video: gateVideoPhRef.current, audio: gateAudioPhRef.current } }
      const { voiceId, mesh } = await media.open(stream, onRemote, { certificate, mediaGate: mediaGateOpt, relayOnly: relayOnlyRef.current })
      if (mediaRef.current !== media) {
        mesh.close()
        stopStream(stream)
        placeholder?.stop()
        return false // left during the handshake
      }
      voiceIdRef.current = voiceId
      setSelfVoiceId(voiceId)
      localRef.current = stream
      // Self preview/meter stream: the silent placeholder for now (rebuilt with the
      // real mic on first unmute, so the voice-meter analyser inits on real audio).
      const self = new MediaStream(stream.getAudioTracks())
      selfStreamRef.current = self
      setSelfStream(self)
      setMicOn(false)
      micRef.current = false
      camRef.current = false
      realMicRef.current = grabbedRealMic
      meshRef.current = mesh
      mesh.onData(dispatchContent) // content flows peer-to-peer over the data mesh
      announceSelf(true) // re-broadcast the roster/presence including us
      mesh.setRoster(rosterRef.current) // dial anyone already in the call
      setInCall(true)
      setError(null)
      // Belt-and-suspenders: re-announce a couple of times in case the first
      // announce raced the authority's data channel (the authority also re-syncs
      // the roster on its heartbeat — see room.ts — this just makes it snappy).
      reannounceRef.current.forEach(clearTimeout)
      reannounceRef.current = [600, 1800].map((ms) =>
        setTimeout(() => {
          if (mediaRef.current) announceSelf(true)
        }, ms),
      )
      return true
    } catch {
      stopStream(stream)
      placeholderRef.current?.stop()
      placeholderRef.current = null
      placeholderAudioRef.current = null // stopped by stopStream above
      media.close()
      if (mediaRef.current === media) mediaRef.current = null
      setError("Couldn't connect the call. Try again.")
      return false
    }
  }, [onRemote, announceSelf, ensurePinnedCert, flashNotice])

  const leave = useCallback(() => {
    announceSelf(false)
    teardown()
  }, [teardown, announceSelf])

  /** Free a captured-but-muted microphone (iOS): stop the real mic track and substitute the silent
   *  placeholder, so iOS drops the recording indicator and its record-mode audio session — which is
   *  what CLICKS on an app-switch gesture. The next unmute re-grabs the mic. Must be called from a
   *  user gesture (the placeholder AudioContext needs one). No-op unless iOS + muted + a real mic is
   *  currently captured. */
  const releaseMutedMic = useCallback(() => {
    if (keepMicCapturedRef.current) return // car mode holds the mic so call audio stays on the car
    if (!isIOS() || micRef.current || !realMicRef.current) return
    const stream = localRef.current
    if (!stream) return
    const ph = createPlaceholderAudioTrack()
    if (!ph) return
    meshRef.current?.replaceAudioTrack(ph) // real mic → silent placeholder on the live mesh
    for (const t of stream.getAudioTracks()) {
      stream.removeTrack(t)
      t.stop() // release the hardware → iOS recording indicator off
    }
    stream.addTrack(ph)
    placeholderAudioRef.current = ph
    realMicRef.current = false // so the next unmute re-grabs the mic
    const self = selfStreamRef.current
    const rebuilt = new MediaStream(self ? self.getVideoTracks() : [])
    selfStreamRef.current = rebuilt
    setSelfStream(rebuilt)
  }, [])

  // Grab the real mic and install it on the live mesh — replaceTrack the silent placeholder on every
  // connection (no re-dial/renegotiation, iOS-safe), swap it into the stream so future dials carry it,
  // and rebuild selfStream so the voice-meter analyser re-inits on real audio. Leaves the muted state
  // as-is (enabled = micRef). Returns true once a real mic is captured. No-op if already captured.
  const captureMic = useCallback(async (deviceId?: string): Promise<boolean> => {
    if (realMicRef.current) return true
    const stream = localRef.current
    if (!stream) return false
    let track: MediaStreamTrack | undefined
    try {
      const audio = deviceId ? { ...AUDIO, deviceId: { exact: deviceId } } : AUDIO
      const mic = await navigator.mediaDevices.getUserMedia({ audio, video: false })
      track = mic.getAudioTracks()[0]
    } catch {
      flashNotice('Microphone access was blocked. Allow it to use voice.')
      return false
    }
    if (!track) return false
    // Permission just unlocked real ICE candidates (iOS Safari) — kick the data link to re-establish.
    roomRef.current?.reconnect?.()
    const placeholder = placeholderAudioRef.current
    if (placeholder) {
      meshRef.current?.replaceAudioTrack(track) // silent → real on the live mesh
      stream.removeTrack(placeholder)
      placeholder.stop()
      placeholderAudioRef.current = null
    }
    if (!stream.getAudioTracks().includes(track)) stream.addTrack(track)
    track.enabled = micRef.current // honour the current muted state (engageMic captures while muted)
    realMicRef.current = true
    const self = selfStreamRef.current
    const rebuilt = new MediaStream([track, ...(self ? self.getVideoTracks() : [])])
    selfStreamRef.current = rebuilt
    setSelfStream(rebuilt)
    return true
  }, [flashNotice])

  const toggleMic = useCallback(async (deviceId?: string) => {
    const stream = localRef.current
    if (!stream) return
    const next = !micRef.current
    // FIRST unmute grabs the mic now (no prompt on entry — it lands when you choose to talk). An
    // explicit deviceId (e.g. the pre-join's chosen mic) selects that input.
    if (next && !realMicRef.current && !(await captureMic(deviceId))) return
    micRef.current = next
    stream.getAudioTracks().forEach((t) => (t.enabled = next))
    setMicOn(next)
    // When muting, FREE the captured mic (iOS) — stops the recording, so there's no recording
    // indicator and nothing for an app-switch gesture to click. (Car mode opts out — see keepMic.)
    if (!next) releaseMutedMic()
  }, [captureMic, releaseMutedMic])

  // Car mode (iOS): capture the mic while staying muted, so the call's voice audio routes to a
  // Bluetooth/car device immediately and there's no profile-switch glitch on later mute/unmute. Paired
  // with setKeepMicCaptured(true) so releaseMutedMic won't free it. Other platforms route fine without.
  const engageMic = useCallback(() => {
    if (!isIOS()) return
    void captureMic()
  }, [captureMic])
  const setKeepMicCaptured = useCallback((on: boolean) => {
    keepMicCapturedRef.current = on
  }, [])

  // iOS: the mic is grabbed at join to unlock ICE, but you join MUTED — free it as soon as the call
  // is up so a listener who never touches mute also gets the recording indicator off. Safe: ICE is
  // unlocked by PERMISSION (which persists), not by capturing; the gate placeholder already resumed
  // the audio context at join, so no fresh gesture is needed. Self-gates (iOS + muted + real mic).
  useEffect(() => {
    if (inCall) releaseMutedMic()
  }, [inCall, releaseMutedMic])

  const toggleCam = useCallback(async (facing?: CamFacing, deviceId?: string) => {
    const mesh = meshRef.current
    const stream = localRef.current
    // Ignore a re-tap while a toggle is mid-flight (getUserMedia is async — two
    // overlapping toggles could leave the UI and the live stream out of sync).
    if (!mesh || !stream || togglingCamRef.current) return
    togglingCamRef.current = true
    const turningOn = !camRef.current
    try {
      const self = selfStreamRef.current
      const placeholder = placeholderRef.current
      if (turningOn) {
        // Turning the camera ON uses the FRONT/selfie cam by default — UNLESS an explicit facing is
        // passed (e.g. the pre-join carried a rear selection into the call). The default matters: a
        // prior flip-to-rear left facingRef on 'environment', so re-enabling the camera (incl. the
        // bottom-bar flip button when it was off) must not surprise-reopen the REAR camera. "phones
        // never surprise with the rear camera." Flip after, on purpose, to go rear.
        const want: CamFacing = facing ?? 'user'
        facingRef.current = want
        setCamFacing(want)
        // A specific device (the pre-join's chosen camera, desktop) wins over facingMode; else front/rear.
        const video = deviceId ? { ...VIDEO, deviceId: { exact: deviceId } } : videoConstraints(facingRef.current)
        // Acquire ONLY the camera — the mic track (and its permission) stays put.
        const cam = await navigator.mediaDevices.getUserMedia({ video })
        const camTrack = cam.getVideoTracks()[0]
        if (!camTrack) throw new Error('no camera track')
        // Permission just unlocked real ICE candidates (iOS) — re-establish the
        // data link if it hasn't connected yet.
        roomRef.current?.reconnect?.()
        // Now that permission is granted, learn whether a second camera exists.
        navigator.mediaDevices
          .enumerateDevices()
          .then((ds) => setCanFlip(ds.filter((d) => d.kind === 'videoinput').length > 1))
          .catch(() => {})
        // Silent swap on every live connection — no re-dial/renegotiation.
        mesh.replaceVideoTrack(camTrack)
        // Future dials (new joiners) should carry the camera too.
        if (placeholder) stream.removeTrack(placeholder)
        stream.addTrack(camTrack)
        // Self-preview shows the live track directly (mirrored in the UI). Re-read
        // the ref AFTER the await — toggleMic may have rebuilt selfStream while the
        // camera getUserMedia was in flight; extending the captured (now orphaned)
        // copy would leave your own tile black.
        const liveSelf = selfStreamRef.current
        liveSelf?.getVideoTracks().forEach((t) => liveSelf.removeTrack(t))
        liveSelf?.addTrack(camTrack)
      } else {
        // Swap back to the placeholder FIRST (no sender ever holds a dead track),
        // then stop and detach the camera.
        if (placeholder) mesh.replaceVideoTrack(placeholder)
        stream.getVideoTracks().forEach((t) => {
          if (t === placeholder) return
          t.stop()
          stream.removeTrack(t)
        })
        if (placeholder && !stream.getVideoTracks().includes(placeholder)) stream.addTrack(placeholder)
        self?.getVideoTracks().forEach((t) => self.removeTrack(t))
      }
      camRef.current = turningOn
      announceSelf(true)
      setCamOn(turningOn)
      setError(null)
    } catch {
      flashNotice(turningOn ? 'Camera access was blocked.' : 'Could not switch off the camera.')
    } finally {
      togglingCamRef.current = false
    }
  }, [announceSelf, flashNotice])

  /** Front ⇄ rear: a silent replaceTrack on every live connection — the same
   * no-churn path as the camera toggle (re-dials crash iOS WebKit natively). */
  const flipCam = useCallback(async () => {
    const mesh = meshRef.current
    const stream = localRef.current
    if (!mesh || !stream || !camRef.current || togglingCamRef.current) return
    togglingCamRef.current = true
    const next: CamFacing = facingRef.current === 'user' ? 'environment' : 'user'
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(next) })
      const newTrack = cam.getVideoTracks()[0]
      if (!newTrack) throw new Error('no camera track')
      mesh.replaceVideoTrack(newTrack)
      const placeholder = placeholderRef.current
      stream.getVideoTracks().forEach((t) => {
        if (t === placeholder) return
        t.stop()
        stream.removeTrack(t)
      })
      stream.addTrack(newTrack)
      const self = selfStreamRef.current
      self?.getVideoTracks().forEach((t) => self.removeTrack(t))
      self?.addTrack(newTrack)
      facingRef.current = next
      setCamFacing(next)
      setError(null)
    } catch {
      flashNotice('Could not switch cameras.')
    } finally {
      togglingCamRef.current = false
    }
  }, [flashNotice])

  // (The OS / car media-control wiring lives in the Widget now — it needs the app-level leaveCall to
  // exit cleanly, and on iOS a silent Now-Playing claim to make the car's controls route to us.)

  // Connection robustness on a flaky link (cellular in a moving car, Wi-Fi handoff): when the network
  // drops and comes back — or the tab returns to the foreground — kick the signaling link to reconnect
  // so the mesh recovers promptly instead of sitting in a half-dead state. Idempotent (reconnect is
  // already called liberally elsewhere); the TURN relay remains the fallback path when the direct one
  // is too lossy. Only while in a call.
  useEffect(() => {
    if (!inCall || typeof window === 'undefined') return
    const kick = () => roomRef.current?.reconnect?.()
    const onVisible = () => document.visibilityState === 'visible' && kick()
    window.addEventListener('online', kick)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', kick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [inCall])

  /** Return the video lane to off — swap the placeholder back in, stop the shared
   *  track. Mirrors the camera-off branch so no sender ever holds a dead track. */
  const stopShare = useCallback(() => {
    const mesh = meshRef.current
    const stream = localRef.current
    if (!mesh || !stream) return
    const placeholder = placeholderRef.current
    // Clear the share flag FIRST so the video lane (now back to the placeholder) is
    // restored uniformly to every peer — the gate stops withholding once we're not sharing.
    sharingRef.current = false
    if (placeholder) mesh.replaceVideoTrack(placeholder)
    stream.getVideoTracks().forEach((t) => {
      if (t === placeholder) return
      t.stop()
      stream.removeTrack(t)
    })
    if (placeholder && !stream.getVideoTracks().includes(placeholder)) stream.addTrack(placeholder)
    selfStreamRef.current?.getVideoTracks().forEach((t) => selfStreamRef.current?.removeTrack(t))
    setSharing(false)
    camRef.current = false
    setCamOn(false)
    announceSelf(true)
  }, [announceSelf])

  /** Publish an arbitrary video track (screen/tab capture) on the video lane — the
   *  same silent replaceTrack swap as the camera, so no re-dial/renegotiation. The
   *  extension feeds its chrome.tabCapture track straight in here. */
  const shareTrack = useCallback(
    async (track: MediaStreamTrack) => {
      const mesh = meshRef.current
      const stream = localRef.current
      if (!mesh || !stream || togglingCamRef.current) return false
      togglingCamRef.current = true
      try {
        // Mark the share active BEFORE publishing so the per-peer video gate withholds it
        // (substitutes the placeholder) from a peer lacking `see-screen` as it goes out —
        // the share never reaches an unentitled peer, not even for one frame.
        sharingRef.current = true
        mesh.replaceVideoTrack(track)
        // Drop the placeholder and any existing camera track; publish the shared one.
        const placeholder = placeholderRef.current
        stream.getVideoTracks().forEach((t) => {
          if (t === track) return
          if (t !== placeholder) t.stop()
          stream.removeTrack(t)
        })
        if (!stream.getVideoTracks().includes(track)) stream.addTrack(track)
        const self = selfStreamRef.current
        self?.getVideoTracks().forEach((t) => self.removeTrack(t))
        self?.addTrack(track)
        setSharing(true)
        camRef.current = true
        setCamOn(true)
        // "Stop sharing" from the browser's own bar ends the track → revert cleanly.
        track.addEventListener('ended', () => sharingRef.current && stopShare(), { once: true })
        announceSelf(true)
        setError(null)
        return true
      } catch {
        sharingRef.current = false // publish failed — we're not sharing after all
        flashNotice('Could not start the screen share.')
        return false
      } finally {
        togglingCamRef.current = false
      }
    },
    [announceSelf, stopShare, flashNotice],
  )

  /** Publish a custom outgoing AUDIO track to the mesh (e.g. a synthesized song) — peers hear it
   *  immediately. Pass null to restore the silent placeholder (back to emitting nothing). Doesn't
   *  touch the mic/unmute UI state — for a headless agent that joined muted and wants to "speak". */
  const publishAudioTrack = useCallback((track: MediaStreamTrack | null) => {
    const mesh = meshRef.current
    if (!mesh) return
    if (track) {
      mesh.replaceAudioTrack(track)
    } else {
      const ph = placeholderAudioRef.current || createPlaceholderAudioTrack()
      if (ph) {
        placeholderAudioRef.current = ph
        mesh.replaceAudioTrack(ph)
      }
    }
  }, [])

  /** Pick a screen/tab/window via the browser and share it (no extension needed). */
  const shareScreen = useCallback(async () => {
    try {
      // Ask the browser to FOCUS the captured tab/window after the share starts, via a CaptureController
      // — otherwise sharing a tab leaves you sitting on the call tab, not the thing you're presenting
      // (a web page can't switch tabs itself; this is the only sanctioned way). Best-effort: the type
      // isn't in lib.dom everywhere, and setFocusBehavior must be called right after the capture begins.
      const Ctl = (window as unknown as { CaptureController?: new () => { setFocusBehavior?: (b: string) => void } }).CaptureController
      const controller = Ctl ? new Ctl() : undefined
      const ds = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false, controller } as DisplayMediaStreamOptions)
      try {
        controller?.setFocusBehavior?.('focus-captured-surface')
      } catch {
        /* focus control unsupported / too late — the share still works */
      }
      const track = ds.getVideoTracks()[0]
      if (!track) return false
      return await shareTrack(track)
    } catch {
      flashNotice('Screen share was blocked or cancelled.')
      return false
    }
  }, [shareTrack, flashNotice])

  const setAvatar = useCallback(
    (next: string) => {
      avatarRef.current = next
      setAvatarState(next)
      try {
        localStorage.setItem(AVATAR_KEY, next)
      } catch {
        /* ignore */
      }
      // Rebroadcast so the room sees the change immediately (only meaningful in a call).
      if (meshRef.current) announceSelf(true)
    },
    [announceSelf],
  )

  const setMeta = useCallback(
    (next: Record<string, unknown>) => {
      metaRef.current = next
      setMetaState(next)
      // Rebroadcast so the roster carries the new metadata (only meaningful in a call).
      if (meshRef.current) announceSelf(true)
    },
    [announceSelf],
  )

  const participants = useMemo<CallParticipant[]>(() => {
    const others = roster
      .filter((m) => m.id !== selfVoiceId)
      .map((m) => {
        const { engine, features, appMeta } = readEngineMeta(m.meta)
        return {
          id: m.id,
          name: m.name,
          cam: m.cam,
          avatar: m.avatar ?? '',
          stream: remote.get(m.id) ?? null,
          isSelf: false,
          meta: appMeta,
          engine,
          features,
        }
      })
    if (inCall && selfVoiceId) {
      // Your own tile carries your actual name (like the original app) — 'You' only as a
      // fallback when none was given.
      return [
        {
          id: selfVoiceId,
          name: name.trim() || 'You',
          cam: camOn,
          avatar,
          stream: selfStream,
          isSelf: true,
          mirror: camFacing === 'user' && !sharing,
          sharing,
          meta,
          engine: APP_VERSION,
          features: ENGINE_FEATURES,
        },
        ...others,
      ]
    }
    return others
  }, [roster, remote, inCall, camOn, avatar, selfStream, selfVoiceId, name, camFacing, sharing, meta])

  return {
    ready: !!room,
    inCall,
    participants,
    rosterCount: roster.length,
    micOn,
    camOn,
    avatar,
    error,
    notice,
    retired,
    join,
    leave,
    toggleMic,
    releaseMutedMic,
    engageMic,
    setKeepMicCaptured,
    toggleCam,
    flipCam,
    canFlip,
    speakerId,
    setSpeaker,
    sharing,
    shareScreen,
    shareTrack,
    stopShare,
    publishAudioTrack,
    setAvatar,
    setMeta,
    chat,
    sendChat,
    sendApp,
    sendAppTo,
    onApp,
    sendPay,
    onPay,
    sendInk,
    onInk,
    registerSchema,
    getSchemas,
    onSchema,
    getSafetyCode,
    getConnectionInfo,
    identityEnabled: !!idConfig || !!(acceptProviders && acceptProviders.length),
    selfIdentity,
    signInIdentity,
    identityNonce,
    provideIdentityToken,
    provideAgentKey,
    provideAgentCredit,
    claimHost,
    claimHostByName,
    declareHost,
    hostModerate,
    isVerifiedHost: !!selfVoiceId && room?.hostId?.() === selfVoiceId,
    getIdentity,
    rosterGate,
    getCapabilityGrant,
    setCapabilityGrant,
    getAgentAudit,
  }
}
