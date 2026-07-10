import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { brand } from '../brand'
import { useIdleNudge } from '../react/useIdleNudge'
import { pageableViews, VIEW_ORDER, VIEW_LABEL, type CallView } from './pageableViews'
import { joinRoom, type RoomStatus } from '../core/room'
import { sanitizeGrant, type Grant } from '../core/capabilities'
import { AgentConsent } from './AgentConsent'
import { AgentActionsBar } from './AgentActionsBar'
import { HostMenuBar } from './HostMenuBar'
import { AgentsMenu } from './AgentsMenu'
import { AgentBubbleLayer } from './AgentBubbleLayer'
import { InvitePanel } from './InvitePanel'
import { AvatarPicker } from './AvatarPicker'
import { ClaimAdminDialog } from './ClaimAdminDialog'
import { ChatComposer } from './ChatComposer'
import { useAgentPresence } from './useAgentPresence'
import { usePanelDrag, MIN_H } from './usePanelDrag'
import { useAutoHideChrome } from './useAutoHideChrome'
import { usePayRequests } from './usePayRequests'
import { usePreJoinMedia } from './usePreJoinMedia'
import { useStageWidgets } from './useStageWidgets'
import { WidgetBubble } from './WidgetBubble'
import { widgetNodeToPng } from './snapshotNode'
import { StagedWidget } from './StagedWidget'
import { StageVideoBar } from './StageVideoBar'
import { StageLocalVideo } from './StageLocalVideo'
import { localMediaSrc } from '../react/stageMedia'
import { AgentWarn } from './AgentWarn'
import { ChatMessage } from './ChatMessage'
import { PreJoinDevices } from './PreJoinDevices'
import { PreviewTile } from './PreviewTile'
import { ViewSwitcher } from './ViewSwitcher'
import { WindowControls } from './WindowControls'
import { ShareControls } from './ShareControls'
import { MediaControls } from './MediaControls'
import { SecondaryControls } from './SecondaryControls'
import { HostToolsMenu } from './HostToolsMenu'
import { VerifyPanel } from './VerifyPanel'
import { MicIcon, MicOffIcon, ChatIcon, MaximizeIcon, MinimizeIcon, CloseIcon, PeopleIcon, StopIcon } from './icons'
import { normalizeRoom } from '../core/transport'
import { loadBans, saveBans } from '../react/bans'
import { joinLanRoom, type LanRoom } from '../core/lanRoom'
import { hasGalaxy } from '../core/galaxyHub'
import { lanMedia, peerJsMedia, previewMedia, forceRelay } from '../core/callMedia'
import { isIOS } from '../core/media'
import { clearInCall, markInCall, shouldRejoin } from '../core/rejoinIntent'
import { getDiag } from '../core/diag'
import { getIceServers, warmIceServers } from '../core/iceConfig'
import { chooseSignal } from '../core/signalConfig'
import type { AuditEntry, CallRoom, ChatItem, FileMessage, ImageMessage, SchemaInfo } from '../react/useCall'
import { textToBytes } from '../core/contentXfer'
import type { AppMessage } from '../core/protocol'
import { normalizePayLink } from '../core/payLink'
import { stageImageKey } from '../react/ink'
import { Tile, EmojiAvatar } from '../react/CallSurface'
import { QrBox } from '../react/QrBox'
import { StageInk } from '../react/StageInk'
import { pickPresenter, presentAtOf } from '../react/stage'
import { useActiveSpeakers } from '../react/useActiveSpeakers'
import { useStageZoom } from '../react/useStageZoom'
import { useVideoPip, type PipFocus } from '../react/useVideoPip'
import { useCall } from '../react/useCall'
import { useSafety } from '../react/safety'
import { useIdentity } from '../react/useIdentity'
import { useConnections } from '../react/connection'
import {
  discoveryIssuerFor,
  identityAllowed,
  issuersFor,
  verifyPeerMulti,
  type AcceptedProvider,
  type AgentCreditConfig,
  type IdentityConfig,
} from '../core/identity'
import { generatePinnedCert } from '../core/identityCert'
import { createJwksResolver, fetchJwks } from '../core/oidcJwks'
import type { Jwk } from '../core/oidcVerify'
import { verifyCreditCredential } from '../core/creditVerify'
import { gateVerifierFor } from '../core/joinGateRuntime'
import { importInvitePublicKey } from '../core/inviteToken'
import { verifyManifest, humansOpenForManifest, type AgentEntry } from '../core/roomManifest'
import { verifyAgentAssertion } from '../core/agentKey'
import { canonicalFingerprint } from '../core/oidcBinding'
import { splitRoomHash, type GateDescriptor } from '../core/joinGateLink'
import { safeReturnUrl } from './returnUrl'
import { roomKeyFromHash, memCommit, isAgentParticipant } from '../core/memKey'
import { type Claim } from '../core/claim'
import { isButtonTarget, isTypingTarget, shortcutFor } from '../react/shortcuts'
import {
  useHostLobby,
  useLobby,
  type HostLobbyRoom,
  type Knock,
  type LobbyOverlay,
  type LobbyRoom,
} from '../react/useLobby'

export type { Knock } from '../react/useLobby'
/** Our own knock state as a joiner: held, refused, or nothing in play. */
export type LobbyJoinerStatus = LobbyOverlay | null

const OP_KEY = 'kibitz.widget.op'

// Call layout, persisted per browser. SPEAKER (one big active-speaker tile + a filmstrip, the default —
// like Zoom's speaker view), GALLERY (an even grid of everyone), and CAR — a driving-safe view that
// hides ALL video and shows just who's talking + a big mute button. Laid out left→right as
// CAR · SPEAKER · GALLERY, so the default Speaker sits in the MIDDLE (swipe right → Car, left → Gallery;
// Gallery only exists in a group). A presenter forces the stage in the tile views, but never Car.
const VIEW_KEY = 'kibitz.view'
const loadView = (): CallView => {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'gallery' || v === 'car' || v === 'strip' ? v : 'speaker' // default: speaker
  } catch {
    return 'speaker'
  }
}
const saveView = (v: CallView): void => {
  try {
    localStorage.setItem(VIEW_KEY, v)
  } catch {
    /* storage unavailable */
  }
}

// A 1-second silent WAV (built once) used to claim the iOS "Now Playing" media session during a call.
// A live WebRTC call doesn't register as media playback on iOS, so the OS never lists the page in Now
// Playing and a car/Bluetooth head unit's transport controls (pause/stop) never reach our handlers.
// Playing a real (silent, looped) audio element claims the session so those controls route to us.
let silentClipUrl: string | null = null
function getSilentClipUrl(): string | null {
  if (silentClipUrl) return silentClipUrl
  try {
    const rate = 8000
    const n = rate // 1s of 8-bit mono
    const buf = new ArrayBuffer(44 + n)
    const v = new DataView(buf)
    const w = (off: number, str: string) => {
      for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i))
    }
    w(0, 'RIFF')
    v.setUint32(4, 36 + n, true)
    w(8, 'WAVE')
    w(12, 'fmt ')
    v.setUint32(16, 16, true)
    v.setUint16(20, 1, true) // PCM
    v.setUint16(22, 1, true) // mono
    v.setUint32(24, rate, true)
    v.setUint32(28, rate, true)
    v.setUint16(32, 1, true)
    v.setUint16(34, 8, true) // 8-bit
    w(36, 'data')
    v.setUint32(40, n, true)
    for (let i = 0; i < n; i++) v.setUint8(44 + i, 128) // unsigned-8 silence
    silentClipUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
    return silentClipUrl
  } catch {
    return null
  }
}

// Audio-OUTPUT picking (which speaker) needs HTMLMediaElement.setSinkId — desktop Chromium only. Guard
// for SSR/prerender where HTMLMediaElement is undefined. Used to gate the lobby's speaker dropdown.

// A hidden audio sink for an UNSEEN kibitzer (no tile in the grid). Honors speaker-off (`muted`/deaf):
// el.muted is set IMPERATIVELY (React's `muted` prop is unreliable on media elements) and reactively
// when deaf flips — without this the agent's voice kept playing even with the speaker turned off.
function KibitzerSink({ stream, muted, sinkId, local }: { stream: MediaStream; muted: boolean; sinkId?: string; local?: boolean }) {
  const ref = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && el.srcObject !== stream) el.srcObject = stream
  }, [stream])
  useEffect(() => {
    if (ref.current) ref.current.muted = muted
    // Android ignores el.muted for WebRTC audio → also gate the received tracks (see useStream). Skip when
    // `local` (a SELF share-audio stream): disabling those tracks would cut the audio we're sharing to everyone.
    if (!local) stream.getAudioTracks().forEach((t) => { t.enabled = !muted })
  }, [muted, stream, local])
  useEffect(() => {
    const el = ref.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null
    if (el && typeof el.setSinkId === 'function') el.setSinkId(sinkId || '').catch(() => {})
  }, [sinkId])
  return <audio ref={ref} autoPlay />
}

// Shared audio-unlock signal. iOS/mobile block audio AUTOPLAY until a user gesture actually plays audio, so a muted
// auto-join leaves a remote (e.g. AI-agent) voice paused with no cue. A resumed AudioContext (state 'running') is the
// cross-browser proof that audio is unlocked. `unlockAudioCtx()` resumes it inside a real tap; it lives on `window` so
// an EMBEDDING page (the zero-tap "path B") can resume the SAME context in its own entry gesture — then the auto-join
// gate below sees 'running' and skips itself. Best-effort: any failure just leaves the gate showing (one extra tap).
type AudioCtxWindow = { __kbzAudioCtx?: AudioContext; AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
function audioUnlocked(): boolean {
  try {
    return (window as unknown as AudioCtxWindow).__kbzAudioCtx?.state === 'running'
  } catch {
    return false
  }
}
function unlockAudioCtx(): void {
  try {
    const w = window as unknown as AudioCtxWindow
    const AC = w.AudioContext || w.webkitAudioContext
    if (!w.__kbzAudioCtx && AC) w.__kbzAudioCtx = new AC()
    void w.__kbzAudioCtx?.resume()
  } catch {
    /* ignore — the gate stays up; the user taps once more */
  }
}


/** A call participant, ready for the host app to render — the composable-engine
 *  surface behind `Kibitz.mount().getParticipants()` / `on('participants')`. */
export interface Participant {
  id: string
  isSelf: boolean
  name: string
  avatar: string
  camOn: boolean
  speaking: boolean
  stream: MediaStream | null
  meta: Record<string, unknown>
  mirror?: boolean
  /** Self only: the video lane is a screen/tab share, not the camera. */
  sharing?: boolean
  /** 'host' for the room authority, else 'guest'. */
  role: 'host' | 'guest'
}

export interface CallSnapshot {
  participants: Participant[]
  inCall: boolean
  micOn: boolean
  camOn: boolean
  /** iOS released the mic/camera on a background; a silent re-grab needs a tap (see useCall). */
  needsMediaGesture: boolean
  sharing: boolean
  // Lobby (knock-to-admit) — see useLobby / the host bar.
  /** We're the room authority — the only role that can gate entry. */
  isHost: boolean
  /** The gate is on: joiners are held until admitted (host-meaningful). */
  lobbyOn: boolean
  /** The room is locked — sealed to new members (host-meaningful). */
  locked: boolean
  /** The host's live waiting list (empty unless we're the gating host). */
  knocks: Knock[]
  /** The room's ephemeral chat scrollback (capped; nothing stored). Lets a headless
   *  controller read room chat and diff for new incoming lines (the 'chat' event). */
  chat: readonly ChatItem[]
  /** Our OWN knock state as a joiner: held, refused, or nothing in play. */
  lobbyStatus: LobbyJoinerStatus
  // Identity (verified rooms) — all inert unless verifyIdentity/a verified roster is in play.
  /** Verified identity is configured for this room (a sign-in is possible/expected). */
  identityEnabled: boolean
  /** Our own verified email once we've signed in (null until then). */
  selfEmail: string | null
  /** Verified-roster (docs §7) live state — for hosting a verified room headlessly:
   *  whether content may flow yet, and whether an off-roster peer is present. */
  rosterActive: boolean
  rosterCanShare: boolean
  rosterCompromised: boolean
}

export interface CallControls {
  join(opts?: { mic?: boolean; cam?: boolean }): Promise<boolean>
  leave(): void
  toggleMic(): void
  toggleCam(): Promise<void>
  resumeMedia(): void
  shareScreen(): Promise<boolean>
  shareTrack(track: MediaStreamTrack): Promise<boolean>
  stopShare(): void
  /** Publish a custom outgoing audio track (e.g. a synthesized song); null restores silence. */
  publishAudioTrack(track: MediaStreamTrack | null): void
  /** Publish a custom outgoing video track (e.g. an agent's image on a canvas) → your tile; null → avatar. */
  publishVideoTrack(track: MediaStreamTrack | null): void
  setName(name: string): void
  setAvatar(avatar: string): void
  setMeta(meta: Record<string, unknown>): void
  /** Room-state ledger transport (docs/room-state-ledger.md): broadcast an opaque ledger message to all
   *  peers + subscribe to inbound ones. The summon banner binds a RoomLedger/LedgerSync onto this. */
  broadcastLedger(m: unknown): void
  onLedger(cb: (from: string, m: unknown) => void): () => void
  /** Fetch content-addressed bytes by hash (unified room sync); local store else a holding peer. */
  fetchBlob(hash: string): Promise<Uint8Array | null>
  /** Post a line to the room's built-in chat (the same chat humans see). With `to`
   *  (a participant id) it's a private/directed message to just that peer. Lets a
   *  headless agent talk in the room without its own UI. */
  sendChat(text: string, to?: string): void
  /** Seed the room's PRIOR PUBLIC transcript (cross-call persistence) — see useCall.seedChatHistory. Each line
   *  carries its ORIGINAL author; re-broadcast to late joiners on every roster change, deduped by mid. DISPLAY-ONLY
   *  + UNVERIFIED attribution (never a verified badge). */
  seedChatHistory: ReturnType<typeof useCall>['seedChatHistory']
  /** Export/import the durable chat LEDGER snapshot (docs/chat-ledger.md) — the persisting agent's Layer-2 path. */
  exportLedger: ReturnType<typeof useCall>['exportLedger']
  ledgerVersion: ReturnType<typeof useCall>['ledgerVersion']
  importLedger: ReturnType<typeof useCall>['importLedger']
  /** Subscribe to pen/ink strokes on the shared stage (so a headless agent can see annotations). */
  onInk: ReturnType<typeof useCall>['onInk']
  sendInk: ReturnType<typeof useCall>['sendInk']
  /** Post / observe a BOUNDED interactive widget (e.g. a map an agent shows) + its shared interactions.
   *  Lets a headless agent show a pressable map and react to the pins peers drop on it. */
  sendWidget: ReturnType<typeof useCall>['sendWidget']
  removeWidget: ReturnType<typeof useCall>['removeWidget']
  onWidget: ReturnType<typeof useCall>['onWidget']
  sendWidgetEvent: ReturnType<typeof useCall>['sendWidgetEvent']
  onWidgetEvent: ReturnType<typeof useCall>['onWidgetEvent']
  /** Send a File/Blob (image or any file) into the room over the chunked content transfer — rendered
   *  inline for an image, offered as a download otherwise. With `to`, private to that one peer. */
  sendFile(file: File | Blob, to?: string): void
  /** Send an inline base64 IMAGE (k:'img') — withheld from peers NOT granted read-media and surfaced to
   *  onImage, so a vision-granted agent receives the bytes. The headless sendImage uses this for small images
   *  and falls back to sendFile for large ones. */
  sendImage(img: { mime: string; data: string; name?: string; w?: number; h?: number }, to?: string): void
  /** PRESS Stage on agent-loaded media via the SAME human presentMedia path (off-stage + doodle + viewer ctl
   *  inherited), not a parallel agent lane. {mime,data:base64}; video/audio plays, else an image. */
  stageMedia(p: { mime?: string; data?: string } | null): void
  // Lobby controls (the gating host uses setLobby/admit/deny; a joiner uses knock).
  /** Turn the admit-gate on/off. No-op unless we're the host. */
  setLobby(on: boolean): void
  /** Let a waiting knocker in / refuse them (by their knock id). Host only. */
  admit(id: string): void
  deny(id: string): void
  /** Remove a call member by their participant id. Host only; the removed peer is
   *  told to leave and blocked from rejoining this room. */
  remove(id: string): void
  /** Lock / unlock the room (host only) — sealed to new members. */
  setLocked(on: boolean): void
  /** Reset the room (host only) — clear everyone's ephemeral chat. */
  resetRoom(): void
  /** Introduce yourself to the host's lobby before joining (name + emoji avatar). */
  knock(name: string, avatar: string): void
  /** Verified rooms: render the provider's sign-in into `container` (Google button, or the
   *  email→code form for `method:'email'`) and, on success, broadcast the cert-bound token.
   *  Resolves true if signed in. Inert unless verified identity is configured. */
  signInIdentity(container: HTMLElement, method?: 'google' | 'email'): Promise<boolean>
  /** The cert-bound nonce an EXTERNAL sign-in surface must echo (for embedders running sign-in
   *  on another origin — e.g. the extension's kibitz.chat popup). Pair with `provideIdentityToken`. */
  identityNonce(): Promise<string | null>
  /** Adopt a cert-bound token minted out-of-page (signed against `identityNonce()`). */
  provideIdentityToken(jwt: string): Promise<boolean>
  /** Mount AS an AI agent: adopt the agent's own private signing key (a JWK) so it presents a
   *  cert-bound key assertion the authority checks against the room's allow-list. True if adopted. */
  provideAgentKey(privateKeyJwk: JsonWebKey): Promise<boolean>
  /** Mount AS a paid agent: forward a network-access credit credential so it rides our announce; a
   *  credit-gated authority verifies it and keeps admitting us. Call ~every minute with a fresh one. */
  provideAgentCredit(credential: string): void
  /** A participant's effective capability grant (what it may perceive/act). Host-side consent UI. */
  getCapabilityGrant(id: string): Grant
  /** Set (null clears) a participant's capability override; the engine enforces it. Host only. */
  setCapabilityGrant(id: string, grant: Grant | null): void
  /** Recent local capability-audit events for a participant (blocked acts + grant changes). */
  getAgentAudit(id: string): readonly AuditEntry[]
}

/** The peer-to-peer app-message channel the bridge wires up to `Kibitz.mount()`.
 *  Built from useCall — content rides the data mesh now, not the room/authority. */
export interface AppChannel {
  sendApp(data: unknown): void
  onApp(cb: (m: AppMessage) => void): void
  /** Subscribe to images shared by peers — a vision-capable agent's perception input. */
  onImage(cb: (m: ImageMessage) => void): void
  /** Subscribe to non-image files shared by peers (e.g. a PDF) — a file-reading agent's perception input. */
  onFile(cb: (m: FileMessage) => void): void
  sendAppTo(to: string, data: unknown): void
  /** Publish / discover the schema of app messages, so an agent can self-describe (and read). */
  registerSchema(name: string, version: string, schema: unknown): void
  getSchemas(): readonly SchemaInfo[]
  onSchema(cb: (s: SchemaInfo) => void): () => void
}

/**
 * Lets `Kibitz.mount()` reach into the live call: the opaque app-message channel
 * (co-browse) PLUS the call controller — participants, state, controls, events.
 * The loader hands the Widget a bridge; the Widget wires the call's app channel and
 * pushes call snapshots/controls into it, so the host page's
 * broadcast/onMessage/getParticipants/controls/on(...) all ride the real call.
 */
export interface WidgetBridge {
  attach(app: AppChannel): void
  detach(): void
  setControls(c: CallControls | null): void
  pushSnapshot(s: CallSnapshot): void
}

function loadTransparency(): number {
  try {
    const raw = localStorage.getItem(OP_KEY)
    // Only honour an actually-stored value — `Number(null)` is 0, which would
    // otherwise pass the range check and shadow the default (the bug).
    if (raw !== null && raw !== '') {
      const v = Number(raw)
      if (Number.isFinite(v) && v >= 0 && v <= 0.92) return v
    }
  } catch {
    /* ignore */
  }
  return 0.2 // default: 20% transparent (op 0.8) — a subtle ghost, still readable
}

/**
 * The floating Kibitz widget — the original call panel, verbatim. One header row
 * carries everything (mic, camera, avatar picker, ▭/▦ layout, ◐ ghost,
 * minimize, leave); the avatar row and the transparency row open beneath it.
 * Ghost mode turns the tile area translucent AND click-through; speakers pop
 * to full opacity. Draggable; position and transparency remembered.
 */
interface DocumentPiP {
  requestWindow(opts?: { width?: number; height?: number }): Promise<Window>
}

/** Build the authority gate's verifier: check a joiner's cert-bound token (signature
 *  vs the provider's published JWKS + binding to the cert WE handshook with + allowed
 *  domains). Fail-closed — any error (e.g. JWKS unreachable offline) → not allowed. One
 *  JWKS resolver (cached) per room. Salted by room so a token can't cross rooms. */
function makeGateVerify(
  cfg: IdentityConfig,
  salt: string,
  liveEmails: () => readonly string[],
  liveDomains: () => readonly string[] = () => [],
  liveProviders: () => readonly AcceptedProvider[] = () => [],
) {
  return async (jwt: string | undefined, remoteFp: string | null): Promise<{ ok: boolean; reason?: string }> => {
    if (!jwt || !remoteFp) return { ok: false, reason: 'no token / cert' }
    if (jwt.length > 8192) return { ok: false, reason: 'token too large' } // DoS guard — a Google ID token is ~1KB
    try {
      // Route the token to its provider (Google / email-code) by issuer — so the authority admits
      // ANY accepted method, not just Google. Then check it's actually on the room's allow-lists.
      const r = await verifyPeerMulti({
        jwt,
        remoteFp,
        providers: liveProviders(),
        now: Math.floor(Date.now() / 1000),
        salt,
        leewaySec: 30, // tighter than the 60s default — the cert binding already blocks replay
        maxAgeSec: 3600, // refuse a token older than its ~1h provider lifetime (defence in depth)
      })
      if (!r.ok) return r
      // Read the allow-lists LIVE: exact emails (signin/mail) + allowed domains (oidc slots + config).
      const domains = [...(cfg.allowedDomains ?? []), ...liveDomains()]
      if (!identityAllowed(r.identity, domains, liveEmails())) return { ok: false, reason: 'identity not on the guest list' }
      return { ok: true }
    } catch {
      return { ok: false, reason: 'verification unavailable' }
    }
  }
}

/** Compose the AI-agent admission branch onto a human verifier. When a joiner presents an
 *  `agentAssertion` (instead of a human token), admit it iff its key is on the room's committed
 *  `agentKeys` and the assertion is cert-bound to this connection + room (verifyAgentAssertion);
 *  otherwise fall through to the human verify. `liveAgentKeys` is read live so a late-verified
 *  manifest still gates correctly. A room with no agent keys simply admits no agents. */
function withAgentGate(
  humanVerify: (jwt: string | undefined, fp: string | null) => Promise<{ ok: boolean; reason?: string }>,
  roomKey: string,
  liveAgentKeys: () => readonly AgentEntry[] | null,
  // Record the VERIFIED key's capability policy, bound to this connection's fingerprint, so the
  // authority can apply it to the agent's grant LATER (correlated by the same cert fp the safety
  // layer reads). The caps come from the key the agent actually proved — never a self-asserted
  // meta — so an agent can't escalate by claiming another key's grant.
  recordCaps?: (fp: string, caps: Grant) => void,
  // Optional network-access credit check. When require() is true, a DECLARED agent (presenting a key
  // assertion and/or a credit credential) must ALSO present a VALID credit credential. Returns the
  // credential's creditExp so the authority can reap a lapsed agent. Absent ⇒ dormant (today exactly).
  credit?: {
    require: () => boolean
    verify: (agentCredit: string | undefined, room: string) => Promise<{ ok: boolean; reason?: string; creditExp?: number }>
  },
) {
  return async (
    jwt: string | undefined,
    fp: string | null,
    agentAssertion?: string,
    agentCredit?: string,
  ): Promise<{ ok: boolean; reason?: string; creditExp?: number }> => {
    const requireCredit = !!credit?.require()
    if (agentAssertion) {
      const keys = liveAgentKeys()
      if (!keys || keys.length === 0) return { ok: false, reason: 'this room admits no agents' }
      const r = await verifyAgentAssertion(agentAssertion, {
        allowedKeys: keys.map((e) => e.key),
        room: roomKey,
        remoteFp: fp ?? '',
        now: Math.floor(Date.now() / 1000),
      })
      if (!r.ok) return { ok: false, reason: r.reason }
      const entry = keys.find((e) => e.key === r.key)
      if (recordCaps && fp && entry?.caps) recordCaps(canonicalFingerprint(fp), sanitizeGrant(entry.caps))
      // A manifest-authorized agent still PAYS if the room requires credits.
      if (requireCredit) {
        if (!agentCredit) return { ok: false, reason: 'agent credit required' }
        return credit!.verify(agentCredit, roomKey) // room-scoped so a captured credit can't cross rooms
      }
      return { ok: true }
    }
    // No key assertion: a credit-only declared agent (credit-gated room with no manifest).
    if (requireCredit && agentCredit) return credit!.verify(agentCredit, roomKey)
    // Otherwise a human (or an unauthenticated peer) — the human path decides.
    return humanVerify(jwt, fp)
  }
}

// Cached fetch of a credit issuer's JWKS (1h TTL), module-level so it's shared across rooms in a tab.
// Verification runs in the AUTHORITY's browser, so this is a client-side fetch; fail-closed (a throw
// ⇒ the credit verify finds no key ⇒ the agent isn't admitted; humans are never affected).
const creditJwksCache = new Map<string, { keys: Jwk[]; at: number }>()
async function resolveCreditJwks(cfg: AgentCreditConfig, nowMs = Date.now()): Promise<Jwk[]> {
  if (cfg.jwks && cfg.jwks.length) return cfg.jwks // pre-pinned (offline / self-host / tests)
  if (!cfg.jwksUri) return []
  const hit = creditJwksCache.get(cfg.jwksUri)
  if (hit && nowMs - hit.at < 3_600_000) return hit.keys
  const keys = await fetchJwks(cfg.jwksUri)
  creditJwksCache.set(cfg.jwksUri, { keys, at: nowMs })
  return keys
}

/** Build the credit option for withAgentGate from an AgentCreditConfig, or undefined when dormant. */
function creditGateOption(cfg: AgentCreditConfig | undefined) {
  if (!cfg?.requireAgentCredits) return undefined
  return {
    require: () => true,
    verify: async (agentCredit: string | undefined, room: string): Promise<{ ok: boolean; reason?: string; creditExp?: number }> => {
      if (!agentCredit) return { ok: false, reason: 'agent credit required' }
      let jwks: Jwk[]
      try {
        jwks = await resolveCreditJwks(cfg)
      } catch {
        return { ok: false, reason: 'credit keys unavailable' } // fail-closed
      }
      // Map the verifier's `exp` → the `creditExp` the authority reap expects. Returning the raw result left
      // creditExp undefined, so a lapsed paying agent was never reaped (dead lapse-reap path). `room` scopes the
      // credit to THIS room so a captured credential can't be replayed into another credit-gated room.
      const r = await verifyCreditCredential(agentCredit, { jwks, issuer: cfg.issuer, now: Math.floor(Date.now() / 1000), kind: cfg.kind, room })
      return r.ok ? { ok: true, creditExp: r.exp } : { ok: false, reason: r.reason }
    },
  }
}

/** Pull an invite token out of whatever the guest pasted — a full invite URL (with `?gt=…`)
 *  or the raw token string. */
function tokenFromPaste(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    // `gt` may be in the query (legacy) or the fragment (`#room?gt=…`, the host-private new form).
    const gt = u.searchParams.get('gt') ?? splitRoomHash(u.hash).params.get('gt')
    if (gt) return gt
  } catch {
    /* not a URL — treat the whole thing as a raw token */
  }
  return s
}

export function Widget({
  room: roomName,
  defaultName,
  brandName = 'Kibitz',
  startOpen,
  autoJoin,
  fill,
  host,
  preview,
  headless,
  mutePlayback,
  identity,
  meta,
  verifyIdentity,
  agentCredits,
  joinGate,
  joinCredential,
  apiBase,
  menuOrigin,
  summonPath,
  summonApi,
  summonKey,
  relayOnly,
  offline: offlineProp,
  inviteLink,
  agentCall,
  notice,
  roomDesc,
  bridge,
  onExit,
}: {
  room: string
  defaultName?: string
  /** White-label product name shown in the call chrome (OS Now-Playing, pop-out title, tooltips). */
  brandName?: string
  startOpen?: boolean
  /** Skip the pre-join lobby: join automatically on load (muted, camera off). For an UPSTREAM step that already
   *  collected the name/consent (e.g. the witz gift flow). iOS lands in the call the same way — the mic opens on
   *  the first in-call unmute tap and the global pointerdown handler unlocks remote audio, so no lobby tap. */
  autoJoin?: boolean
  /** Dedicated room window (kibitz.chat's room page): fill the window, opaque, no
   *  ghost; on desktop, resize by dragging the edges. Embedders omit it. */
  fill?: boolean
  /** Dedicated room window only: leave the room and return "home" (the host wires this to
   *  navigate back to the landing). Renders a ← Home button in the header — the way OUT of a
   *  full-window room in an installed PWA, where there's no browser back button or address bar. */
  onExit?: () => void
  /** The shadow host element — movable into a Document PiP window (pop-out). */
  host?: HTMLElement
  /** Landing demo: render the real panel but never dial — local self-view only
   * (no room, no broker, no peers). See previewMedia / the preview room below. */
  preview?: boolean
  /** Render NO panel — the host draws its own tiles from the controller. The
   *  engine still runs and remote audio plays via hidden sinks. Connects the room
   *  immediately (no pill to open). */
  headless?: boolean
  /** Deaf spectator: don't play other participants' audio out the speakers (the hidden sinks
   *  render muted). For a second in-page engine — e.g. an AI kibitzer — that would otherwise
   *  echo the local user's mic. */
  mutePlayback?: boolean
  /** Stable host identity (per-user/seat/session) → deterministic reconnect dedupe. */
  identity?: string
  /** Initial opaque per-participant metadata (seat, userId…) the host attaches. */
  meta?: Record<string, unknown>
  /** Opt-in verified identity (L3) — a provider + client_id; omit to stay account-free. */
  verifyIdentity?: IdentityConfig
  /** Opt-in: require DECLARED agents to present a valid network-access credit credential (verified
   *  against the issuer's JWKS). Default OFF/dormant — humans and existing agent-key rooms are
   *  unaffected when omitted. See the network-access funding model. */
  agentCredits?: AgentCreditConfig
  /** Link-driven join gate ("link is everything"): a descriptor decoded from the invite
   *  link (signed invites / name list). The authority rebuilds the check from it alone. */
  joinGate?: GateDescriptor
  /** This peer's OWN credential for `joinGate` (e.g. their signed invite token from `?gt=`),
   *  auto-presented at the door. */
  joinCredential?: string
  /** Absolute base URL of the Kibitz email-code backend (issuer + /api/email/jwks), for embedders
   *  whose OWN origin isn't where the backend lives — e.g. the extension on chrome-extension://,
   *  which must verify email-method peers against `https://kibitz.chat`. Defaults to this origin. */
  apiBase?: string
  /** Origin allowed to host an in-call menu (the host-menu seam). An agent ENABLES a menu via its
   *  agent-actions manifest, but Kibitz only ever frames it on THIS build-fixed origin — never a URL the
   *  agent picks (anti-phishing). Omit → host menus disabled. Set from brand.menuOrigin. */
  menuOrigin?: string
  /** Optional path for an in-call "Summon agent" button (e.g. '/agent'). Used ONLY by a brand that did NOT
   *  wire one-tap (`summonApi` unset): opening it appends `?room=<currentRoomId>` in a new tab. When
   *  `summonApi` IS set, this is never opened. Set from brand.summonPath; the generic product has none. */
  summonPath?: string
  /** One-tap summon endpoint (brand.summonApi) + the room link's summon key (`summonKey`). When `summonApi`
   *  is set the Summon button is one-tap ONLY — it POSTs `{summonKey}` here (re-launch from stored params)
   *  and NEVER opens a page; the banner only shows when a `summonKey` is present, and a failure just retries. */
  summonApi?: string
  summonKey?: string
  /** Privacy (Layer 3): force media/data through TURN so peers never learn your IP (only the
   *  relay does). Fail-closed — no reachable TURN ⇒ the call can't connect rather than leak. */
  relayOnly?: boolean
  /** Offline (LAN) transport for THIS room: true → join via the relay (lanRoom), false → online (broker).
   *  Lets the host pick per-room, instead of forcing LAN whenever a relay is merely present. Unset →
   *  fall back to "a relay is configured" (hasGalaxy) — the back-compat default for embedders. */
  offline?: boolean
  /** Host-supplied builder for the "Copy invite link" button — lets the host emit a custom share URL
   *  (e.g. kibitz.chat's WhatsApp-friendly /j/room link, with a freshly-minted TURN grant) instead of
   *  the raw page URL. Omit (embedders) → copies `location.href` as before. */
  inviteLink?: () => string | Promise<string>
  /** AI-assisted call → show Kibitz's own generic "may be recorded / sent to third parties" pre-join
   *  warning (Part 1 of consent), worded for what the agent perceives: 'audio' (voice agent) or
   *  'audiovideo' (also sees your camera / shared screen). The specific details come from `notice`. */
  agentCall?: 'audio' | 'audiovideo'
  /** Optional SPECIFIC disclosure shown on the pre-join screen below the generic warning; joining =
   *  agreeing to it. Generic host-supplied text (e.g. an AI-agent transcription notice) — rendered
   *  verbatim, Kibitz stays agnostic about what it says. */
  notice?: string
  /** Friendly room description → shown as the pre-join title instead of the raw room code, when set. */
  roomDesc?: string
  /** Bridges the live call (app channel + controller) up to `Kibitz.mount()`. */
  bridge?: WidgetBridge
}) {
  // Were we in THIS call moments ago (a reload / iOS tab-kill / crash, not an explicit
  // Leave)? Read ONCE at mount — the intent is re-stamped while in-call, so a later
  // read would be stale. A fresh intent re-opens the panel and rejoins (see below).
  const wantRejoin = useState(() => !preview && !headless && shouldRejoin(roomName, Date.now()))[0]
  const [rejoinDismissed, setRejoinDismissed] = useState(false)
  const autoJoinedRef = useRef(false)
  const autoJoinFiredRef = useRef(false) // one-shot: the `autoJoin` prop's lobby-skip (distinct from the rejoin path)
  const [autoJoinFailed, setAutoJoinFailed] = useState(false) // auto-join couldn't proceed → reveal the real lobby
  const [needsGesture, setNeedsGesture] = useState(false) // autoJoin on a touch device with audio still locked → show a one-tap entry (the tap unlocks the agent's voice)
  const [open, setOpen] = useState(headless || (startOpen ?? false) || wantRejoin)
  // ?debug overlay: a per-session diagnostic, ON only when ?debug is in the CURRENT url. It no longer PERSISTS via
  // localStorage — that left it stuck "forced-on" on the host (which loads ?galaxy=… and had no way to opt back
  // out). We also clear any sticky flag left by older ?debug visits, so existing hosts drop the overlay.
  const debug = useState(() => {
    try {
      const on = new URLSearchParams(location.search).has('debug')
      if (!on) localStorage.removeItem('kbzdebug')
      return on
    } catch {
      return false
    }
  })[0]
  const [, bumpDebug] = useState(0)
  useEffect(() => {
    if (!debug) return
    const id = setInterval(() => bumpDebug((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [debug])
  // A first visit starts on Speaker (the solo tab) — NOT a stale persisted view (e.g. Car from a past
  // drive), so there's no Car→Speaker flash on join. An auto-rejoin keeps the persisted view.
  const [view, setView] = useState<CallView>(() => (wantRejoin ? loadView() : 'speaker'))
  // The layouts you can actually page between RIGHT NOW (Gallery is dropped when you're alone — it'd be
  // identical to Speaker — so a solo call is just Speaker + Car). Kept in a ref so the stable cycleView
  // can read the live list. Step forward/back through it, CLAMPED at the ends (no infinite wrap — the
  // standard paging feel). The header button steps forward; a swipe passes its direction; a dot jumps.
  const availableViewsRef = useRef<readonly CallView[]>(VIEW_ORDER)
  // dir = step; wrap = the header BUTTON cycles round (so it never dead-ends), a SWIPE clamps at the
  // ends (no infinite paging — the standard feel).
  const cycleView = useCallback((dir: 1 | -1 = 1, wrap = false) => {
    setView((v) => {
      const order = availableViewsRef.current
      const i = Math.max(0, order.indexOf(v))
      const raw = i + dir
      const idx = wrap ? (raw + order.length) % order.length : Math.min(order.length - 1, Math.max(0, raw))
      const next = order[idx]
      saveView(next)
      return next
    })
  }, [])
  const selectView = useCallback((v: CallView) => {
    saveView(v)
    setView(v)
  }, [])
  const [ghost, setGhost] = useState(true)
  // Full screen: on touch, drag-to-resize is fiddly, so a one-tap maximize fills the
  // viewport instead (the grip is hidden on coarse pointers — see widget.css).
  const [full, setFull] = useState(false)
  // The dedicated room window (`fill`) ALWAYS fills its OS/browser window via CSS (.kw-fillwin.kw-winmax)
  // — no JS-driven rect, no internal edge handles. The window itself is resized natively (drag the
  // browser/desktop-app window edge); the panel just tracks it, smoothly. An earlier internal edge-resize
  // overlaid the native window border (grabbing it shrank the panel into a floating rect inside the black
  // backdrop, and then a native resize no longer made it follow) — so it's gone.
  const [transparency, setTransparency] = useState<number>(loadTransparency)
  const [pickerOpen, setPickerOpen] = useState(false)
  // Host tools (waiting room + lock + verified/guest gate) live behind a single icon — a Zoom-style
  // host-controls menu — instead of an always-visible row in the bar.
  const [hostMenuOpen, setHostMenuOpen] = useState(false)
  const [agentsMenuOpen, setAgentsMenuOpen] = useState(false) // 🤖 agent menu open → pin the chrome (don't auto-hide it out from under the menu)
  // Claim admin: a room that committed a host key lets a peer prove it (enter the host password) to
  // unlock the moderation controls. The prompt + state; the unseal+sign happens in call.claimHost.
  const [claimOpen, setClaimOpen] = useState(false)
  const [claimPw, setClaimPw] = useState('')
  const [claimErr, setClaimErr] = useState(false)
  // Open-room CLAIMED identity (M): the entry this joiner picked from the room's declare list (?gd=),
  // applied to self meta on join. Unverified — the verified ✓ is a separate sign-in. See core/claim.ts.
  const [myClaim, setMyClaim] = useState<Claim | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [composerFocused, setComposerFocused] = useState(false) // chat input focused → hide the call-control bar (declutter while typing)
  // The avatar/emoji picker auto-hides after 10s if left open — so it never lingers over the call. Picking one
  // (onPick closes it) or reopening resets the timer via this effect's cleanup.
  useEffect(() => {
    if (!pickerOpen) return
    const t = setTimeout(() => setPickerOpen(false), 10000)
    return () => clearTimeout(t)
  }, [pickerOpen])
  // Per-viewer, session-local: agents whose on-call menu THIS viewer has hidden (the Agents menu
  // checkboxes). Never broadcast — it changes only what I see, not the agent or anyone else's view.
  const [hiddenAgents, setHiddenAgents] = useState<ReadonlySet<string>>(() => new Set())
  const toggleAgentHidden = useCallback(
    (id: string) =>
      setHiddenAgents((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    [],
  )
  const [summonNudge, setSummonNudge] = useState(true) // brand summon CTA banner (dismissible)
  // Pre-join: joining can lag (fresh signaling + ICE, esp. after a network change), so pressing Join looked
  // stuck with no feedback. Track it → spinner + "Joining…", then "Still connecting…" once it drags.
  const [joining, setJoining] = useState(false)
  const [joinSlow, setJoinSlow] = useState(false)
  const joinSlowTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [summonBusy, setSummonBusy] = useState<'idle' | 'sending' | 'summoning' | 'error' | 'neterror'>('idle') // one-tap summon state ('summoning' = launched, agent cold-starting/joining; 'neterror' = the POST couldn't reach the endpoint, vs 'error' = it replied non-OK / key expired)
  const [summonAt, setSummonAt] = useState<number | null>(null) // when summoning began → drives the staged progress message (cleared once the agent appears)
  const [, setSummonTick] = useState(0) // ticks while summoning so the staged message advances
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [chatSeen, setChatSeen] = useState(0)
  // Speaker off ("deaf"): mute EVERYONE's audio for yourself (local, in-call). Layered on top of any
  // per-peer mute-for-me — the control-bar speaker button is the master toggle.
  const [deaf, setDeaf] = useState(false)
  // Confirm-before-leave: the first tap on the in-call ✕ arms it ("Leave?"); a second tap within a few
  // seconds actually leaves — guards against an accidental exit mid-call. Auto-disarms after the timeout.
  const [leaveArmed, setLeaveArmed] = useState(false)
  const leaveArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [kicked, setKicked] = useState(false)
  // Durable email bans (host-local; only meaningful with verified identity on). When
  // the host removes a verified person we remember their email and auto-kick anyone who
  // returns under it — see removeParticipant + the auto-kick effect.
  const roomKey = normalizeRoom(roomName)
  const [bannedEmails, setBannedEmails] = useState<ReadonlySet<string>>(() => loadBans(roomKey))
  // "Verified only" policy — host-enforced. Initialised from the mount option; the host
  // can also toggle it live. With it on, the lobby blocks Join until you sign in, and
  // the host removes anyone unverified / off-domain who slips in (e.g. via auto-rejoin).
  const [requireVerified, setRequireVerified] = useState(!!verifyIdentity?.require)
  // The cert pinned on BOTH the presence peer (authority gate) and the media mesh, so
  // one signed token verifies for both. Generated at room-connect (below) when identity
  // is on. Refs feed the connect effect without making it re-run on every render.
  const [sharedCert, setSharedCert] = useState<RTCCertificate | null>(null)
  const verifyIdentityRef = useRef(verifyIdentity)
  verifyIdentityRef.current = verifyIdentity
  const agentCreditsRef = useRef(agentCredits)
  agentCreditsRef.current = agentCredits
  const joinGateRef = useRef(joinGate)
  joinGateRef.current = joinGate
  // HOST tiers committed in the link (precedence: key > OIDC email > name):
  //  • PASSWORD (strong): a host PUBLIC key (`hostPubKey`) + the private key SEALED under a password
  //    (`hostKeySealed`). Claim admin by proving the key. See core/hostKey.ts.
  //  • OIDC (strong, portable): a host EMAIL (`hostEmail`) — the host signs in (OIDC) and proves it;
  //    un-spoofable + works on any device. Needs the OAuth client id (`clientId`, also in the link).
  //  • SOFT (name): just a host name (`hostName`) — whoever joins under it is the host. No crypto, so
  //    any link-holder can claim it; good for the "wait for the agent, then admit everyone" flow.
  // A room with none committed has no admin at all.
  const hostKeySealed = joinGate?.hostKeySealed
  const hostKeyTier = !!joinGate?.hostPubKey // password/key tier
  const oidcHostEmail = hostKeyTier ? undefined : joinGate?.hostEmail
  const softHostName = hostKeyTier || oidcHostEmail ? undefined : joinGate?.hostName
  const roomHasHost = hostKeyTier || !!oidcHostEmail || !!softHostName
  const requireRef = useRef(requireVerified)
  requireRef.current = requireVerified
  const relayOnlyRef = useRef(relayOnly)
  relayOnlyRef.current = relayOnly
  // Live guest list (exact allowed emails) for a verified-only room. Seeded from the
  // mount option; the host edits it from the panel. A ref feeds the gate verifier + the
  // sweep so edits take effect for the NEXT joiner without rebuilding the connection.
  const [guestEmails, setGuestEmails] = useState<string[]>(() => verifyIdentity?.allowedEmails ?? [])
  const [guestInput, setGuestInput] = useState('')
  // The door fallback for a link gate: a guest who arrived WITHOUT their token (opened the
  // bare room link) can paste their invite here; a name-list guest picks their name.
  const [inviteInput, setInviteInput] = useState('')
  const guestEmailsRef = useRef(guestEmails)
  guestEmailsRef.current = guestEmails
  // Verified-roster (docs §7): when the link carries a signed manifest, its committed
  // member list (verified once below) governs BOTH admission (the authority allow-list)
  // AND the mutual pre-share gate (passed to useCall). Null until verified / when absent.
  const [rosterMembers, setRosterMembers] = useState<string[] | null>(null)
  const rosterMembersRef = useRef<string[] | null>(rosterMembers)
  rosterMembersRef.current = rosterMembers
  const [rosterDomains, setRosterDomains] = useState<string[] | null>(null)
  const rosterDomainsRef = useRef<string[] | null>(rosterDomains)
  rosterDomainsRef.current = rosterDomains
  // Pre-authorized AI agents committed on the link's manifest (anchor (a)). Drives the agent
  // branch of the authority's verifier — an agent presenting a key assertion is admitted iff its
  // key is here. Null when the room pre-authorizes no agents.
  const [agentKeys, setAgentKeys] = useState<AgentEntry[] | null>(null)
  const agentKeysRef = useRef<AgentEntry[] | null>(agentKeys)
  // Agent-only room: the manifest commits agentKeys but NO human members/domains, so humans are OPEN (the
  // gate verifies only the agent, by its key). The authority needs this to admit credential-less humans
  // instead of holding them (room.ts openHumans) — otherwise an agent room rosters only the agent.
  const [humansOpen, setHumansOpen] = useState(false)
  const humansOpenRef = useRef(false)
  humansOpenRef.current = humansOpen
  agentKeysRef.current = agentKeys
  // Authority-only: a verified agent's granted caps, keyed by the cert fingerprint the gate
  // proved. The reconcile effect below applies them to the agent's grant once we can match the
  // fingerprint to a roster member (via the safety layer). Empty for non-authorities / no agents.
  const agentCapsByFpRef = useRef<Map<string, Grant>>(new Map())
  // Reset the recorded caps whenever the ROOM changes — a fingerprint recorded for an agent in one
  // room must never carry its grant into the next room (different allow-list). Keyed on roomKey, so
  // it never clears mid-session.
  useEffect(() => {
    agentCapsByFpRef.current.clear()
  }, [roomKey])
  // Whether the committed roster includes any `mail` invitees → the room also accepts the
  // email-code provider (so we add it to the accepted-verifiers list + offer email sign-in).
  const [emailAccepted, setEmailAccepted] = useState(false)
  // Verify the link's signed manifest ONCE (creator pubkey from the link, room-bound,
  // unexpired) and adopt its committed roster. Fail-closed: a bad/expired/foreign-room
  // manifest yields null → the mutual gate stays inert and the room behaves like a plain
  // verified-only room. Only meaningful for the cert-bound `google` mode (where each peer
  // proves a listed identity peer-to-peer); invite/name manifests gate admission only.
  useEffect(() => {
    const gate = joinGate
    if (!verifyIdentity || gate?.mode !== 'google' || !gate.manifest || !gate.pubKey) {
      setRosterMembers(null)
      setRosterDomains(null)
      setEmailAccepted(false)
      return
    }
    let alive = true
    void (async () => {
      try {
        const pub = await importInvitePublicKey(gate.pubKey!)
        // Pin mode:'google' — only a cert-bound google roster drives the peer-to-peer mutual
        // gate (an invite-mode manifest, even if validly signed, must not engage it).
        const mv = await verifyManifest(gate.manifest!, pub, { room: roomKey, now: Math.floor(Date.now() / 1000), mode: 'google' })
        if (!alive) return
        // Empty members/domains ⇒ null (no human gate), so an agent-only manifest (agentKeys but no
        // people) leaves humans OPEN — `require` falls back to the host default instead of being
        // forced on by a truthy empty array.
        setRosterMembers(mv.ok && mv.manifest.members.length ? mv.manifest.members : null)
        setRosterDomains(mv.ok && mv.manifest.domains?.length ? mv.manifest.domains : null)
        setEmailAccepted(mv.ok ? (mv.manifest.invitees?.some((i) => i.method === 'mail') ?? false) : false)
      } catch {
        if (alive) {
          setRosterMembers(null)
          setRosterDomains(null)
          setEmailAccepted(false)
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [joinGate, verifyIdentity, roomKey])
  // Agent allow-list — INDEPENDENT of human verification (no OIDC/Google in the loop). Whenever the
  // link commits a signed manifest (+ the creator's public key), verify it (room-bound, unexpired)
  // and adopt its `agentKeys`, so the authority admits a pre-authorized agent BY ITS OWN KEY in ANY
  // human-gate mode — an `invite`-mode, agent-only room keeps humans open while gating the agent by
  // a cert-bound assertion. NO mode pin: agentKeys are orthogonal to how humans prove themselves
  // (roomManifest.ts). Fail-closed: a bad / expired / foreign-room manifest ⇒ null (no agent admitted).
  useEffect(() => {
    const gate = joinGate
    if (!gate?.manifest || !gate.pubKey) {
      setAgentKeys(null)
      setHumansOpen(false)
      return
    }
    let alive = true
    void (async () => {
      try {
        const pub = await importInvitePublicKey(gate.pubKey!)
        const mv = await verifyManifest(gate.manifest!, pub, { room: roomKey, now: Math.floor(Date.now() / 1000) })
        if (!alive) return
        const keys = mv.ok ? (mv.manifest.agentKeys ?? null) : null
        setAgentKeys(keys)
        setHumansOpen(mv.ok && humansOpenForManifest(mv.manifest)) // agent-only ⇒ humans open (shared rule)
      } catch {
        if (alive) {
          setAgentKeys(null)
          setHumansOpen(false)
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [joinGate, roomKey])
  const [draft, setDraft] = useState('')
  // Directed messaging: who the next chat / pay goes to — null = the whole room, else
  // a participant id (private, point-to-point over the mesh).
  const [recipientId, setRecipientId] = useState<string | null>(null)
  const msgsRef = useRef<HTMLDivElement | null>(null)
  const [name, setName] = useState(() => {
    try {
      return defaultName ?? localStorage.getItem('kibitz.name') ?? ''
    } catch {
      return defaultName ?? ''
    }
  })
  // A name is required to join — so people know who joined and the agent can address you. Join INSISTS on it:
  // an empty-name Join focuses the field + flags it rather than going in as an anonymous "Guest".
  const nameRef = useRef<HTMLInputElement>(null)
  const [nameErr, setNameErr] = useState(false)
  // Offline (LAN) mode: a relay is configured via ?galaxy= — everyone on this
  // WiFi calls directly through it, no internet/broker. Read once.
  // Per-room CHOICE: use the offline (LAN) transport iff the host says so for THIS room. Fall back to "a relay
  // is configured" (hasGalaxy) only when no explicit choice was passed — so a relay being merely PRESENT (as in
  // the native APK, which always runs one) no longer forces every room to LAN. Read once.
  const offline = useState(() => offlineProp ?? hasGalaxy())[0]
  type AnyRoom = CallRoom &
    LobbyRoom &
    HostLobbyRoom & {
      status(): RoomStatus
      onChange(cb: () => void): void
      close(): void
      /** Introduce ourselves to the host's lobby before joining (online room only). */
      knock?(name: string, avatar: string): void
      /** The host removed us from the room — leave + show the removed overlay. */
      onKicked?(cb: () => void): void
      /** The current host's media id, so tiles can label who the host is. */
      hostId?(): string
    }
  const [room, setRoom] = useState<AnyRoom | null>(null)
  const lanRef = useRef<LanRoom | null>(null)
  const [, bump] = useState(0)
  const makeMedia = useCallback(
    () =>
      preview
        ? previewMedia()
        : lanRef.current
          ? lanMedia(lanRef.current.signal, lanRef.current.voiceId)
          : peerJsMedia(),
    [preview],
  )
  // Accepted verification providers — peers' tokens are routed by issuer (Google for signin/oidc
  // members, our email-code backend for mail members). The email provider verifies against this
  // site's own /api/email/jwks; its issuer is this origin + audience the fixed 'kibitz-email'
  // (must match EMAIL_ISSUER/EMAIL_AUDIENCE on the backend).
  const jwksResolverRef = useRef(createJwksResolver())
  const acceptProviders = useMemo<AcceptedProvider[]>(() => {
    const list: AcceptedProvider[] = []
    const vid = verifyIdentity
    if (vid) list.push({ issuer: issuersFor(vid), audience: vid.clientId, resolveJwks: () => jwksResolverRef.current.resolve(discoveryIssuerFor(vid)) })
    if (emailAccepted) {
      // The email token's issuer is the BACKEND's origin (EMAIL_ISSUER), not necessarily ours —
      // an extension on chrome-extension:// must point at kibitz.chat (`apiBase`) to match it.
      const origin = (apiBase ?? (typeof location !== 'undefined' ? location.origin : '')).replace(/\/$/, '')
      list.push({
        issuer: origin,
        audience: 'kibitz-email',
        resolveJwks: async () => {
          try {
            const r = await fetch(`${origin}/api/email/jwks`)
            const j = (await r.json()) as { keys?: Jwk[] }
            return j.keys ?? []
          } catch {
            return []
          }
        },
      })
    }
    return list
  }, [verifyIdentity, emailAccepted, apiBase])
  const acceptProvidersRef = useRef<AcceptedProvider[]>(acceptProviders)
  acceptProvidersRef.current = acceptProviders

  // Salt the identity binding with the NORMALISED room id so a token can't be replayed
  // into another room; normalise (not the raw name) so two peers whose URLs differ only
  // by casing — but resolve to the SAME room — still compute the same salt.
  const call = useCall(
    room,
    name.trim() || 'Guest',
    makeMedia,
    preview,
    preview ? undefined : verifyIdentity,
    normalizeRoom(roomName),
    sharedCert,
    preview ? null : rosterMembers, // verified-roster mutual pre-share gate (docs §7)
    preview ? null : rosterDomains, // …allowed domains (OIDC slots)
    preview || !acceptProviders.length ? undefined : acceptProviders, // multi-provider peer-verify
    undefined, // makeProvider — use the default (Google), built from idConfig
    preview ? false : !!relayOnly, // privacy: relay-only (hide IP from peers); off in the demo preview
    offline, // LAN call → grab a real muted mic at join so iOS exposes connectable ICE candidates (no TURN here)
  )
  const speaking = useActiveSpeakers(call.participants)
  // The "pay me" link subsystem — see usePayRequests (incoming requests over the mesh + the in-chat composer).
  const { payRequests, payDismissed, setPayDismissed, payOpen, setPayOpen, payDraft, setPayDraft, payNote, setPayNote, payErr, setPayErr, sendPayRequest } =
    usePayRequests(call, recipientId)
  // Video pop-out (mobile / iOS): float the active speaker as a system Picture-in-Picture tile
  // over the home screen & other apps. Camera frames when they're on; avatar + speaking glow when
  // off (so a voice-only call still floats something useful). Read every frame — follows whoever
  // is talking. Document PiP (desktop, below) is the richer floating-window path; this is the one
  // mobile gets, so the button shows only where Document PiP isn't available.
  const pipFocus = useCallback((): PipFocus | null => {
    const ps = call.participants.filter((p) => p.meta?.role !== 'kibitzer') // unseen observers don't tile
    if (!ps.length) return null
    const remotes = ps.filter((p) => !p.isSelf)
    const focus = remotes.find((p) => speaking.has(p.id)) || remotes[0] || ps[0]
    const hasVideo = !!focus.cam && !!focus.stream && focus.stream.getVideoTracks().some((t) => t.readyState === 'live')
    return {
      stream: focus.stream,
      hasVideo,
      name: focus.name || '',
      avatar: focus.avatar || (focus.name || '?').charAt(0).toUpperCase(),
      speaking: speaking.has(focus.id),
    }
  }, [call.participants, speaking])
  const videoPip = useVideoPip(pipFocus)
  // Knock-to-admit: when the host's lobby is on, we're held until they let us in.
  // null unless the room actually gated us (preview/LAN rooms never do).
  const lobbyStatus = useLobby(room)
  // The host (authority) side: the lobby toggle + the live waiting list.
  const hostLobby = useHostLobby(room, call.isVerifiedHost, (op, target) => void call.hostModerate(op, target))
  // Prove the host password → claim admin. Wrong password keeps the prompt open with an error.
  const doClaim = useCallback(async () => {
    if (!hostKeySealed) return
    const ok = await call.claimHost(claimPw, hostKeySealed)
    if (ok) {
      setClaimOpen(false)
      setClaimPw('')
      setClaimErr(false)
    } else {
      setClaimErr(true)
    }
  }, [call, claimPw, hostKeySealed])
  // Soft (name) tier: one tap — adopt the committed host name as our display name and re-announce, so the
  // authority recognizes us as the host. setName keeps the Widget/UI in sync; claimHostByName announces now.
  const doClaimByName = useCallback(() => {
    if (!softHostName) return
    setName(softHostName)
    call.claimHostByName(softHostName)
  }, [call, softHostName])
  // Stage: when someone is screen-sharing (advertised via roster meta), promote them
  // to a big letterboxed view and drop everyone else to a face strip — so a viewer,
  // even with no extension, actually watches the shared tab. Newest presenter wins.
  const presenter = useMemo(() => pickPresenter(call.participants), [call.participants])
  // Kibitzers (meta.role==='kibitzer') are UNSEEN observers — an AI agent or a watcher that listens
  // and may chat/speak, but gets NO tile in the grid. We still play their audio via a hidden sink.
  const isKibitzer = (p: { meta?: Record<string, unknown> }) => p.meta?.role === 'kibitzer'
  const tileParticipants = useMemo(() => call.participants.filter((p) => !isKibitzer(p)), [call.participants])
  const kibitzerStreams = useMemo(
    () => call.participants.filter((p) => !p.isSelf && p.stream && isKibitzer(p)),
    [call.participants],
  )

  // Is an AI agent in the call (drives the summon banner), and has one ever been (→ "bring it back")? See
  // useAgentPresence — agentPresent + the room-state-ledger 'agentSeen' attestation (synced P2P + persisted).
  const { agentPresent, agentResumable } = useAgentPresence(call, !!preview, !!headless, roomKey)

  // Bounded interactive widgets + the shared stage — see useStageWidgets (subscribe/hold instances on the widget
  // channel, drive the anyone-can-push stage pointer). Consumed by StagedWidget + the in-chat WidgetBubble.
  const { mapInstances, widgetInstances, stagedWidget, someonePresenting, dropMapPin, driveMapView, stageMapWidget, dismiss: dismissWidget } =
    useStageWidgets(call, !!preview)
  // The agent just LEFT (present → absent): re-arm the summon banner so it reappears (it stayed stuck in its
  // post-summon 'done'/auto-dismissed state otherwise). Re-summon re-launches the same agent → it resumes.
  const prevAgentPresentRef = useRef(false)
  useEffect(() => {
    if (prevAgentPresentRef.current && !agentPresent) {
      setSummonBusy('idle')
      setSummonNudge(true)
      setSummonAt(null)
    }
    prevAgentPresentRef.current = agentPresent
  }, [agentPresent])
  // Staged summon progress: while summoning and the agent hasn't appeared, tick so the message advances; clear
  // once the agent is present (its tile now conveys "connected") so the nudge stops and we don't tick forever.
  useEffect(() => {
    if (summonAt == null) return
    if (agentPresent) {
      setSummonAt(null)
      return
    }
    const id = window.setInterval(() => setSummonTick((t) => t + 1), 1500)
    return () => window.clearInterval(id)
  }, [summonAt, agentPresent])
  // One-tap summon (extracted so the staged-progress + retry buttons share it). On a successful POST we enter
  // 'summoning' and start the clock — the agent is now cold-starting + joining; progress runs until it appears.
  const summonAgent = useCallback(async () => {
    if (summonApi && summonKey) {
      setSummonBusy('sending')
      try {
        // Platform-blind memory: if the room link carries an `mk`, send only its COMMITMENT (a hash) — the server
        // never sees `mk` (it reaches the agent over E2EE on roster-join). No `mk` ⇒ omitted (no encrypted memory).
        const mk = roomKeyFromHash()
        const mkCommit = mk ? await memCommit(mk) : ''
        const res = await fetch(summonApi, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ summonKey, ...(mkCommit ? { mkCommit } : {}) }),
        })
        if (res.ok) {
          setSummonBusy('summoning')
          setSummonAt(Date.now())
        } else {
          setSummonBusy('error') // endpoint replied non-OK → likely an expired/invalid key
        }
      } catch {
        setSummonBusy('neterror') // fetch threw → couldn't REACH the endpoint (network / firewall / DNS)
      }
      return
    }
    // Legacy: a brand that set ONLY `summonPath` (no one-tap wiring) opens its wizard in a new tab.
    if (summonPath) {
      window.open(`${summonPath}${summonPath.includes('?') ? '&' : '?'}room=${encodeURIComponent(roomKey)}`, '_blank', 'noopener,noreferrer')
    }
  }, [summonApi, summonKey, summonPath, roomKey])
  const summonElapsed = summonAt != null ? Date.now() - summonAt : 0
  const summonSlow = summonAt != null && summonElapsed > 40000 // cold-start far past the usual ~20s → offer a retry
  // Floating agent-control bubble (docs/floating-agent-control.md). Default = brand.agentBubble (ON for
  // kibitz via VITE_BRAND_AGENT_BUBBLE=1; OFF on generic Kibitz). Per-device override: ?bubble=1 forces
  // it on, ?bubble=0 opts out (both persist to localStorage) — so a user can escape back to the legacy
  // summon banner / agent bar even when the brand defaults it on. When on, those legacy surfaces hide.
  const bubbleOn = useMemo(() => {
    try {
      const q = new URLSearchParams(window.location.search).get('bubble')
      if (q === '1') {
        window.localStorage.setItem('kbz.agentBubble', '1')
        return true
      }
      if (q === '0') {
        window.localStorage.setItem('kbz.agentBubble', '0')
        return false
      }
      const ls = window.localStorage.getItem('kbz.agentBubble')
      if (ls === '1') return true
      if (ls === '0') return false
      return !!brand.agentBubble
    } catch {
      return !!brand.agentBubble
    }
  }, [])
  // Speaker layout: promote ONE focus tile (big), everyone else to a filmstrip — like Zoom's
  // speaker view. A presenter's screen always wins the focus; otherwise it's the active speaker,
  // held STICKILY (we only switch when someone else actually talks, so it doesn't flicker on a
  // stray "mm-hm"). `stageOn` decides whether to stage at all: a presenter, an explicit Speaker
  // view, or Auto once there are 3+ people (a 1-on-1 reads better as an even gallery).
  // Pageable layouts right now: Gallery is meaningless alone (== Speaker), so a solo call is just
  // Speaker + Car. Keep the live list in the ref for cycleView, and snap a now-invalid view (e.g. you
  // were in Gallery and everyone left) back to Speaker.
  const multiParty = tileParticipants.length > 1
  // Car (driving) view is only meaningful on a TOUCH device — a phone you'd prop up in the car. On a
  // desktop (no touch) it's just noise, so drop it from the pageable views. Gallery is dropped when
  // you're alone (it'd be identical to Speaker). Order is preserved from VIEW_ORDER.
  const canTouch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0
  // Car (driving mode: video hidden, one big mute button) belongs ONLY to the real room app you'd prop up
  // in the car — the dedicated room window / installed app (`fill`). It's useless in the embedded widget
  // even maximized, so it's not a `carSurface` there. Gallery ("tiles in a row") is offered on any BIG
  // surface — the widget's fullscreen or the room window — as Speaker's swipe partner, even solo; in the
  // cramped corner panel it still needs ≥2 people. (`full` toggles fullscreen; `fill` is the room window.)
  const carSurface = !!fill
  const availableViews = pageableViews({ canTouch, carSurface, multiParty })
  availableViewsRef.current = availableViews
  // Snap a now-invalid view back to Speaker — e.g. you were in Gallery and everyone left, a stale saved
  // 'car' loaded where Car isn't offered (a desktop, or the embedded corner panel), or you left fullscreen
  // (which un-offers Car on the embed). `full` is in the deps so exiting fullscreen re-runs this.
  useEffect(() => {
    if (!availableViews.includes(view)) selectView('speaker')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- availableViews is derived each render; its membership is captured by these
  }, [multiParty, canTouch, view, selectView, full])
  // The first join already STARTS on Speaker (the view initializer above). Here we just PERSIST that on
  // join, so if you reload right after (an auto-rejoin) it keeps Speaker rather than a stale saved view.
  const freshJoinViewRef = useRef(false)
  useEffect(() => {
    if (!call.inCall || freshJoinViewRef.current) return
    freshJoinViewRef.current = true
    if (!wantRejoin) saveView('speaker')
  }, [call.inCall, wantRejoin])
  // Car (driving) mode hides every tile, so it overrides the stage even with a presenter.
  const carMode = view === 'car'
  const stageOn = !carMode && (!!presenter || view === 'speaker')
  const [focusId, setFocusId] = useState<string | null>(null)
  useEffect(() => {
    const talking = tileParticipants.find((p) => !p.isSelf && speaking.has(p.id))
    if (talking) setFocusId(talking.id) // sticky: only move the focus when someone new speaks
  }, [speaking, tileParticipants])
  const focus = useMemo(() => {
    if (presenter) return presenter
    if (!stageOn) return null
    const remotes = tileParticipants.filter((p) => !p.isSelf)
    if (remotes.length === 0) return null // no one else yet → fall through to gallery/solo, never stage your own face
    return (focusId ? remotes.find((p) => p.id === focusId) : null) || remotes[0]
  }, [presenter, stageOn, focusId, tileParticipants])
  const focusOthers = useMemo(
    // While someone is PRESENTING — or a WIDGET owns the stage — keep EVERYONE in the filmstrip (their tile shows
    // the avatar; the share/widget is big on the stage), so no participant vanishes behind the staged surface. For a
    // plain active-speaker focus (no presenter, no staged widget), drop the focus from the strip as before — no
    // point duplicating the big tile that's on the stage.
    () => (presenter || stagedWidget ? tileParticipants : focus ? tileParticipants.filter((p) => p.id !== focus.id) : []),
    [presenter, stagedWidget, focus, tileParticipants],
  )
  // Car mode: who (other than you) is currently talking — shown big, in place of the hidden tiles.
  const carSpeaker = carMode ? tileParticipants.find((p) => !p.isSelf && speaking.has(p.id)) : undefined
  // Car mode does NOT auto-turn-off your camera. Swiping into Car mode silently killing the camera
  // surprised people (it's a view switch, not a privacy toggle) — leave the camera as the user set it;
  // they can turn it off themselves. Car mode still hides the tiles, so it's not decoding video anyway.
  // (Car mode no longer forces the mic engaged: that made iOS route the call as a phone call — HFP —
  // which fought the Kibitz media panel and flickered. We keep the media panel everywhere instead; you
  // tap mic only to TALK. setKeepMicCaptured/engageMic stay on the controller, just unused for now.)

  // Safety codes (SAS): the people you can verify against (everyone but you). The
  // panel polls live codes only while it's open, and we surface a warning on the
  // header button if any peer's key changed mid-call. Off in preview (no peers).
  // The host's media id (rides the roster) — so tiles label who's in charge.
  const hostId = room?.hostId?.() ?? ''
  const verifyPeers = useMemo(() => call.participants.filter((p) => !p.isSelf), [call.participants])
  const verifyIds = useMemo(() => verifyPeers.map((p) => p.id), [verifyPeers])
  // Poll whenever we're in a real call with peers — not just while the panel is open —
  // so a mid-call key change lights the header shield even before you look.
  // TOFU pinning keys on the peer's name: verifying a contact pins their cert to that name, so a
  // later call where "the same name" shows a different key trips the man-in-the-middle alarm.
  const peerKeyOf = useCallback(
    (id: string) => verifyPeers.find((p) => p.id === id)?.name ?? '',
    [verifyPeers],
  )
  const { safety, verify, unverify } = useSafety(
    verifyIds,
    call.getSafetyCode,
    call.inCall && !preview && verifyIds.length > 0,
    peerKeyOf,
  )
  const safetyAlarm = !preview && verifyIds.some((id) => safety[id]?.changed)
  // Custom-caps for a pre-authorized AGENT: the gate recorded the caps the agent's verified key
  // grants, keyed by the cert fingerprint it proved. Here (authority only — the map is empty
  // otherwise) we match that fingerprint to the roster member via the SAME fp the safety layer
  // reads, and apply it as the agent's grant. So an agent-only/collaboration room grants `act` by
  // policy; a human-room agent (no caps in the manifest) stays perceive-only by default. The caps
  // are bound to the proven key, not a self-asserted meta — no escalation. Idempotent: we set only
  // when the grant differs, so it converges (no render loop).
  useEffect(() => {
    if (preview || agentCapsByFpRef.current.size === 0) return
    const sig = (g: Grant) => `${[...g.perceive].sort().join(',')}|${[...g.act].sort().join(',')}`
    for (const p of call.participants) {
      if (p.isSelf || p.meta?.role !== 'agent') continue
      const fp = safety[p.id]?.remoteFp
      if (!fp) continue
      const caps = agentCapsByFpRef.current.get(canonicalFingerprint(fp))
      if (!caps) continue
      if (sig(call.getCapabilityGrant(p.id)) !== sig(caps)) call.setCapabilityGrant(p.id, caps)
    }
  }, [call.participants, safety, preview, call.getCapabilityGrant, call.setCapabilityGrant])
  // Verified identities (opt-in L3): poll self + every peer while in a real call. Each
  // is cert-bound — see useCall.getIdentity. Inert (empty) unless identity is enabled.
  const identityIds = useMemo(() => call.participants.map((p) => p.id), [call.participants])
  const identities = useIdentity(identityIds, call.getIdentity, call.inCall && call.identityEnabled)
  // Per-peer direct-vs-relay badge (diagnostic) — polled while in a real call.
  const conns = useConnections(verifyIds, call.getConnectionInfo, call.inCall && !preview && verifyIds.length > 0)
  // The annotation overlay's seam — content rides the data mesh (useCall), so feed
  // StageInk the call's stable ink methods (memoized so it doesn't re-subscribe).
  const inkApi = useMemo(() => ({ sendInk: call.sendInk, onInk: call.onInk }), [call.sendInk, call.onInk])
  // Our own participant id — so the ink overlay can colour OUR laser the same hue peers see for us.
  const selfId = useMemo(() => call.participants.find((p) => p.isSelf)?.id, [call.participants])
  // People you can direct a message to (everyone but you). If the chosen recipient
  // leaves, fall back to the whole room.
  const recipients = useMemo(() => call.participants.filter((p) => !p.isSelf), [call.participants])
  useEffect(() => {
    if (recipientId && !recipients.some((p) => p.id === recipientId)) setRecipientId(null)
  }, [recipients, recipientId])

  const tilesRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null) // the .kw-stage box — for the annotation overlay
  // REAL OS fullscreen for the shared screen (the stage), so OS Screen-Mirroring shows it FULL-BLEED on a TV —
  // no browser/app chrome. Element fullscreen is desktop + Android Chrome; iOS Safari only fullscreens a bare
  // <video> (no ink overlay), so the button is hidden there — on iOS use Screen Mirroring + the fill view.
  // Maximize the staged content (image / shared screen / a viewer's video) to fill the viewport. A CSS overlay
  // (kw-stagemax, position:fixed) on EVERY platform — NOT element.requestFullscreen. iOS can't fullscreen a <div>,
  // and on Android an OS-fullscreen <video> composites as a HARDWARE OVERLAY above the DOM, burying the exit
  // button → "opened to full screen with no way back". CSS-max keeps the video a normal element so the exit ✕ stays
  // a tappable button on top. A staged VIDEO FILE (its own <video controls>) uses native fullscreen (has its exit).
  const [stageBig, setStageBig] = useState(false)
  useEffect(() => {
    if (!presenter) setStageBig(false) // never strand the overlay after the stage clears (offstage / left)
  }, [presenter])
  const toggleStageFs = useCallback(() => {
    const vid = imgElRef.current // a staged VIDEO FILE renders its own <video controls> → native fullscreen (its
    if (vid) {                    // controls include an exit; iOS via webkitEnterFullscreen). Everything else = CSS-max.
      if (document.fullscreenElement === vid) document.exitFullscreen?.()
      else if (vid.requestFullscreen) vid.requestFullscreen().catch(() => setStageBig(true))
      else (vid as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen?.()
      return
    }
    setStageBig((v) => !v)
  }, [])
  // STAGE chat media to the shared screen ("Stage" — no screen-share, works on iOS). IMAGE → a still canvas (a
  // keepalive redraw keeps it emitting). VIDEO → a real <video controls> we RENDER (below) so the presenter can
  // play / pause / seek / mute; its captureStream feeds the SHARE lane (+ the share-audio lane for the sound).
  // Publishes on call.shareTrack + advertises meta.stageImage so doodles bind per media.
  const imgStreamRef = useRef<MediaStream | null>(null)
  const imgElRef = useRef<HTMLVideoElement | null>(null) // the rendered staged-VIDEO element (controls + capture source)
  // The rendered staged MEDIA (our own <video> OR <img>) in the .kw-staged-vid overlay — StageInk anchors the ink to
  // THIS element's picture so a doodle lands on the screen (not the whole stage box) and tracks it through reflow.
  const stageContentRef = useRef<HTMLVideoElement | HTMLImageElement | null>(null)
  const imgTimerRef = useRef(0)
  const stagedKeyRef = useRef<string>('') // the staged media's doodle key (set before the <video> mounts)
  // iOS fallback plumbing — Safari has no HTMLMediaElement.captureStream, so a staged video/audio is captured via
  // a canvas render loop (video) + Web Audio (audio). These hold that machinery for teardown.
  const rafRef = useRef(0) // the canvas render loop (requestAnimationFrame id — used by the rVFC-fallback path)
  const mirrorStopRef = useRef<(() => void) | null>(null) // cancels the staged-video mirror loop (rVFC or rAF)
  const audioCtxRef = useRef<AudioContext | null>(null) // Web Audio graph capturing the element's sound
  const localGainRef = useRef<GainNode | null>(null) // local-playback gain (muted on speaker-off; the SHARE stays full)
  const deafRef = useRef(false) // current speaker-off state, for the capture path
  const [presentingImage, setPresentingImage] = useState(false)
  const [stagedVideoSrc, setStagedVideoSrc] = useState<string | null>(null) // non-null → render the controlled <video>
  // The staged IMAGE's local src → the presenter renders it DIRECTLY on the stage (a local <img>), the same way a
  // staged video renders its local <video>. Set the moment we stage (before the share lane), so it shows even ALONE
  // and never depends on the capture/share round-trip that used to leave a lone presenter with a blank stage.
  const [stagedImageSrc, setStagedImageSrc] = useState<string | null>(null)
  // Unified stage FALLBACK: every object is rendered by the presenter + shared; viewers watch the share. OPTION 1
  // (viewers render their OWN local copy of a video from the file + timeline) is DEFERRED — gated off here (the code
  // stays for later). Flip to true to bring per-viewer self-rendering back.
  const STAGE_OPT1 = false
  // Stage a chart/table/diagram AS PIXELS (snapshot → share as an image) instead of the per-peer pointer render, so
  // it reaches every viewer — including LATE JOINERS — with no dependency on them holding the widget's data. This is
  // the same unified presenter-renders-and-shares fallback as photos/videos. The per-peer pointer path (StagedWidget)
  // stays intact for maps, as the snapshot fallback, and for a future crisp "share the live widget" mode. Flip false
  // to restore the per-peer widget render for everyone.
  const STAGE_WIDGET_PIXELS = true
  // OPTION 1 (send-the-state): this staged VIDEO is shown from each peer's OWN local copy (native <video controls>,
  // full quality) synced by the timeline broadcast — we share only a low-fps poster to hold the stage. false = the
  // legacy streamed path (audio, or a video copy we can't resolve locally).
  const [stageOpt1, setStageOpt1] = useState(false)
  const [stagedIsAudio, setStagedIsAudio] = useState(false) // staged media is AUDIO (no picture) → keep the 🎵 card on our own stage too
  // Viewer-control of a staged clip (play/pause), over the reserved `ctl` channel. Presenter: stageCtlAllowed (a
  // suppress toggle) + broadcasts its allow/playing state; applies a viewer's toggle unless suppressed. Viewer:
  // viewerCtl mirrors the presenter's last broadcast → drives a ⏯ on the stage.
  // The staged-clip control bar is the SAME for everyone (no presenter-only permission): the presenter holds the
  // real <video> (master) and broadcasts its transport {playing, time, dur}; every viewer renders a custom bar from
  // that and RELAYS play/pause/seek/offstage back to the presenter (who applies it → the captured stream reflects it
  // → all in sync). Native <video controls> retired: a live MediaStream has no seekable timeline, so viewers never
  // got a scrub bar — this custom bar gives scrub to ALL by relaying seeks to the master.
  const stagePlayingRef = useRef(false)
  const stagedMidRef = useRef<string | undefined>(undefined) // the mid WE (authority) advertised as stageMedia
  const allHaveRef = useRef(false) // do all followers already hold their own copy? → poster; else → stream (see #2 below)
  const stageTimeRef = useRef(0)
  const stageDurRef = useRef(0)
  // The presenter's live transport state as a VIEWER sees it (null when nobody is presenting a clip to us).
  const [stageXport, setStageXport] = useState<{ from: string; playing: boolean; time: number; dur: number } | null>(null)
  // `call` is rebuilt every render, so keep it in a ref — else broadcastStageState changes each render and the
  // effects that depend on it (the roster re-broadcast + the 1.5s heartbeat) re-fire every render (a ctl-lane flood
  // while staging + constant interval churn). Reading refs only, so a [] callback is safe.
  const callStageRef = useRef(call)
  callStageRef.current = call
  const broadcastStageState = useCallback(() => {
    callStageRef.current.sendCtl({ t: 'stage', on: true, playing: stagePlayingRef.current, time: stageTimeRef.current, dur: stageDurRef.current })
  }, [])
  // True when a staged-VIDEO transport bar is on the stage for us (we hold the clip, or we're a viewer of the
  // presenter's clip). The pen/ink toolbar then portals into a row ABOVE that bar (StageVideoBar's inkSlotRef,
  // chat-layout style) instead of the side column — so the two don't collide and the ink stays visible.
  const stagedClipBar = !!stagedVideoSrc || !!(presenter && !presenter.isSelf && stageXport && stageXport.from === presenter.id)
  // OPTION 1 (send-the-state) staged-video resolution. AUTHORITY: WE staged a video via option 1 → drive the master
  // <video> + broadcast. FOLLOWER: the presenter advertised a file in its meta (stageMedia) and we hold our OWN local
  // copy → render that locally + follow the broadcast. localMediaSrc is null when we lack the bytes (large/evicted →
  // the deferred streamed fallback: the legacy viewer bar stays, controlling the poster preview).
  const opt1Authority = !!stagedVideoSrc && stageOpt1
  const opt1FollowKey = !opt1Authority && presenter && !presenter.isSelf && typeof presenter.meta?.stageMedia === 'string' ? (presenter.meta.stageMedia as string) : undefined
  const opt1FollowSrc = opt1FollowKey ? localMediaSrc(call.chat, opt1FollowKey) : null
  const opt1Src = opt1Authority ? stagedVideoSrc : opt1FollowSrc
  const opt1Role: 'authority' | 'follower' = opt1Authority ? 'authority' : 'follower'
  // #2 (stream-during-the-gap): the AUTHORITY streams the REAL video while any follower still lacks its own copy
  // (else that follower sees a frozen ~1fps poster), and drops to the cheap poster once EVERYONE has it. Followers
  // advertise readiness via `stageHave`; the authority tallies it. present roster = call.participants (departed
  // peers drop off), so "every non-self peer has it" is the gate.
  const allFollowersHaveStage = !!opt1Authority && call.participants.every((p) => p.isSelf || p.meta?.stageHave === stagedMidRef.current)
  allHaveRef.current = allFollowersHaveStage
  useEffect(() => {
    // FOLLOWER: advertise whether we can play the staged file LOCALLY (have the bytes) so the authority can decide.
    // OPT1-ONLY. With opt1 gated off this MUST NOT run: setMeta REPLACES the whole meta, so setMeta({stageHave})
    // here wiped the presenter's own `presenting:true` → pickPresenter dropped them → no stage mode (a real bug).
    if (!STAGE_OPT1 || opt1Authority) return // the authority reads followers' stageHave; it doesn't set its own
    call.setMeta({ stageHave: opt1FollowKey && opt1FollowSrc ? opt1FollowKey : undefined })
  }, [opt1Authority, opt1FollowKey, opt1FollowSrc, call])
  // Tear down whatever capture machinery a stage left running (still canvas timer, iOS render loop, captured
  // stream, Web Audio graph). Called before each new stage and on stop.
  const teardownCapture = useCallback(() => {
    if (imgTimerRef.current) {
      clearInterval(imgTimerRef.current)
      imgTimerRef.current = 0
    }
    if (mirrorStopRef.current) {
      mirrorStopRef.current() // stop the staged-video mirror (rVFC or rAF, whichever is running)
      mirrorStopRef.current = null
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
    if (imgStreamRef.current) {
      imgStreamRef.current.getTracks().forEach((t) => t.stop())
      imgStreamRef.current = null
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {})
      audioCtxRef.current = null
    }
    localGainRef.current = null
  }, [])
  const stopImagePresent = useCallback(() => {
    teardownCapture()
    setStagedVideoSrc(null) // unmounts the controlled <video>
    setStagedImageSrc(null) // unmounts the local staged <img>
    setStagedIsAudio(false)
    setStageOpt1(false)
    call.stopShare()
    call.publishShareAudio(null) // restore the dormant placeholder on the share-audio lane (no-op if not negotiated)
    call.setMeta({ stageImage: undefined, stageMedia: undefined }) // drop the doodle key + the local-copy pointer
    stagedMidRef.current = undefined // #2: no stage → no readiness tally
    call.sendCtl({ t: 'stage', on: false }) // tell viewers the staged clip is gone → hide their ⏯
    setPresentingImage(false)
  }, [call, teardownCapture])
  // The single "get off the stage" action for the header Stop. SHARED (the stage is a shared surface): whoever is
  // presenting stops directly; anyone else relays `stagecmd:offstage` to the presenter. Replaces the per-content
  // floating Stops (StageVideoBar / ShareControls), which are suppressed while this header button is shown.
  const leaveStage = useCallback(() => {
    // A VIEWER relays offstage to the presenter; the presenter — whether pickPresenter has settled OR we're still
    // staging locally in the brief window before it does — stops its own directly.
    if (presenter && !presenter.isSelf) call.sendCtlTo(presenter.id, { t: 'stagecmd', cmd: 'offstage' })
    else stopImagePresent()
  }, [presenter, stopImagePresent, call])
  // The header owns the stage controls (Stop + full-screen) + suppresses the per-content floating Stops. Keyed on
  // the LOCAL staging flags too (not just `presenter`), so for the presenter it's true THE INSTANT they stage —
  // before pickPresenter settles — otherwise the old floating Stop blinks for a frame before it's hidden.
  const stageHdrCtl = (!!presenter || presentingImage || !!stagedVideoSrc || !!stagedImageSrc) && !preview && call.inCall && !carMode
  // Two-tap confirm on the header Stop (it takes content off-stage for EVERYONE, so guard against a stray tap): the
  // first tap arms ("Stop?"), a second within 4s confirms. Auto-disarms; also disarms when the stage clears.
  const [stopArmed, setStopArmed] = useState(false)
  useEffect(() => {
    if (!stageHdrCtl) return void setStopArmed(false) // disarm when the stage clears
    if (!stopArmed) return
    const t = setTimeout(() => setStopArmed(false), 4000)
    return () => clearTimeout(t)
  }, [stopArmed, stageHdrCtl])
  // Once the rendered staged <video> can play, capture it onto the share lane(s). Guarded so it runs ONCE per stage.
  // Two capture paths: NATIVE (Chrome/Firefox/Android — HTMLMediaElement.captureStream) and a Safari/iOS FALLBACK
  // (no media-element captureStream there) that draws the video onto a canvas (canvas.captureStream IS supported)
  // and taps the audio via Web Audio. Capability-detected; `kbz.stageCanvas='1'` forces the fallback for testing.
  const captureStagedVideo = useCallback(async () => {
    const v = imgElRef.current
    if (!v || imgStreamRef.current) return
    try {
      const el = v as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream }
      const forceCanvas = (() => {
        try {
          return localStorage.getItem('kbz.stageCanvas') === '1'
        } catch {
          return false
        }
      })()
      const nativeCapture = !forceCanvas ? el.captureStream || el.mozCaptureStream : undefined
      const isAudioOnly = !(el.videoWidth > 0 && el.videoHeight > 0) // no picture = an audio file
      setStagedIsAudio(isAudioOnly)
      let vtrack: MediaStreamTrack | undefined
      let atrack: MediaStreamTrack | undefined

      if (nativeCapture) {
        // Capture the element directly (it carries both the video frames and the audio).
        const stream = nativeCapture.call(el)
        atrack = stream.getAudioTracks()[0]
        vtrack = stream.getVideoTracks()[0]
        if (vtrack) imgStreamRef.current = stream
      } else {
        // iOS / Safari: build the tracks ourselves.
        try {
          const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          if (Ctx) {
            const ctx = new Ctx()
            audioCtxRef.current = ctx
            const srcNode = ctx.createMediaElementSource(el) // taps the element's audio (detaches its default output)
            const dest = ctx.createMediaStreamDestination()
            srcNode.connect(dest) // → the SHARE (always full volume, independent of local speaker-off)
            const gain = ctx.createGain()
            gain.gain.value = deafRef.current ? 0 : 1
            srcNode.connect(gain)
            gain.connect(ctx.destination) // → the presenter's own speakers (muted when deaf)
            localGainRef.current = gain
            atrack = dest.stream.getAudioTracks()[0]
          }
        } catch {
          /* Web Audio unavailable — the video still stages, just silent */
        }
        if (!isAudioOnly) {
          // Mirror the <video> onto a canvas; canvas.captureStream IS supported on Safari/iOS (which lack
          // HTMLMediaElement.captureStream). Downscale to ~960px long-edge — the stage tile is small, and a full
          // 1080p/4K blit every frame is the real cost. Redraw is driven by requestVideoFrameCallback where
          // available: it fires ONCE per DECODED frame, so a PAUSED clip produces ZERO callbacks (no blit, no
          // re-encode, no heat) and a 24/30fps clip redraws at its true rate, not the display's 60. Fallback for
          // older Safari: a throttled rAF that skips the blit while paused. captureStream() is draw-driven, so no
          // draws → no new frames → idle encode.
          const canvas = document.createElement('canvas')
          const s = Math.min(1, 960 / Math.max(1, el.videoWidth, el.videoHeight))
          canvas.width = Math.max(2, Math.round(el.videoWidth * s))
          canvas.height = Math.max(2, Math.round(el.videoHeight * s))
          const cx = canvas.getContext('2d')
          const draw = () => cx && cx.drawImage(el, 0, 0, canvas.width, canvas.height)
          draw() // in case frame 0 is already decoded
          // A staged clip STARTS paused, so the play loop below won't redraw while paused — paint the FIRST frame
          // the moment it's actually decoded (else the stage shows blank until you hit play). These fire once a
          // frame becomes available (metadata→frame, buffering) or after a scrub; harmless to draw more than once,
          // and they don't fire per-frame, so paused stays idle. `seeked` also keeps the stage in sync if you scrub.
          const paintFrame = () => draw()
          el.addEventListener('loadeddata', paintFrame)
          el.addEventListener('canplay', paintFrame)
          el.addEventListener('seeked', paintFrame)
          const dropFirstFrame = () => {
            el.removeEventListener('loadeddata', paintFrame)
            el.removeEventListener('canplay', paintFrame)
            el.removeEventListener('seeked', paintFrame)
          }
          const rv = el as HTMLVideoElement & {
            requestVideoFrameCallback?: (cb: () => void) => number
            cancelVideoFrameCallback?: (h: number) => void
          }
          if (rv.requestVideoFrameCallback) {
            let h = 0
            let stopped = false
            const onFrame = () => {
              if (stopped) return
              draw()
              h = rv.requestVideoFrameCallback!(onFrame)
            }
            h = rv.requestVideoFrameCallback(onFrame)
            mirrorStopRef.current = () => {
              stopped = true
              rv.cancelVideoFrameCallback?.(h)
              dropFirstFrame()
            }
          } else {
            let lastDraw = 0
            const drawFrame = (now: number) => {
              rafRef.current = requestAnimationFrame(drawFrame)
              if (el.paused || el.ended) return // paused → no blit → captureStream idles → no CPU/heat
              if (now - lastDraw < 40) return // ~25fps is plenty for a staged clip
              lastDraw = now
              draw()
            }
            rafRef.current = requestAnimationFrame(drawFrame)
            mirrorStopRef.current = () => {
              if (rafRef.current) {
                cancelAnimationFrame(rafRef.current)
                rafRef.current = 0
              }
              dropFirstFrame()
            }
          }
          // Viewer keep-alive: captureStream() only emits a frame when the canvas is DRAWN to, so a PAUSED clip
          // (no rVFC frames) would send ONE frame then go silent — a viewer whose decoder missed it (track just
          // negotiated / dropped keyframe) then stays BLACK with nothing to recover from. Redraw the current frame
          // at ~1fps so viewers always have a fresh frame to lock onto. Negligible CPU (1 small blit + a near-empty
          // static-frame encode per second) — the same 1fps keep-alive the audio "Now playing" card uses below.
          imgTimerRef.current = window.setInterval(draw, 1000)
          const stream = canvas.captureStream()
          vtrack = stream.getVideoTracks()[0]
          imgStreamRef.current = stream
        }
      }

      if (!vtrack) {
        // AUDIO (no picture): a "🎵 Now playing" canvas card stands in for the stage video.
        const canvas = document.createElement('canvas')
        canvas.width = 1280
        canvas.height = 720
        const cx = canvas.getContext('2d')
        const draw = () => {
          if (!cx) return
          cx.fillStyle = '#0d1117'
          cx.fillRect(0, 0, 1280, 720)
          cx.fillStyle = '#e6edf3'
          cx.font = '600 64px system-ui, sans-serif'
          cx.textAlign = 'center'
          cx.textBaseline = 'middle'
          cx.fillText('🎵 Now playing', 640, 360)
        }
        draw()
        const card = canvas.captureStream(1)
        imgTimerRef.current = window.setInterval(draw, 1000) // keep the card emitting
        vtrack = card.getVideoTracks()[0]
        imgStreamRef.current = card
      }
      if (vtrack && (await call.shareTrack(vtrack))) {
        if (atrack) call.publishShareAudio(atrack) // the clip's sound → the 2nd audio lane
        call.setMeta({ stageImage: stageImageKey(stagedKeyRef.current) }) // doodles bind per media
        setPresentingImage(true)
        stagePlayingRef.current = false // starts paused
        broadcastStageState() // tell viewers a controllable clip is staged (+ allow/playing) → they show a ⏯
      }
    } catch {
      /* capture/publish failed — leave the stage untouched */
    }
  }, [call, broadcastStageState])
  // OPTION 1 placeholder: capture a LOW-FPS, downscaled POSTER of the staged video onto the share lane — NOT the
  // full video (that plays locally on every peer). This keeps us the "presenter" so everyone's stage layout lights
  // up, and gives a peer that lacks the file a cheap ~1fps preview. No audio (each peer plays its own copy's sound).
  const captureStagePoster = useCallback(async () => {
    const v = imgElRef.current
    if (!v || imgStreamRef.current) return
    try {
      const w = v.videoWidth || 0
      const h = v.videoHeight || 0
      if (!(w > 0 && h > 0)) return // no video track — nothing to put on the share lane (audio uses the legacy path)
      const MAX = 640
      const scale = Math.min(1, MAX / Math.max(w, h))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(2, Math.round(w * scale))
      canvas.height = Math.max(2, Math.round(h * scale))
      const cx = canvas.getContext('2d')
      const draw = () => {
        try {
          cx && cx.drawImage(v, 0, 0, canvas.width, canvas.height)
        } catch {
          /* frame not ready — the next tick redraws */
        }
      }
      draw()
      const stream = canvas.captureStream(1) // 1 fps — a tiny placeholder/preview, not the real video
      imgStreamRef.current = stream
      imgTimerRef.current = window.setInterval(draw, 1000)
      const track = stream.getVideoTracks()[0]
      if (track && (await call.shareTrack(track))) {
        call.setMeta({ stageImage: stageImageKey(stagedKeyRef.current) }) // doodles bind per staged media
      } else {
        teardownCapture()
      }
    } catch (e) {
      teardownCapture()
      // eslint-disable-next-line no-console
      console.warn('[kibitz] could not stage poster', e)
    }
  }, [call, teardownCapture])
  // #2: the authority's share-lane capture — the REAL video while a follower still lacks its copy, else the cheap
  // 1fps poster. onPoster (onCanPlay) and the switch effect both go through this so they always agree on the mode.
  const captureStageForOpt1 = useCallback(() => (allHaveRef.current ? captureStagePoster() : captureStagedVideo()), [captureStagePoster, captureStagedVideo])
  const captureStageForOpt1Ref = useRef(captureStageForOpt1)
  captureStageForOpt1Ref.current = captureStageForOpt1
  // Re-capture in the new mode when readiness flips. Followers WITH the copy are already on their OWN local element
  // (not the share lane), so the swap is invisible to them — only our upstream changes (full video ↔ tiny poster).
  useEffect(() => {
    if (!opt1Authority) return
    teardownCapture()
    const v = imgElRef.current
    if (v && v.readyState >= 2) void captureStageForOpt1Ref.current()
    // else: the authority element's onPoster (onCanPlay) captures once it's ready
    // Depend ONLY on the real mode inputs. captureStageForOpt1/teardownCapture are rebuilt every render (via the
    // per-render `call`), so listing them made this fire on EVERY render → teardown + an async re-capture each time;
    // the racing async captures leaked orphaned canvases/streams/setIntervals (Chrome memory growth) and never gave
    // a follower a stable share track (the stage looked blank on the other side). Called through a ref so it stays current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opt1Authority, allFollowersHaveStage])
  const presentMedia = useCallback(
    async (src: string, key: string, playable: boolean, opts?: { skipStageMeta?: boolean; kind?: 'image' | 'video' | 'audio' }) => {
      if (!src) return
      // FULLY reset any current stage first — not just the capture machinery, but the share lane + the
      // presenting flag too. Without stopShare(), re-staging (esp. video → image) left the prior share track
      // and state behind, so the new media never took the stage. teardown → stopShare → clear the flag.
      teardownCapture()
      call.stopShare()
      setPresentingImage(false)
      setStagedImageSrc(null)
      stagedKeyRef.current = key
      if (playable) {
        // Render a controlled <video> (it plays audio files too). What captures/shares is branched on stageOpt1 by
        // the rendered overlay's onCanPlay:
        //  • OPTION 1 (a VIDEO with a stable cross-peer key) → each peer renders its OWN local copy (full quality);
        //    we share only a low-fps poster (captureStagePoster) and advertise the file in our meta so followers
        //    open their copy. The timeline broadcast keeps everyone in lockstep.
        //  • else (audio, or a video we can't resolve locally) → the legacy streamed path (captureStagedVideo).
        setStagedVideoSrc(src)
        // OPTION 1 gated OFF (STAGE_OPT1=false): no cross-peer mid is resolved, so this falls to the streamed
        // fallback (captureStagedVideo) — the presenter renders the local <video> and shares it; viewers watch.
        const mid = STAGE_OPT1 && opts?.kind === 'video' ? call.chat.find((it) => it.attachment?.xid === key || it.mid === key)?.mid : undefined
        if (mid) {
          if (!opts?.skipStageMeta) call.setMeta({ stageMedia: mid })
          stagedMidRef.current = mid
          setStageOpt1(true)
        } else {
          stagedMidRef.current = undefined
          setStageOpt1(false)
        }
        return
      }
      setStagedVideoSrc(null)
      setStagedImageSrc(src) // presenter renders THIS local <img> on the stage NOW — robust, works alone.
      setPresentingImage(true) // an image is staged (locally) → Stop + off-stage logic key off this, share or not.
      try {
        const img = new Image()
        img.src = src
        await img.decode()
        // Clamp the canvas to a sane size: a full-res phone photo (e.g. 3024×4032) can blow iOS canvas /
        // captureStream limits → throw. 1920 long edge is plenty.
        const MAX = 1920
        const nw = img.naturalWidth || 1280
        const nh = img.naturalHeight || 720
        const scale = Math.min(1, MAX / Math.max(nw, nh))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(2, Math.round(nw * scale))
        canvas.height = Math.max(2, Math.round(nh * scale))
        const cx = canvas.getContext('2d')
        const draw = () => cx && cx.drawImage(img, 0, 0, canvas.width, canvas.height)
        draw()
        const stream = canvas.captureStream(1) // 1 fps still
        imgStreamRef.current = stream
        imgTimerRef.current = window.setInterval(draw, 1000) // keep the still emitting
        const track = stream.getVideoTracks()[0]
        // A staged image is STATIC detail, not motion. Without this hint the encoder treats the 1fps canvas as
        // ordinary video and trades away spatial resolution → a blurry stage. 'detail' tells it to preserve
        // sharpness over framerate (the WebRTC lever for legible screen/image share). Ignored where unsupported.
        if (track) track.contentHint = 'detail'
        // Best-effort SHARE so OTHER participants get the stage. The presenter already sees the local <img>, so a
        // refused/absent share (e.g. no peer) no longer blanks the presenter's stage — it just means no viewers.
        if (track && (await call.shareTrack(track))) {
          // doodles bind per image. skipStageMeta: the AGENT's stageMedia owns this key via its own applyMeta
          // (the painter's imageKey), so we don't clobber it here (presentMedia's setMeta fires after the await).
          if (!opts?.skipStageMeta) call.setMeta({ stageImage: stageImageKey(key) })
        } else {
          teardownCapture() // publish refused → drop the canvas stream; the local <img> stays (viewers just miss it)
        }
      } catch (e) {
        // Decode/capture failed → the local render would be broken, so clear it + stop.
        teardownCapture()
        setStagedImageSrc(null)
        setPresentingImage(false)
        // eslint-disable-next-line no-console
        console.warn('[kibitz] could not stage image', e)
      }
    },
    [call, teardownCapture],
  )
  // Press Stage on a widget (chart/table/diagram): snapshot its rendered node to a PNG and stage it through the SAME
  // image path (presenter renders + shares; viewers, incl. late joiners, watch — no per-peer data render needed).
  // Returns false if the snapshot fails (WidgetBubble then falls back to the per-peer pointer path).
  const stageWidgetPixels = useCallback(
    async (node: HTMLElement, id: string): Promise<boolean> => {
      const png = await widgetNodeToPng(node)
      if (!png) return false
      await presentMedia(png, `widget-${id}`, false, { kind: 'image' })
      return true
    },
    [presentMedia],
  )
  // The agent's "press Stage": stage media it LOADED through the SAME human path a person uses (presentMedia) —
  // NOT a parallel agent lane (the old screen→bare-shareTrack / tile→publishVideoTrack). {mime,data:base64};
  // video/audio → playable, else an image. A stable key from the bytes binds doodles per image, mirroring the
  // human's per-chat-item keyId. So the agent inherits off-stage (stopImagePresent), the overlay, viewer ctl.
  const stageMedia = useCallback(
    (p: { mime?: string; data?: string } | null) => {
      if (!p || !p.data) return
      const mime = p.mime || 'image/png'
      // skipStageMeta: a tile/screen-staging agent (the painter) sets the stageImage doodle key itself (its own
      // imageKey, synchronously) — let it own that key rather than this path overwriting it after the share await.
      void presentMedia(`data:${mime};base64,${p.data}`, `agent-${p.data.length}-${p.data.slice(0, 24)}`, /^(video|audio)\//i.test(mime), { skipStageMeta: true })
    },
    [presentMedia],
  )
  // Speaker-off (deaf) silences the presenter's OWN staged-video sound — LOCAL output only; the SHARE keeps full
  // volume so peers still hear it. Native path: mute the element (captureStream is independent). iOS path: the
  // element's audio is routed through Web Audio, so the element's `muted` is moot — mute the LOCAL gain instead
  // (the share's MediaStreamDestination tap stays full). deafRef lets the capture path read the current state.
  useEffect(() => {
    deafRef.current = deaf
    if (localGainRef.current) localGainRef.current.gain.value = deaf ? 0 : 1
    else if (imgElRef.current) imgElRef.current.muted = deaf
  }, [deaf, stagedVideoSrc])
  // Inbound control: a presenter's stage broadcast → mirror it (drives the viewer ⏯); a viewer's toggle request →
  // play/pause OUR staged clip, unless we've suppressed viewer control.
  useEffect(
    () =>
      call.onCtl((from, m) => {
        const d = m as { t?: string; cmd?: string; on?: boolean; playing?: boolean; time?: number; dur?: number }
        if (d?.t === 'stage') setStageXport(d.on ? { from, playing: !!d.playing, time: Number(d.time) || 0, dur: Number(d.dur) || 0 } : null)
        else if (d?.t === 'stagecmd') {
          // A viewer is driving OUR stage. `offstage` works for ANY staged content (image OR video) — it takes the
          // stage down for everyone, so it must NOT be gated on the video element (else a viewer's Stop on an IMAGE
          // was silently dropped). play/pause/seek DO need the master <video>, so keep those gated on imgElRef.
          if (d.cmd === 'offstage') stopImagePresent()
          else if (imgElRef.current) {
            // We hold the master <video>. Everyone has control — apply directly, then our onPlay/onPause/onTimeUpdate
            // re-broadcast the new transport so every bar re-syncs.
            const v = imgElRef.current
            if (d.cmd === 'play') void v.play().catch(() => {})
            else if (d.cmd === 'pause') v.pause()
            else if (d.cmd === 'seek' && Number.isFinite(d.time)) v.currentTime = Math.max(0, Number(d.time))
          }
        }
      }),
    [call, stopImagePresent],
  )
  // (Retired: the per-presenter "viewers can control" suppress toggle — everyone controls the stage now.)
  // Re-broadcast our stage state when the roster changes, so a late joiner learns it (the channel is ephemeral).
  useEffect(() => {
    if (stagedVideoSrc) broadcastStageState()
  }, [call.participants.length, stagedVideoSrc, broadcastStageState])
  // OPTION 1 heartbeat: the authority re-broadcasts the timeline every ~1.5s, so a follower that missed a press
  // (backgrounded / stalled / just joined) self-heals to within a beat. The event-driven broadcasts cover the rest.
  useEffect(() => {
    if (!opt1Authority) return
    const t = window.setInterval(() => broadcastStageState(), 1500)
    return () => window.clearInterval(t)
  }, [opt1Authority, broadcastStageState])
  // A chat image / video / audio bubble. Its Stage / Save actions reveal on HOVER (CSS) and auto-hide on leave —
  // no buttons cluttering the media. keyId = the message/transfer id; `kind !== 'image'` → the Stage path plays it.
  // Swipe the video left/right (touch only) to flip between Speaker and Gallery — the phone-native way
  // to switch layouts. Recorded on the stage area; the filmstrip (which scrolls horizontally) opts out.
  const swipeRef = useRef<{ x: number; y: number; t: number } | null>(null)
  // While a finger is down on the stage we suppress the chrome auto-REVEAL (so a swipe to change layout
  // doesn't pop the bars up). On lift we reveal ONLY if it was a tap, not a swipe. revealChromeRef is
  // set by the auto-hide effect so we can trigger that tap-reveal from here.
  const swipeActiveRef = useRef(false)
  const revealChromeRef = useRef<(() => void) | null>(null)
  const onStageSwipeDown = useCallback((e: React.PointerEvent) => {
    const skip = e.pointerType === 'mouse' || !!(e.target as HTMLElement).closest('.kw-faces')
    swipeRef.current = skip ? null : { x: e.clientX, y: e.clientY, t: e.timeStamp }
    swipeActiveRef.current = !skip // hold off the auto-reveal until we know tap vs swipe
  }, [])
  const onStageSwipeUp = useCallback(
    (e: React.PointerEvent) => {
      const s = swipeRef.current
      swipeRef.current = null
      const wasGesture = swipeActiveRef.current
      swipeActiveRef.current = false
      if (!s) return
      const dx = e.clientX - s.x
      const dy = e.clientY - s.y
      // A quick, mostly-horizontal flick — not a tap, not a vertical scroll. Left (dx<0) advances.
      const flick = e.timeStamp - s.t < 600 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.6
      // A shared screen owns the stage + any zoom-pan — never turn a flick over it into a layout change.
      // Car mode has no stage, so swiping out of it is always fine.
      const stageOwned = presenter && view !== 'car'
      if (flick && !stageOwned) {
        cycleView(dx < 0 ? 1 : -1) // a swipe: change layout, do NOT reveal the bars
        return
      }
      // Otherwise a near-stationary press is a TAP → reveal the chrome. This now works WITH a presenter
      // too (the only way to bring the bars back over a shared screen); a drag/pan won't trigger it.
      if (wasGesture && Math.abs(dx) < 12 && Math.abs(dy) < 12) revealChromeRef.current?.()
    },
    [presenter, view, cycleView],
  )
  // Pinch-to-zoom + pan a shared screen (local view only — magnify small text the
  // way you'd pinch a photo). Wired only while a presenter owns the stage; an active
  // ink tool sits on top and takes the touches, so drawing wins without coordination.
  const zoom = useStageZoom(stageRef, !!presenter && !preview, presenter?.id)
  // The ink toolbar is portalled OUT of the stage into this slot (beside the tiles): the
  // stage's touch-action:none + zoom listeners swallow taps to its children on iOS.
  const [inkSlot, setInkSlot] = useState<HTMLElement | null>(null)
  // True while a pen/laser tool is active — pins the auto-hiding chrome so the toolbar stays reachable
  // while you annotate (StageInk reports it via onActiveChange; cleared when the overlay unmounts).
  const [inkActive, setInkActive] = useState(false)
  // Replay all our media elements. Recovers two cases: iOS/Safari refusing autoplay until a gesture
  // (the Join tap already unlocked the audio session, so this just retries silently — no useless
  // "tap to enable sound" prompt), and PiP moving media across documents (which pauses it).
  const unlock = useCallback(() => {
    tilesRef.current?.querySelectorAll<HTMLMediaElement>('video, audio').forEach((el) => {
      el.play().catch(() => {})
    })
  }, [])
  const onBlocked = unlock // handed to every tile: a blocked element silently retries instead of nagging
  // The autoJoin gesture-gate tap (see `needsGesture`): unlock the audio session IN this real user gesture, replay any
  // already-mounted media, then join. This is the single tap iOS/mobile needs so the agent's voice actually plays.
  const gestureJoin = useCallback(() => {
    unlockAudioCtx()
    unlock()
    setNeedsGesture(false)
    void call.join().then((ok) => {
      if (ok) call.toggleMic() // open the mic in this SAME tap — iOS grants getUserMedia off the gesture, so the caller is
      // live from the start (no separate "tap to unmute"). If the mic permission is denied, micOn stays false and the
      // unmute nudge below reappears as the fallback.
      else setAutoJoinFailed(true)
    })
  }, [unlock, call.join, call.toggleMic])

  // Copy the room's invite link mid-call, so you can pull someone in without
  // leaving the video. The current page URL IS the room — the kibitz.chat room
  // page, or the host page that mounted us (it carries ?room=/#room or the
  // page-derived room). `location` stays the opener's URL even when popped out
  // into a PiP window, so the link is always the real one.
  const [copied, setCopied] = useState(false)
  const copyInvite = useCallback(async () => {
    try {
      const link = inviteLink ? await inviteLink() : location.href
      await navigator.clipboard.writeText(link)
    } catch {
      /* clipboard blocked — the address bar still holds the link */
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }, [inviteLink])

  // Invite panel: a scannable QR of the room link (+ copy), so someone next to you joins by pointing
  // their phone camera at it — no typing. The link is resolved when the panel opens (it may be async —
  // a WhatsApp-friendly /j link or a TURN-grant link). The QR is drawn locally; the link never leaves
  // the device.
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteUrl, setInviteUrl] = useState('')
  const toggleInvite = useCallback(() => {
    setInviteOpen((o) => {
      const next = !o
      if (next) {
        void (async () => {
          try {
            setInviteUrl(inviteLink ? await inviteLink() : location.href)
          } catch {
            setInviteUrl(location.href)
          }
        })()
      }
      return next
    })
  }, [inviteLink])

  // (Removed: the auto-pop of the invite panel at the pre-join for the agent summoner. It was intrusive — the
  // pre-join "Invite others" button is the entry point now, given a blue-outline emphasis so it's easy to find.)

  // Close the invite panel the moment you enter the call (pressing Join) — the pre-join "invite others" prompt
  // shouldn't linger into the call. Fires only on the transition to in-call; reopening it mid-call still works.
  useEffect(() => {
    if (call.inCall) setInviteOpen(false)
  }, [call.inCall])

  // Connect the data room lazily — only once the visitor opens the widget.
  // (Don't claim rooms on behalf of every passerby who merely loads the page.)
  useEffect(() => {
    if (!open || room) return
    if (preview) {
      // Landing demo: a NO-OP room (never dials the broker). Joining shows your
      // own self-view only — no peers — via previewMedia. Nothing on the wire.
      const r: AnyRoom = {
        link: { setSelf() {}, onRoster() {} },
        status: () => 'connected',
        onChange: () => {},
        close: () => {},
      }
      setRoom(r)
      return
    }
    if (offline) {
      // Multi-room relay: scope this LAN call to the room name, so ONE relay (one hosting phone) can carry
      // several independent offline calls at once. Same name → same room; an old single-room relay ignores it.
      const r = joinLanRoom(roomName)
      lanRef.current = r
      r.onChange(() => bump((n) => n + 1))
      setRoom(r)
    } else {
      // Resolve the shared broker choice (our healthy worker, else the public
      // PeerJS broker) BEFORE claiming — one answer for everyone, so a call never
      // splits across two brokers. Also fetch ICE servers so the DATA connection
      // can relay through TURN, not just media: without a relay, iOS Safari can't
      // form the direct link until camera/mic permission is granted (it restricts
      // host candidates to mDNS, which fails cross-browser on a LAN). Guard against
      // unmount mid-fetch.
      let cancelled = false
      // When verified identity is on, pin ONE cert (presence + media) so a single
      // token gates the authority AND verifies peer-to-peer, and build the authority's
      // injected, OIDC-agnostic verifier (fail-closed, salted by room).
      const vid = verifyIdentityRef.current
      // A link-driven gate (signed invites / name list) — the "link is everything" path. Its
      // verifier is rebuilt purely from the descriptor in the link (no cert, no stored state),
      // so we resolve it alongside the broker/ICE. Google (vid) and link gates are exclusive.
      const lgate = joinGateRef.current
      const linkGated = !vid && !!lgate && lgate.mode !== 'open' && lgate.mode !== 'google'
      // Agent-key admission needs the SAME pinned cert even with NO human OIDC (an agent-only /
      // agents-gated room). An agent proves its committed key with a cert-bound assertion, so the
      // authority must read the very cert the agent signed over — which means BOTH peers pin one
      // shared cert on presence. Pin it when: the room committed a signed manifest (the AUTHORITY
      // side), OR this is a HEADLESS peer (the agent runtime — it presents a key AFTER mount via
      // provideAgentKey, and its OWN url carries no manifest, so `mayGateAgents` is false for it;
      // without pinning here its presence cert wouldn't match the assertion it signs → silent hold).
      const mayGateAgents = !!(lgate?.manifest && lgate?.pubKey) || !!headless
      void Promise.all([
        chooseSignal(),
        // The PRESENCE peer carries the roster over a single connect-time ICE config — on a fresh CELLULAR page
        // load the TURN credentials may not be cached yet, leaving it STUN-only (no relay candidate) so it can
        // never reach a live host across 4G/CGNAT (the confirmed "client connecting forever, host sees roster 1"
        // case). Warm first so a real relay is in the config; warmIceServers returns instantly once cached, so it
        // only adds latency on a genuinely-slow first fetch — and reliability there is exactly the point.
        warmIceServers(4).then(() => getIceServers()),
        vid || mayGateAgents ? generatePinnedCert() : Promise.resolve(null),
        linkGated ? gateVerifierFor(lgate, roomKey) : Promise.resolve(null),
        // Deterministic openHumans: derive it from the SAME manifest that drives the gate, in the SAME async
        // chain that builds the room — so it can't lose the race against the separate manifest-verify effect
        // (which set a ref the room reads ONCE at build time, latching openHumans:false → the agent-room "split
        // roster": every credential-less human dropped at the authority gate, only the agent rostered). agentKeys
        // survives the race because it's read LIVE via a ref at verify-time; openHumans is read once, so resolve it here.
        lgate?.manifest && lgate?.pubKey
          ? importInvitePublicKey(lgate.pubKey)
              .then((pub) => verifyManifest(lgate.manifest!, pub, { room: roomKey, now: Math.floor(Date.now() / 1000) }))
              .then((mv) => mv.ok && humansOpenForManifest(mv.manifest))
              .catch(() => false)
          : Promise.resolve(false),
      ]).then(([peer, iceServers, cert, linkVerify, openHumansNow]) => {
        if (cancelled) return
        // ALWAYS hand ICE our full menu (STUN + TURN) so it can CYCLE host→srflx→relay and is NEVER left
        // host-only. Previously this was gated on hasTurn — and when /api/turn was momentarily empty the presence
        // peer fell back to PeerJS's dead default servers → host-only → "join alone" on 4G. iceConfig now reuses
        // TURN creds across a network change, so `iceServers` almost always carries a real relay; on the rare
        // STUN-only moment, attaching it is still strictly better than PeerJS's defaults.
        const hasTurn = iceServers.some((s) => /turn:/i.test([s.urls].flat().join(' ')))
        const config: RTCConfiguration = {}
        if (iceServers.length) config.iceServers = iceServers
        if (cert) config.certificates = [cert]
        // Privacy (Layer 3): force the PRESENCE peer through the relay too, so the authority (a
        // peer) never sees the joiner's IP either — relay-only must cover both meshes to mean
        // anything. Fail-closed: no reachable TURN ⇒ no relay candidates ⇒ no connection (no leak).
        // relayOnly (privacy) forces relay regardless (fail-closed by design). FORCE_RELAY (reliability baseline)
        // also forces the presence peer to relay — but ONLY when real TURN is present, so it never fail-closes a
        // call that has no relay. This is what lets the presence peer reach the authority on 4G/CGNAT (skip the
        // direct-first dance that times out → "join alone after a WiFi→4G switch").
        if (relayOnlyRef.current || (forceRelay() && hasTurn)) config.iceTransportPolicy = 'relay'
        const peerCfg = Object.keys(config).length ? { ...(peer ?? {}), config } : peer
        // Verified-roster (docs §7): when the link committed a roster, IT is the authority's
        // allow-list (not the host's editable guest list) and `require` is forced on — so the
        // door admits only listed members. The same members drive the peer-to-peer mutual
        // gate (passed to useCall), so admission and pre-share verification share one roster.
        // Network-access credit gate (default OFF). When configured, DECLARED agents must present a
        // valid credit credential; it composes onto whichever human/link gate is (or isn't) present.
        const creditOpt = creditGateOption(agentCreditsRef.current)
        const wantCreditGate = !!creditOpt
        const gate =
          vid && cert
            ? {
                require: rosterMembersRef.current || rosterDomainsRef.current ? true : requireRef.current,
                requireAgentCredits: wantCreditGate,
                // Wrap the human verifier with the agent branch: a pre-authorized agent enters by
                // its key. room.ts runs this even when `require` is false (open for people) as long
                // as a gate is present — so "open for humans, pre-authorized agents" + agent-only
                // rooms both work; the agent assertion is cert-bound regardless of bindsFingerprint.
                verify: withAgentGate(
                  makeGateVerify(
                    vid,
                    roomKey,
                    () => rosterMembersRef.current ?? guestEmailsRef.current,
                    () => rosterDomainsRef.current ?? [],
                    () => acceptProvidersRef.current,
                  ),
                  roomKey,
                  () => agentKeysRef.current,
                  (fp, caps) => agentCapsByFpRef.current.set(fp, caps),
                  creditOpt,
                ),
                openHumans: openHumansNow, // agent-only room ⇒ admit credential-less humans (deterministic, not the racy ref)
              }
            : linkVerify
              ? {
                  require: true,
                  requireAgentCredits: wantCreditGate,
                  verify: withAgentGate(linkVerify, roomKey, () => agentKeysRef.current, (fp, caps) => agentCapsByFpRef.current.set(fp, caps), creditOpt),
                  bindsFingerprint: false,
                  openHumans: openHumansNow, // agent-only invite room ⇒ humans open, agent gated by key (deterministic)
                } // invites/names don't bind the cert
              : wantCreditGate
                ? {
                    // Credit-only room: OPEN for humans (require:false), but a declared agent must pay.
                    // The credit credential isn't cert-bound in v1 → bindsFingerprint:false so a
                    // credit-only agent (no cert-bound assertion) isn't held waiting for a fingerprint.
                    require: false,
                    requireAgentCredits: true,
                    verify: withAgentGate(
                      () => Promise.resolve({ ok: true }),
                      roomKey,
                      () => agentKeysRef.current,
                      (fp, caps) => agentCapsByFpRef.current.set(fp, caps),
                      creditOpt,
                    ),
                    bindsFingerprint: false,
                  }
                : undefined
        const r = joinRoom(roomName, {
          peer: peerCfg,
          identity,
          ...(gate ? { gate } : {}),
          ...(joinGateRef.current?.hostPubKey ? { hostKey: joinGateRef.current.hostPubKey } : {}),
          ...(!joinGateRef.current?.hostPubKey && joinGateRef.current?.hostName
            ? { hostName: joinGateRef.current.hostName }
            : {}),
          ...(!joinGateRef.current?.hostPubKey && joinGateRef.current?.hostEmail
            ? { hostEmail: joinGateRef.current.hostEmail }
            : {}),
          ...(joinGateRef.current?.lobbyOnStart ? { lobbyOnStart: true } : {}),
        })
        r.onChange(() => bump((n) => n + 1))
        if (cert) setSharedCert(cert)
        setRoom(r)
      })
      return () => {
        cancelled = true
      }
    }
  }, [open, room, roomName, offline, preview, identity])
  useEffect(() => () => room?.close(), [room])

  // Keep the room authority's identity gate in sync with the live "verified only" toggle
  // (Google mode only — a link gate's `require` is fixed true and must not be flipped off
  // by this Google-specific toggle). No-op on preview/LAN rooms (no setRequireVerified).
  useEffect(() => {
    if (verifyIdentity) room?.link.setRequireVerified?.(requireVerified)
  }, [room, requireVerified, verifyIdentity])

  // Present our OWN credential (the invite token from the link) at the door, so the
  // authority verifies us right away. setIdentityToken re-announces, so ordering is safe.
  useEffect(() => {
    if (joinCredential) room?.link.setIdentityToken?.(joinCredential)
  }, [room, joinCredential])

  // Leaving on PURPOSE (the ✕, the host removing us, an embedder calling leave) means
  // "I'm done" — forget the rejoin intent so a later reload doesn't drag us back in.
  // A reload/crash, by contrast, never runs this, so the stamped intent survives.
  // A brand-gated "return home" URL: if the room link carried `back=<url>` (e.g. the gift dashboard the caller
  // launched from) and the host is allowlisted for THIS build, leaving the call navigates back there instead of
  // dumping the caller on the app's pre-join screen. Read once; open-redirect-safe (safeReturnUrl).
  const returnUrl = useMemo(() => {
    try {
      const back = splitRoomHash(location.hash).params.get('back') ?? new URLSearchParams(location.search).get('back')
      return safeReturnUrl(back, brand.returnHosts)
    } catch {
      return null
    }
  }, [])
  // While we redirect to the return URL the browser keeps showing THIS document until the destination loads —
  // and `call.leave()` has already re-rendered us to the pre-join screen. That's the "flash of the app's own
  // homepage before it jumps to the dashboard". `returning` paints a full-cover splash the instant we start
  // leaving, so the pre-join never shows and the transition reads as one clean hop to the back-link.
  const [returning, setReturning] = useState(false)
  const returnHome = useCallback(() => {
    if (!returnUrl) return false
    setReturning(true) // cover the panel NOW, before any re-render to the pre-join screen
    window.setTimeout(() => window.location.assign(returnUrl), 150) // let the leave signal flush, then hop
    return true
  }, [returnUrl])
  const leaveCall = useCallback(() => {
    clearInCall()
    returnHome() // splash up first (if a return URL is set) so the pre-join doesn't flash behind the redirect
    call.leave()
  }, [call.leave, returnHome])

  // Idle-nudge: after 5 min with no screen engagement, ask "still there?"; if unanswered for a minute, opt out of
  // the call. Per-call disable via the prompt's "don't ask again" (nudgeOff). Inert in preview and before joining.
  const [nudgeOff, setNudgeOff] = useState(false)
  const idle = useIdleNudge({ enabled: call.inCall && !preview && !nudgeOff, onLeave: leaveCall, activity: call.chat })

  // Car / OS media controls → the call. Bind the mediaSession actions so a head unit's hang-up / stop /
  // pause ENDS the call (full leaveCall, so the rejoin intent is cleared and it can't zombie back), and
  // its mic / camera buttons toggle. On iOS a WebRTC call doesn't claim the OS "Now Playing" session, so
  // the car's transport controls never reach us — we play a SILENT looped clip to claim it (kicked off
  // the join gesture's activation; retried on the next tap if iOS deferred it).
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    if (!call.inCall) {
      ms.metadata = null
      try {
        ms.playbackState = 'none'
      } catch {
        /* ignore */
      }
      return
    }
    let audioEl: HTMLAudioElement | null = null
    // The Now-Playing claim is iOS-only, and only while MUTED. A live mic makes iOS route a phone call
    // (HFP / phone panel); if the silent clip is also claiming a MEDIA session (A2DP / Kibitz panel) at
    // the same time the car flickers between them. So: muted → claim the media panel (pause-to-end);
    // talking → drop it and let it be a clean phone call. One clean switch per mute/unmute, no flicker.
    const url = isIOS() && !call.micOn ? getSilentClipUrl() : null
    if (url) {
      audioEl = new Audio(url)
      audioEl.loop = true
      const tryPlay = () => void audioEl?.play().catch(() => {})
      tryPlay()
      // iOS may defer the first play if the join gesture's activation lapsed — retry once on the next tap.
      const onTap = () => {
        tryPlay()
        host?.removeEventListener('pointerdown', onTap)
      }
      host?.addEventListener('pointerdown', onTap, { once: true })
    }
    try {
      ms.metadata = new MediaMetadata({ title: `${brandName} call`, artist: roomName ? `Room ${roomName}` : 'In a call' })
    } catch {
      /* MediaMetadata unsupported */
    }
    try {
      ms.playbackState = 'playing'
    } catch {
      /* ignore */
    }
    const ACTIONS = ['hangup', 'stop', 'pause', 'play', 'togglemicrophone', 'togglecamera'] as const
    const bind = (action: string, handler: (() => void) | null) => {
      try {
        ms.setActionHandler(action as MediaSessionAction, handler)
      } catch {
        /* this action isn't supported in this browser — fine */
      }
    }
    bind('hangup', () => leaveCall()) // dedicated VoIP end-call (steering-wheel / head-unit hang-up)
    bind('stop', () => leaveCall())
    bind('pause', () => leaveCall())
    bind('play', () => {
      try {
        ms.playbackState = 'playing'
      } catch {
        /* ignore */
      }
      void audioEl?.play().catch(() => {})
    })
    // Car head-unit mic/camera buttons → toggle. NOT on iOS: a backgrounding iOS PWA auto-FIRES
    // `togglecamera`/`togglemicrophone` as a system privacy action, and obeying it toggles the user's camera
    // OFF + mutes the mic (setting camRef/micRef false), which then defeats the foreground revive. Off iOS,
    // the camera/mic survive backgrounding anyway; on iOS, letting the track simply END (revive re-acquires it
    // on return) is the correct path. (CarPlay/Bluetooth fire play/pause, not these VoIP toggles, so nothing real is lost.)
    if (!isIOS()) {
      bind('togglemicrophone', () => void call.toggleMic())
      bind('togglecamera', () => void call.toggleCam())
    }
    return () => {
      ACTIONS.forEach((a) => bind(a, null))
      if (audioEl) {
        audioEl.pause()
        audioEl.src = ''
      }
    }
  }, [call.inCall, call.micOn, roomName, leaveCall, call.toggleMic, call.toggleCam, host])

  // The host can remove us: when that lands, leave the call and show the removed
  // overlay. `leave` is read through a ref so the subscription is per-room, not
  // per-render. A new room starts with a clean slate.
  const leaveRef = useRef(leaveCall)
  leaveRef.current = leaveCall
  useEffect(() => {
    setKicked(false)
    room?.onKicked?.(() => {
      setKicked(true)
      leaveRef.current()
    })
  }, [room])

  // Remember we're in this call so a reload can bring us back. Stamp on join and keep
  // it fresh on a heartbeat — so even a long call rejoins after a refresh, while a tab
  // reopened much later (past the TTL) does not. Cleared on an explicit Leave/removal.
  useEffect(() => {
    if (preview || headless || !call.inCall) return
    markInCall(roomName, Date.now())
    const id = setInterval(() => markInCall(roomName, Date.now()), 20_000)
    return () => clearInterval(id)
  }, [call.inCall, roomName, preview, headless])

  // A host who locks/refuses us isn't somewhere to keep retrying — drop the intent so
  // a reload doesn't loop straight back into the closed door, and dismiss the rejoin
  // affordance so a later return to the lobby doesn't show stale "you were just here".
  useEffect(() => {
    if (lobbyStatus === 'locked' || lobbyStatus === 'denied') {
      clearInCall()
      setRejoinDismissed(true)
    }
  }, [lobbyStatus])

  // Auto-rejoin: once the room is live again after a reload, silently rejoin — the
  // same muted/camera-off, no-prompt path as a normal join. iOS Safari needs a user
  // gesture to grab the mic at join, so there we DON'T auto-fire it; the lobby shows a
  // one-tap "Rejoin" button instead (that tap is the gesture). Fires at most once; a
  // failed attempt falls back to the lobby so the user can retry by hand.
  useEffect(() => {
    if (!wantRejoin || autoJoinedRef.current) return
    if (!room || call.inCall || kicked || lobbyStatus || isIOS()) return
    autoJoinedRef.current = true
    void call.join().then((ok) => {
      if (!ok) setRejoinDismissed(true)
    })
  }, [wantRejoin, room, call.inCall, call.join, kicked, lobbyStatus])

  // Before we're in the call, keep the host's knock list showing our real name —
  // the remembered/typed name, not 'Guest'. Seeds the buffer so the connect-time
  // knock carries it, then re-introduces us live as the name changes. No-op when
  // the lobby is off and for the host itself; once in the call the roster carries
  // the name, so we stop (avoids redundant re-knocks).
  useEffect(() => {
    if (!room?.knock || call.inCall) return
    room.knock(name.trim(), call.avatar)
  }, [room, name, call.avatar, call.inCall])

  // Advertise ourselves as the presenter (in the roster meta) whenever our share
  // state flips — so every viewer's stage promotes us, and the browser's own "stop
  // sharing" clears it too. Newest presenter wins (presentAt above any current one);
  // merge with our existing meta so a host-set seat/userId survives.
  const partsRef = useRef(call.participants)
  partsRef.current = call.participants
  const lastSharingRef = useRef(false)
  useEffect(() => {
    if (call.sharing === lastSharingRef.current) return
    lastSharingRef.current = call.sharing
    const selfMeta = partsRef.current.find((p) => p.isSelf)?.meta ?? {}
    if (call.sharing) {
      const seq = partsRef.current.reduce((m, p) => Math.max(m, presentAtOf(p)), 0) + 1
      call.setMeta({ ...selfMeta, presenting: true, presentAt: seq })
    } else if (selfMeta.presenting) {
      call.setMeta({ ...selfMeta, presenting: false })
    }
  }, [call.sharing, call.setMeta])

  // Bumped off the stage: a DIFFERENT participant became the newest presenter while we still have a clip/image
  // staged. pickPresenter already moved the .kw-stage to them for everyone else, but our OWN .kw-staged-vid overlay
  // (+ image share) is only cleared by ✕ Off-stage / re-staging — so the bumped presenter kept seeing BOTH their
  // stale clip and the new presenter's stage. Drop ours here → "newest presenter wins" is truly exclusive.
  // Gate on `mine > 0 && presentAt(presenter) > mine`, NOT just "presenter isn't me": when you stage to TAKE OVER,
  // stagedVideoSrc is set immediately but our own presentAt only lands after the capture→share→meta round-trip, so
  // a bare !isSelf check would wipe our clip mid-takeover before we ever held the stage. The presentAt compare
  // closes that race — clear only once we were genuinely the presenter and someone strictly newer superseded us.
  useEffect(() => {
    if (!stagedVideoSrc && !presentingImage) return
    if (!presenter || presenter.isSelf) return
    const self = call.participants.find((p) => p.isSelf)
    const mine = self ? presentAtOf(self) : 0
    if (mine > 0 && presentAtOf(presenter) > mine) stopImagePresent()
  }, [presenter, stagedVideoSrc, presentingImage, call.participants, stopImagePresent])

  // Release the peripheral engines when the call ends. leaveCall tears down the mesh but NOT the machinery
  // Widget spun up, and Widget never unmounts — so on any inCall→false transition (Leave button, idle-nudge,
  // car hang-up, kick, drop) we must release it here or it keeps the CPU/audio/video engine awake on the idle
  // landing page: the staged-media capture rig (iOS canvas rAF, keep-alive interval, captured stream, Web-Audio
  // graph), the still-decoding staged <video>/<img>, and the PiP rig (12fps canvas capture + an off-screen
  // decode of the remote stream). Local-only teardown — no mesh calls (the mesh is already gone by now).
  const pipRelease = videoPip.release
  useEffect(() => {
    if (call.inCall) return
    teardownCapture()
    setStagedVideoSrc(null)
    setStagedImageSrc(null)
    setStagedIsAudio(false)
    setStageOpt1(false)
    setPresentingImage(false)
    stagedMidRef.current = undefined
    pipRelease()
  }, [call.inCall, teardownCapture, pipRelease])

  // --- Composable-engine bridge (Kibitz.mount controller) ---------------------
  // Bridge the live call up to the host page. The app channel rides the data mesh
  // (useCall), so attach the call's stable app methods; the controller snapshot/
  // controls are pushed whenever the call state changes.
  useEffect(() => {
    if (!bridge) return
    bridge.attach({
      sendApp: call.sendApp,
      onApp: call.onApp,
      onImage: call.onImage,
      onFile: call.onFile,
      sendAppTo: call.sendAppTo,
      registerSchema: call.registerSchema,
      getSchemas: call.getSchemas,
      onSchema: call.onSchema,
    })
    return () => bridge.detach()
  }, [bridge, call.sendApp, call.onApp, call.onImage, call.onFile, call.sendAppTo, call.registerSchema, call.getSchemas, call.onSchema])

  // join() with optional mic/cam: join muted/cam-off (the iOS-safe default), then
  // flip on what the caller asked for.
  const joinWith = useCallback(
    async (opts?: { mic?: boolean; cam?: boolean }) => {
      const ok = await call.join()
      // Await mic BEFORE cam: both rebuild/extend the self-preview stream, and
      // overlapping their getUserMedia awaits raced — the camera landed on an
      // orphaned stream while toggleMic rebuilt the live one, so YOUR own tile went
      // black (others saw you fine, since publishing is independent). Serialize them.
      if (ok && opts?.mic) await call.toggleMic()
      if (ok && opts?.cam) await call.toggleCam()
      return ok
    },
    [call.join, call.toggleMic, call.toggleCam],
  )

  // Stable lobby-control wrappers for the controller: hostLobby/room are rebuilt
  // every render, so read the latest through a ref — keeps the controls object (and
  // the setControls effect) from churning each render.
  const lobbyOpsRef = useRef({ hostLobby, room })
  lobbyOpsRef.current = { hostLobby, room }
  const setLobbyCtl = useCallback((on: boolean) => lobbyOpsRef.current.hostLobby.setLobby(on), [])
  const admitCtl = useCallback((id: string) => lobbyOpsRef.current.hostLobby.admit(id), [])
  const denyCtl = useCallback((id: string) => lobbyOpsRef.current.hostLobby.deny(id), [])

  // Removing a participant ALSO bans their verified email (if they signed in), so the
  // ban survives a fresh tab/connection — not just their ephemeral token. Read
  // identities through a ref so this callback stays stable.
  const identitiesRef = useRef(identities)
  identitiesRef.current = identities
  const removeParticipant = useCallback(
    (id: string) => {
      const email = identitiesRef.current[id]?.email?.toLowerCase()
      if (email) {
        setBannedEmails((prev) => {
          if (prev.has(email)) return prev
          const next = new Set(prev).add(email)
          saveBans(roomKey, next)
          return next
        })
      }
      lobbyOpsRef.current.hostLobby.remove(id)
    },
    [roomKey],
  )
  const removeCtl = removeParticipant

  // Auto-enforce email bans: while we're the host, kick anyone whose VERIFIED email is
  // banned (they re-verify a few seconds after joining, then get removed). Best-effort,
  // and only against people who sign in — a guest has no email (normal token kick).
  useEffect(() => {
    if (!hostLobby.isHost || bannedEmails.size === 0) return
    for (const p of call.participants) {
      if (p.isSelf) continue
      const email = identities[p.id]?.email?.toLowerCase()
      if (email && bannedEmails.has(email)) lobbyOpsRef.current.hostLobby.remove(p.id)
    }
  }, [call.participants, identities, bannedEmails, hostLobby.isHost])

  // OIDC host: once WE'RE the authority and a member's cert-bound verified email matches the committed
  // host email, mark them the host. Self first (the creator-as-host case), then any verified participant.
  // Signing in IS claiming — this fires as soon as getIdentity / selfIdentity resolves the email. The room
  // gates declareHost (slot-free + host-email committed), so repeated calls are a harmless no-op.
  useEffect(() => {
    if (!oidcHostEmail || !room?.isAuthority?.() || !call.inCall) return
    const want = oidcHostEmail.toLowerCase()
    const self = call.participants.find((p) => p.isSelf)
    if (self && call.selfIdentity?.email?.toLowerCase() === want) {
      call.declareHost(self.id)
      return
    }
    for (const p of call.participants) {
      if (p.isSelf) continue
      if (identities[p.id]?.email?.toLowerCase() === want) {
        call.declareHost(p.id)
        break
      }
    }
  }, [oidcHostEmail, room, call.inCall, call.participants, call.selfIdentity, identities, call.declareHost])

  // "Verified only": while we're the host, remove anyone who hasn't proven an allowed
  // identity within a grace window (verification is peer-to-peer and takes a few
  // seconds after they join). Honest joiners are blocked at the lobby Join button (so
  // they're already verifying); this catches auto-rejoined / client-tampering peers.
  const firstSeenRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    const now = Date.now()
    const live = new Set(call.participants.map((p) => p.id))
    for (const p of call.participants) if (!firstSeenRef.current.has(p.id)) firstSeenRef.current.set(p.id, now)
    for (const id of [...firstSeenRef.current.keys()]) if (!live.has(id)) firstSeenRef.current.delete(id)
  }, [call.participants])
  // Platform-blind memory (docs/encrypted-memory.md): if our room link carries an `mk`, deliver it to any AGENT
  // that joins — over the call's E2EE channel, so the server never sees it. Once per agent peer; the agent accepts
  // it only if it matches the summon's commitment. No `mk` ⇒ inert (e.g. all of kibitz.chat).
  const sentMkRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const mk = roomKeyFromHash()
    if (!mk) return
    for (const p of call.participants) {
      if (isAgentParticipant(p) && !sentMkRef.current.has(p.id)) {
        sentMkRef.current.add(p.id)
        call.sendAppTo(p.id, { kind: 'mem-key@1', mk })
      }
    }
  }, [call.participants])
  useEffect(() => {
    if (!hostLobby.isHost || !requireVerified || !call.inCall) return
    const GRACE_MS = 20_000 // time to sign in (the in-call Verify panel offers it)
    const allowedDomains = verifyIdentity?.allowedDomains
    const sweep = () => {
      const now = Date.now()
      // Live guest list — if the host just removed someone from it, the sweep evicts them.
      const allowedEmails = guestEmailsRef.current
      for (const p of partsRef.current) {
        if (p.isSelf) continue
        if (now - (firstSeenRef.current.get(p.id) ?? now) < GRACE_MS) continue
        const vid = identitiesRef.current[p.id]
        if (!vid || !identityAllowed(vid, allowedDomains, allowedEmails)) lobbyOpsRef.current.hostLobby.remove(p.id)
      }
    }
    sweep()
    const iv = setInterval(sweep, 3000)
    return () => clearInterval(iv)
  }, [hostLobby.isHost, requireVerified, call.inCall, verifyIdentity])

  const setLockedCtl = useCallback((on: boolean) => lobbyOpsRef.current.hostLobby.setLocked(on), [])
  const resetCtl = useCallback(() => lobbyOpsRef.current.hostLobby.resetRoom(), [])
  const knockCtl = useCallback((n: string, a: string) => lobbyOpsRef.current.room?.knock?.(n, a), [])

  // The host-facing participant shape (maps useCall's CallParticipant + speaking).
  const participantsSnapshot = useMemo<Participant[]>(
    () =>
      call.participants.map((p) => ({
        id: p.id,
        isSelf: p.isSelf,
        name: p.name,
        avatar: p.avatar,
        camOn: p.cam,
        speaking: speaking.has(p.id),
        stream: p.stream,
        meta: p.meta,
        mirror: p.mirror,
        sharing: p.sharing,
        role: (hostId && p.id === hostId ? 'host' : 'guest') as 'host' | 'guest',
      })),
    [call.participants, speaking, hostId],
  )

  // Push a snapshot whenever participants / call state / lobby change → the bridge
  // diffs and fires participants/join/leave/speaking/state/knocks/lobby events.
  useEffect(() => {
    bridge?.pushSnapshot({
      participants: participantsSnapshot,
      inCall: call.inCall,
      micOn: call.micOn,
      camOn: call.camOn,
      needsMediaGesture: call.needsMediaGesture,
      sharing: call.sharing,
      isHost: hostLobby.isHost,
      lobbyOn: hostLobby.lobbyOn,
      locked: hostLobby.locked,
      knocks: hostLobby.knocks as Knock[],
      chat: call.chat,
      lobbyStatus,
      identityEnabled: call.identityEnabled,
      selfEmail: call.selfIdentity?.email ?? null,
      rosterActive: call.rosterGate.active,
      rosterCanShare: call.rosterGate.canShare,
      rosterCompromised: call.rosterGate.compromised,
    })
  }, [
    bridge,
    participantsSnapshot,
    call.inCall,
    call.micOn,
    call.camOn,
    call.needsMediaGesture,
    call.sharing,
    hostLobby.isHost,
    hostLobby.lobbyOn,
    hostLobby.locked,
    hostLobby.knocks,
    call.chat,
    lobbyStatus,
    call.identityEnabled,
    call.selfIdentity,
    call.rosterGate,
  ])

  // Expose the call controls to the host (useCall's methods are stable).
  useEffect(() => {
    if (!bridge) return
    bridge.setControls({
      join: joinWith,
      leave: leaveCall,
      toggleMic: call.toggleMic,
      toggleCam: call.toggleCam,
      resumeMedia: call.resumeMedia,
      shareScreen: call.shareScreen,
      shareTrack: call.shareTrack,
      stopShare: call.stopShare,
      publishAudioTrack: call.publishAudioTrack,
      publishVideoTrack: call.publishVideoTrack,
      setName: (n) => setName(n),
      setAvatar: call.setAvatar,
      setMeta: call.setMeta,
      broadcastLedger: call.broadcastLedger,
      onLedger: call.onLedger,
      fetchBlob: call.fetchBlob,
      sendChat: call.sendChat,
      seedChatHistory: call.seedChatHistory,
      exportLedger: call.exportLedger,
      ledgerVersion: call.ledgerVersion,
      importLedger: call.importLedger,
      onInk: call.onInk,
      sendInk: call.sendInk,
      sendWidget: call.sendWidget,
      removeWidget: call.removeWidget,
      onWidget: call.onWidget,
      sendWidgetEvent: call.sendWidgetEvent,
      onWidgetEvent: call.onWidgetEvent,
      sendFile: call.sendFile,
      sendImage: call.sendImage,
      stageMedia,
      setLobby: setLobbyCtl,
      admit: admitCtl,
      deny: denyCtl,
      remove: removeCtl,
      setLocked: setLockedCtl,
      resetRoom: resetCtl,
      knock: knockCtl,
      signInIdentity: call.signInIdentity,
      identityNonce: call.identityNonce,
      provideIdentityToken: call.provideIdentityToken,
      provideAgentKey: call.provideAgentKey,
      provideAgentCredit: call.provideAgentCredit,
      getCapabilityGrant: call.getCapabilityGrant,
      setCapabilityGrant: call.setCapabilityGrant,
      getAgentAudit: call.getAgentAudit,
    })
    return () => bridge.setControls(null)
  }, [bridge, joinWith, leaveCall, call.toggleMic, call.toggleCam, call.resumeMedia, call.shareScreen, call.shareTrack, call.stopShare, call.setAvatar, call.setMeta, call.sendChat, call.seedChatHistory, call.sendFile, call.sendImage, stageMedia, setLobbyCtl, admitCtl, denyCtl, removeCtl, setLockedCtl, resetCtl, knockCtl, call.signInIdentity, call.identityNonce, call.provideIdentityToken, call.provideAgentKey, call.provideAgentCredit, call.getCapabilityGrant, call.setCapabilityGrant, call.getAgentAudit])

  // Apply the initial `meta` mount option once.
  const initialMeta = useRef(meta)
  useEffect(() => {
    if (initialMeta.current) call.setMeta(initialMeta.current)
  }, [call.setMeta])

  // iOS refuses media autoplay until a user gesture — and RE-LOCKS the audio session after a background (an
  // app-switch, screen lock) or a mid-call track swap (the other side turning its camera on). The Join tap unlocks
  // it initially, but nothing recovered a RE-LOCKED remote element in the human UI — and a paused element kills the
  // remote AUDIO and VIDEO together (decoded frames pile up behind a black, silent tile; the exact "no picture AND
  // no sound after the other camera came on" report). This used to be headless-only; run it for everyone. `unlock`
  // replays every remote <video>/<audio>, so ANY tap recovers a blocked stream, and a return-to-foreground retries
  // too (the app-switch case). Harmless when nothing's blocked (a playing element ignores a redundant play()).
  useEffect(() => {
    document.addEventListener('pointerdown', unlock, { passive: true })
    const onVis = () => {
      if (document.visibilityState === 'visible') unlock()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('pointerdown', unlock)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [unlock])

  // Debug snapshot for the conn-debug overlay: per-participant cam FLAG vs the stream's ACTUAL live tracks. When a
  // tile shows black this tells "we think their camera is off" (cam=0 while v>0 — a stale/lost cam flag) apart from
  // "no stream bound to this participant" (s=0). Cheap; written every render (a window prop never re-renders).
  useEffect(() => {
    ;(window as unknown as { __kbzRoster?: unknown }).__kbzRoster = call.participants.map((p) => {
      const v = (p.stream?.getVideoTracks() ?? []).filter((t) => t.readyState === 'live' && !t.muted).length
      const a = (p.stream?.getAudioTracks() ?? []).filter((t) => t.readyState === 'live' && !t.muted).length
      return { n: (p.name || '?').slice(0, 5), self: !!p.isSelf, cam: !!p.cam, s: !!p.stream, v, a }
    })
  })

  // The floating panel's window geometry — drag-to-move + edge/corner resize + on-screen/iOS-rotation effects.
  // See usePanelDrag (persists pos/size; returns the pointer handlers consumed by the header + resize edges).
  const { pos, size, panelRef, onBarDown, onBarMove, onBarUp, onBarClickCapture, startResize, onResizeMove, onResizeUp } =
    usePanelDrag(!!fill, canTouch, tilesRef, presenter, chatOpen)

  // ── Pre-join camera/mic preview (Zoom-style) ───────────────────────────────────────────
  // A purely LOCAL getUserMedia preview shown in the lobby so you can set mic/camera BEFORE entering.
  // The pre-join lobby media (camera/mic preview + device pickers), kept separate from the call's own media —
  // see usePreJoinMedia. The join handler below reads the chosen intents (preMic/preCam + ids) + stopPreview().
  const {
    preMic, preCam, preFacing, preSpeaker, setPreSpeaker, preMicId, preCamId, preSpeakerId, setPreSpeakerId,
    mics, cams, speakers, previewStream, previewErr, previewVidEl,
    togglePreMic, togglePreCam, flipPre, selectMic, selectCam, stopPreview,
  } = usePreJoinMedia(call, !!preview, !!headless)

  const joinCall = () => {
    if (!name.trim()) {
      setNameErr(true) // insist: flag the field + focus it, don't join anonymously
      nameRef.current?.focus()
      return
    }
    try {
      localStorage.setItem('kibitz.name', name.trim())
    } catch {
      /* ignore */
    }
    const wantMic = preMic
    const wantCam = preCam
    stopPreview() // free the preview's devices before the call grabs its own
    setJoining(true)
    setJoinSlow(false)
    joinSlowTimer.current = setTimeout(() => setJoinSlow(true), 5000) // dragging (likely a network change) → escalate the message
    void (async () => {
      let ok = false
      try {
        ok = await call.join() // joins muted, camera off (the slow bit — signaling + ICE)
      } finally {
        if (joinSlowTimer.current) clearTimeout(joinSlowTimer.current)
        joinSlowTimer.current = null
        setJoining(false)
        setJoinSlow(false)
      }
      if (!ok) return
      // Carry the open-room CLAIMED identity (M) into self meta — the re-announce propagates it to the roster.
      if (myClaim) call.setMeta({ ...(initialMeta.current || {}), claim: myClaim })
      // Carry the pre-join SPEAKER choice into the call (speaker off = deaf = mute everyone for me).
      setDeaf(!preSpeaker)
      if (preSpeakerId) call.setSpeaker(preSpeakerId) // …and the chosen OUTPUT device (desktop)
      try {
        if (wantMic) call.toggleMic(preMicId || undefined) // apply the lobby choices on top of the muted join
        if (wantCam) await call.toggleCam(preFacing, preCamId || undefined) // …chosen camera (id or front/rear)
      } catch {
        /* the in-call controls still let them enable mic/camera */
      }
    })()
  }

  // Identity sign-in: render the provider's button into the container whenever it
  // MOUNTS — works in the lobby AND in the in-call Verify panel (so a user who
  // auto-rejoined, or just never signed in before joining, can still prove who they
  // are). Keyed on the element so reopening the panel re-renders the button; any
  // sign-in that resolves into a torn-down call is dropped by useCall's stale-guard.
  const signinElRef = useRef<HTMLDivElement | null>(null)
  const mountSignin = useCallback(
    (el: HTMLDivElement | null) => {
      if (el === signinElRef.current) return // same element — already wired
      signinElRef.current = el
      // With verified identity on, sign-in must bind its nonce to the SHARED cert (the one
      // pinned on BOTH the presence peer and the media mesh). If we started before that
      // cert propagated, signInIdentity would mint a throwaway cert and the authority gate
      // — which reads the presence cert — would deny us. Wait for it; this ref re-fires
      // when sharedCert lands (it's in the dep list).
      if (verifyIdentity && !sharedCert) return
      if (el && call.identityEnabled && !call.selfIdentity) void call.signInIdentity(el)
    },
    [call.identityEnabled, call.selfIdentity, call.signInIdentity, verifyIdentity, sharedCert],
  )
  // Email-code sign-in (rooms that accept `mail` members): a button reveals the email→code form,
  // mounted the same way — binding its nonce to the shared cert, exactly like the Google button.
  const [emailOpen, setEmailOpen] = useState(false)
  const mountEmailSignin = useCallback(
    (el: HTMLDivElement | null) => {
      if (verifyIdentity && !sharedCert) return
      if (el && call.identityEnabled && !call.selfIdentity) void call.signInIdentity(el, 'email')
    },
    [call.identityEnabled, call.selfIdentity, call.signInIdentity, verifyIdentity, sharedCert],
  )

  // Pop-out: move the whole shadow host into an always-on-top Document PiP
  // window — the call floats over every tab and app. Closing it moves us home.
  // (Moving media elements across documents pauses them; unlock() replays.)
  const pipApi = (window as unknown as { documentPictureInPicture?: DocumentPiP }).documentPictureInPicture
  const [pip, setPip] = useState<Window | null>(null)
  const popOut = async () => {
    if (!host || !pipApi) return
    if (pip) {
      pip.close() // its pagehide handler brings us home
      return
    }
    try {
      const w = await pipApi.requestWindow({ width: 384, height: 560 })
      w.document.title = `${brandName} · ${roomName}`
      // Paint the pop-out document BLACK end to end. The widget fills it, but while you drag/resize the
      // window the browser repaints the bare document background before the content reflows — a white
      // flash unless html+body are black. colorScheme:dark keeps scrollbars/controls dark to match.
      w.document.documentElement.style.background = '#000'
      w.document.documentElement.style.colorScheme = 'dark'
      w.document.body.style.margin = '0'
      w.document.body.style.background = '#000'
      // Make the moved shadow host fill the window so there's no uncovered margin at any size.
      host.style.width = '100%'
      host.style.height = '100%'
      w.document.body.appendChild(host)
      setPip(w)
      setTimeout(unlock, 60)
      w.addEventListener(
        'pagehide',
        () => {
          // Drop the fill sizing we set for the pop-out so the host lays out normally back home.
          host.style.width = ''
          host.style.height = ''
          document.body.appendChild(host)
          setPip(null)
          setTimeout(unlock, 60)
        },
        { once: true },
      )
    } catch {
      /* user denied / unsupported context */
    }
  }

  // Start a screen share, but POP THE CALL OUT FIRST (into the always-on-top Document-PiP window) so it
  // stays visible after the browser jumps to the shared tab — otherwise sharing a tab hides the call
  // behind it. Desktop Chrome/Edge only (Document PiP); everywhere else the pop-out is a no-op and we
  // just share. Skipped if we're already popped out. The pop-out resolves fast, so the click's transient
  // activation still covers the getDisplayMedia picker that follows.
  const startShare = async () => {
    // Share + FOCUS the captured tab FIRST. (Popping out first stole focus, so the browser's
    // focus-captured-surface never won — that's why you weren't taken to the shared tab.) Then pop the
    // call out so it floats over it. The pop-out is best-effort here: getDisplayMedia may have spent the
    // click's activation, so if the float doesn't appear, pop out manually (⧉) BEFORE sharing instead.
    const ok = await call.shareScreen()
    // Only float when we're a BROWSER TAB — there, sharing a tab hides the call behind it. As an INSTALLED
    // app the call is already its own OS window, so popping out just spawns a redundant second window.
    const inBrowserTab = typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: browser)').matches : true
    if (ok && inBrowserTab && pipApi && !pip) {
      try {
        await popOut()
      } catch {
        /* couldn't pop out after the share — the share itself still works */
      }
    }
  }

  // (The pop-out now renders the FULL tab-view layout — a flex column that fills its window — so we no
  // longer shrink it to a content strip; it just stays the size it opened at / the user resizes it.)

  // Unread = lines that arrived while the chat pane was closed.
  useEffect(() => {
    if (chatOpen) setChatSeen(call.chat.length)
  }, [chatOpen, call.chat.length])
  const unread = Math.max(0, call.chat.length - chatSeen)

  // Pin the message list to the bottom as lines arrive.
  useEffect(() => {
    if (chatOpen && msgsRef.current) msgsRef.current.scrollTop = msgsRef.current.scrollHeight
  }, [chatOpen, call.chat.length])

  // Car (driving) mode AND Gallery (grid, the left-swipe view) hide the chat — no texting while driving, and the
  // grid is a pure roster view we don't support chat in. Closing it here covers EVERY way into those views (swipe,
  // page-dot, header button); the Chat button is also hidden in both (below).
  useEffect(() => {
    if ((view === 'car' || view === 'gallery') && chatOpen) setChatOpen(false)
  }, [view, chatOpen])

  const sendDraft = () => {
    const text = draft.trim()
    if (!text) return
    // Text rides the unified chunked transfer (a 1-chunk transfer), same as images/files.
    call.sendContent('text', textToBytes(text), {}, recipientId ?? undefined)
    setDraft('')
  }

  // Share a file or image: a picked file (📎, any type) or a camera shot (📷). It rides the chunked
  // transfer at full resolution — no client-side squeeze. The picking is a hidden <input>; this just
  // hands the File to the engine, which chunks + paces it (private when a recipient is selected).
  const sendAttachFile = (file: File | null | undefined) => {
    if (!file) return
    // A HUMAN sharing a WIDGET: a saved {kind,data} JSON (the 💾 Save format) re-posts AS the widget — the agent's
    // "post a widget" power, reached through the human's OWN file attach (no agent-only lane; narrows the gap).
    // Only a kbz.* payload routes to sendWidget; receivers sanitize per kind, so a malformed one is dropped on
    // render. Any other .json (or non-json) shares as a normal file.
    if (/\.json$/i.test(file.name || '') || file.type === 'application/json') {
      void file
        .text()
        .then((txt) => {
          try {
            const obj = JSON.parse(txt) as { kind?: unknown; data?: unknown }
            if (typeof obj?.kind === 'string' && obj.kind.startsWith('kbz.') && obj.data != null) {
              call.sendWidget(obj.kind, obj.data)
              return
            }
          } catch {
            /* not a widget JSON */
          }
          call.sendFile(file, recipientId ?? undefined)
        })
        .catch(() => call.sendFile(file, recipientId ?? undefined))
      return
    }
    call.sendFile(file, recipientId ?? undefined)
  }
  // An IMAGE pick (📷 Camera / 🖼️ Photo): share it as usual — a vision-granted agent reads the text off it (OCR) —
  // AND opportunistically decode a QR in it (jsQR, dynamic-imported like QrScanner). If it encodes an http(s)
  // link, drop that link into chat so the agent's read_url tool can read the page. One pick = pic + QR + OCR.
  const sendImageAttach = (file: File | null | undefined) => {
    if (!file) return
    sendAttachFile(file) // share the photo (the OCR path — unchanged)
    void (async () => {
      try {
        const bmp = await createImageBitmap(file)
        const w = Math.min(1024, bmp.width)
        const h = Math.max(1, Math.round((bmp.height / bmp.width) * w))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return
        ctx.drawImage(bmp, 0, 0, w, h)
        const jsQR = (await import('jsqr')).default
        const found = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' })
        const text = found?.data?.trim()
        if (text && /^https?:\/\/\S+$/i.test(text)) call.sendChat(text) // a link QR → the agent's read_url reads it
      } catch {
        /* unreadable / no QR — the shared photo still stands for OCR */
      }
    })()
  }
  // Render a chunked attachment in chat: an image (inline once done), or a file chip with a Save link;
  // a progress bar while it's still transferring, or a failed note.
  // Keyboard shortcuts — bound to the PANEL (focus-within), never window, so an
  // embed never hijacks the host page's keys. m=mic, v=camera, hold Space=push-to-talk.
  const pttRef = useRef(false)
  const micOnRef = useRef(call.micOn) // read in the PTT guard (handler closures can lag a render)
  micOnRef.current = call.micOn
  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (!call.inCall || isTypingTarget(e.target)) return
    const action = shortcutFor(e.key)
    if (!action) return
    if (action === 'mic') {
      e.preventDefault()
      pttRef.current = false // a deliberate toggle overrides any in-progress push-to-talk
      void call.toggleMic()
    } else if (action === 'cam') {
      e.preventDefault()
      void call.toggleCam()
    } else if (action === 'ptt') {
      if (e.repeat || isButtonTarget(e.target)) return // ignore held-key repeat; let a focused button take Space
      e.preventDefault()
      if (!micOnRef.current) {
        pttRef.current = true
        void call.toggleMic() // unmute while held
      }
    }
  }
  const onPanelKeyUp = (e: React.KeyboardEvent) => {
    if (shortcutFor(e.key) !== 'ptt' || !pttRef.current) return
    pttRef.current = false
    void call.toggleMic() // re-mute on release
  }
  // Focus the panel when the call starts so the shortcuts work right away (no scroll
  // jump on the host page).
  useEffect(() => {
    if (call.inCall) panelRef.current?.focus({ preventScroll: true })
  }, [call.inCall])

  // iOS Safari edge-swipe guard. A touch that STARTS within EDGE_PX of the screen's left/right edge is Safari's
  // back/forward navigation gesture — mid-call that drags you out of the call onto the create-room page. There's no
  // API to disable it, but a non-passive touchstart that preventDefault()s an EDGE-origin touch cancels it at the
  // source. Scoped to the call panel + to an ACTIVE call only, and it bails on interactive targets and on non-edge
  // touches — so taps, pinch-zoom, vertical scroll, and the mid-screen layout swipe are all untouched. Native
  // listener (React's onTouchStart is passive → preventDefault would be ignored); capture phase so a child that
  // stops touchstart propagation (e.g. the chat) can't hide the edge from us. Off iOS this is a harmless no-op.
  const inCallRef = useRef(false)
  inCallRef.current = call.inCall
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const EDGE_PX = 24
    const onTouchStart = (e: TouchEvent) => {
      if (!inCallRef.current) return // only inside a live call — pre-join / Landing keep the normal Back
      const t = e.touches[0]
      if (!t) return
      if (t.clientX > EDGE_PX && t.clientX < window.innerWidth - EDGE_PX) return // not an edge-origin touch
      const target = e.target as Element | null
      // Preserve taps on controls that happen to sit near the edge; the back-gesture starts on the stage/background.
      if (target?.closest?.('button, a, input, textarea, select, label, [role="button"], [contenteditable]')) return
      e.preventDefault()
    }
    el.addEventListener('touchstart', onTouchStart, { passive: false, capture: true })
    return () => el.removeEventListener('touchstart', onTouchStart, { capture: true } as EventListenerOptions)
  }, [])

  // Leaving the call drops full-screen — the lobby shouldn't sit maximized.
  useEffect(() => {
    if (!call.inCall) setFull(false)
  }, [call.inCall])

  // Show who the host is ONLY when the room is actually being MANAGED — a lobby is on, it's
  // verified-only, or it's locked. In a plain open call everyone's equal (P2P, no relay through the
  // host), so the "· host" label is just noise; we drop it by passing no hostId.
  const roomManaged = hostLobby.lobbyOn || hostLobby.locked || requireVerified || roomHasHost
  // Per-tile moderation/role props: the host chip, the speaker-off (deaf) audio mute, and a
  // remove button on remote tiles when WE are the host.
  const tileExtras = (p: { id: string; isSelf: boolean }) => ({
    hostId: roomManaged ? hostId : '',
    muted: deaf, // speaker-off (deaf) silences everyone's audio for you
    onRemove: !p.isSelf && hostLobby.isHost ? () => removeParticipant(p.id) : undefined,
    conn: conns[p.id] ?? null,
    // Verified identity (opt-in L3): the email to show a ✓ for, or undefined.
    verifiedId: identities[p.id]?.email,
    sinkId: call.speakerId, // play remote audio through the chosen output device (desktop)
  })

  // A moved panel switches from the CSS bottom-right anchor to explicit left/top.
  const style: React.CSSProperties = pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : {}

  // Debug readout (append ?debug to the URL) — on-screen so it's readable on a
  // phone. roster = who the data-room knows; tiles = rendered; remote = peers whose
  // media arrived; `net` = the latest transport event (peer error / ICE state /
  // give-up reason) — that's what tells us WHY a phone won't connect.
  const remoteStreams = call.participants.filter((p) => !p.isSelf && p.stream).length
  const role = (room as unknown as { isAuthority?: () => boolean })?.isAuthority?.() ? 'host' : 'guest'
  const debugEl = debug ? (
    <div className="kw-debug">
      {`${room?.status() ?? '—'} · ${role}`}
      <br />
      {`roster ${call.rosterCount} · tiles ${call.participants.length} · remote ${remoteStreams}`}
      <br />
      {`net ${getDiag() || '—'}`}
      <br />
      {`build ${__BUILD_ID__.split(' · ')[0]}`}
      {call.error ? (
        <>
          <br />
          {`err ${call.error}`}
        </>
      ) : null}
    </div>
  ) : null

  // Headless: no panel at all. Render only hidden <audio> sinks for remote streams
  // so voice plays even for camera-off peers; the host draws its own tiles from the
  // controller (attaching streams to MUTED <video> to avoid double audio). A deaf
  // spectator (`mutePlayback`) renders these muted — it still gets the streams via the
  // controller, but nothing plays out the speakers (no echo from a second in-page engine).
  if (headless) {
    return (
      <div ref={tilesRef} aria-hidden style={{ position: 'fixed', width: 0, height: 0, overflow: 'hidden' }}>
        {call.participants
          .filter((p) => !p.isSelf && p.stream)
          .map((p) => (
            <audio
              key={p.id}
              autoPlay
              muted={mutePlayback}
              ref={(el) => {
                if (el) {
                  el.muted = !!mutePlayback // `muted` attr is unreliable on media els — set it imperatively too
                  if (el.srcObject !== p.stream) el.srcObject = p.stream
                }
              }}
            />
          ))}
      </div>
    )
  }

  // Chat needs a solid, readable panel — ghosting pauses while it's open.
  // In the PiP window the panel IS the window: solid, full-bleed, undraggable.
  // Full screen and ghost are mutually exclusive — maximized means "show me the call",
  // not "see through to the page", which also sidesteps the speaker-pop entirely.
  const fullscreen = full && call.inCall
  // Dedicated room window: fill the window, opaque, edge-resize, no ghost. (PiP owns
  // its own box, so it wins.)
  const fillMode = !!fill && !pip
  // See-through panel over a host page — the tiles go translucent + click-through and only the
  // header/ops stay tappable. Available BOTH in the corner panel AND when the embed is maximized to
  // fullscreen (so a big translucent video can float over the page you're reading), but never the
  // dedicated room window (`fillMode`) or pop-out (`pip`) — those stand alone with nothing behind.
  const ghosting = call.inCall && ghost && !chatOpen && !verifyOpen && !pip && !fillMode
  // Big surfaces (room window / full screen) move the call controls to a Zoom-style bottom bar,
  // leaving a slim title strip up top; the embedded corner panel keeps everything in the header. The
  // bar STAYS put through chat/verify (those panels are flex:1 and sit above it) — if it depended on
  // !chatOpen the controls would relocate up to the header the instant you tapped Chat (a jarring jump).
  // "Big surfaces" get the full tab-view layout (bottom control bar, auto-hiding chrome, layout tabs,
  // black full-bleed): the dedicated room window, full screen — AND the Document-PiP pop-out, so the
  // pop-out window looks exactly like the in-tab room.
  const bigSurface = fillMode || fullscreen || pip
  const bottomBar = bigSurface && call.inCall
  // The EMBEDDED corner panel gets the same shape as the room window while in a call (Speaker OR Strip):
  // the call controls ride a bottom bar that FLOATS over the foot of the tile area (a Zoom-style scrim)
  // and auto-hides, while the top bar (title + verify/invite + leave) stays put. The Strip row is
  // top-anchored, so the bottom bar sits below it (no overlap). Chat/verify are a full takeover in 300px,
  // so there the controls fall back into the header instead.
  const embedBar = call.inCall && !bigSurface && !preview && !headless && !chatOpen && !verifyOpen
  // Split chat: on the big surfaces, opening chat SPLITS the space with the tiles instead of taking the
  // whole screen — portrait gives the tiles a strip on top + chat below; landscape/desktop puts the chat
  // on one side, tiles on the other (the CSS does the orientation). The small embedded corner panel keeps
  // the simple full-takeover (too cramped to split). Layout-only; the control bar stays put below both.
  const chatSplit = chatOpen && bottomBar
  // Page-indicator dots (Zoom-style): shown on the big surfaces, on a touch device (where Car exists and
  // there are ≥2 pageable views), with no presenter (a shared screen forces the stage). They hint the
  // swipe AND double as a tap target. (canTouch is computed up by availableViews.)
  // Page dots are the view switcher on the big surfaces — clickable (desktop) AND swipeable (touch),
  // so they replace the bottom-bar view button there (dropped above).
  // Page-dots are the SWIPE position cue, so they're touch-only — on desktop the view-switcher icon
  // (always shown) does the job and the dots are just clutter.
  // No view-switcher in chat mode: the chatsplit layout (stage/gallery + chat + rail) is fixed, so the page
  // dots — and their swipe — are irrelevant there (you'd just be paging a view you can't see behind the chat).
  const showViewDots = bigSurface && canTouch && !presenter && availableViews.length > 1 && !chatSplit
  // Auto-hide the chrome in the big surfaces (room window / full screen) AND in the see-through ghost
  // panel, while in a call. In the big surfaces the whole header + bottom bar + host controls fade to
  // give full-bleed video (or full-height chat — the chat/verify panel is flex:1 and its own input
  // stays put, so it grows into the freed rows); in ghost only the call buttons fade, leaving the slim
  // title strip as the tap target. The avatar picker pins the chrome (so the picker doesn't fade
  // mid-choice), as does a pending knock (so the host never misses Admit/Deny).
  const autoHideChrome =
    (bigSurface || ghosting || embedBar) &&
    call.inCall &&
    // Driving mode pins the top bar (Leave / view-switch always reachable); the bottom control bar is hidden
    // via CSS instead (car mode has its own big mic). So no auto-hide cycle in car mode.
    !carMode &&
    // A SEE-THROUGH fullscreen keeps its chrome put: the panel is click-through, and fullscreen's
    // hide fully collapses the top bar — so auto-hiding would leave nothing to tap to bring it back.
    // (The video is already translucent, so a persistent slim bar costs nothing.)
    !(fullscreen && ghosting) &&
    !pickerOpen &&
    !hostMenuOpen &&
    !agentsMenuOpen && // the 🤖 agent menu is open → keep the chrome up so it doesn't vanish mid-use
    !preview &&
    hostLobby.knocks.length === 0 &&
    // DESKTOP + a shared screen keeps the controls up (a mouse user expects them; touch surfaces don't).
    !(presenter && !canTouch) &&
    // While a pen/laser tool is ACTIVE, pin the chrome so the ink toolbar stays put while you annotate.
    // Otherwise a presentation auto-hides for full-bleed like any call — "fixed only when we laser/pen".
    // (The landscape tap-offset that made this look unsafe was the iOS rotation bug, now fixed separately.)
    !inkActive
  const { chromeHidden } = useAutoHideChrome(autoHideChrome, host, !!chatSplit, swipeActiveRef, revealChromeRef)

  // Pin the panel-anchored stage overlays (.kw-staged-vid / .kw-stage-widget) to the LIVE .kw-stage box via
  // --kw-stage-top / --kw-stage-bot (offsets from the panel's top/bottom edges). The portrait no-chat cell uses
  // these so the overlay covers EXACTLY the stage region — never overshooting into the faces strip + control bar
  // below (which paints the transport over the self-tile). .kw-stage is a real flex item whose SIZE changes on every
  // reflow (bar collapse on auto-hide, rotation), so a ResizeObserver on it fires reliably — unlike the control bar,
  // which collapses via max-height (content-box unchanged → RO misfires). Overlay ≡ stage box also keeps the doodle
  // (canvas anchored to .kw-stage) aligned with the video: both share one box and grow together. Cleared on unmount
  // so a later staged widget with no .kw-stage falls back to the CSS defaults instead of a stale offset.
  const stageObsRef = useRef<ResizeObserver | null>(null)
  const setStageEl = useCallback(
    (el: HTMLDivElement | null) => {
      stageRef.current = el
      stageObsRef.current?.disconnect()
      stageObsRef.current = null
      const panel = panelRef.current
      if (!el || !panel) {
        panel?.style.removeProperty('--kw-stage-top')
        panel?.style.removeProperty('--kw-stage-bot')
        return
      }
      const apply = () => {
        const s = el.getBoundingClientRect()
        const pr = panel.getBoundingClientRect()
        panel.style.setProperty('--kw-stage-top', `${Math.round(s.top - pr.top)}px`)
        panel.style.setProperty('--kw-stage-bot', `${Math.max(0, Math.round(pr.bottom - s.bottom))}px`)
      }
      apply()
      const ro = new ResizeObserver(apply)
      ro.observe(el)
      ro.observe(panel)
      stageObsRef.current = ro
    },
    [panelRef, stageRef],
  )

  // "Your mic is off" — a PERSISTENT reminder whenever you're muted in a call (join is muted by default), so
  // people don't talk unheard. Proactive (not speech-triggered); shows the whole time you're muted and is gone
  // the instant you unmute. AGENT-CAPABLE ROOMS ONLY — being muted matters most when there's an agent to hear
  // you, so gate on THIS room actually accepting an agent (one is present, or it can be summoned: a summonKey /
  // summonPath), not just the brand-wide agent UI (`bubbleOn` is on for EVERY kibitz call, incl. plain P2P ones).
  // A PARTICIPANT has no summonKey/summonPath, so the nudge used to hinge entirely on the instantaneous
  // roster-meta `agentPresent` — fragile for a joiner (the agent's meta may not have synced yet), so
  // participants in an agent call often saw NO "tap to unmute". The DEFINITIVE signal is `agentCall`: the `ag`
  // agent-call-type param kibitz bakes into the shared invite (a display-only gate param, NOT a control secret,
  // so it SURVIVES the invite-stripping that removes sk/mk/st). Every participant who opened an agent-call link
  // carries it, up front, no sync needed. agentPresent / agentResumable (the P2P-synced "an agent is/has-been
  // here" ledger) are runtime backstops. Still stays OUT of a genuine plain-P2P call (no ag, no agent seen).
  const canAcceptAgent = !!agentCall || agentPresent || agentResumable || (summonApi ? !!summonKey : !!summonPath)
  // The nudge has a ✕ to dismiss it WITHOUT unmuting; once dismissed it stays gone for this call (resets on a fresh one).
  const [micNudgeDismissed, setMicNudgeDismissed] = useState(false)
  // Short grace after joining before nudging to unmute: the "Tap to join & talk" gate opens the mic ITSELF (getUserMedia
  // is async, ~1s), so without this the nudge would flash before micOn flips. So on a normal gift join it never shows —
  // it only reappears if the mic genuinely never opened (permission denied / a muted non-gate join).
  const [nudgeGrace, setNudgeGrace] = useState(false)
  useEffect(() => {
    if (!call.inCall) {
      setMicNudgeDismissed(false)
      setNudgeGrace(false)
      return
    }
    const t = setTimeout(() => setNudgeGrace(true), 3000)
    return () => clearTimeout(t)
  }, [call.inCall])
  const micNudge = call.inCall && !call.micOn && bubbleOn && canAcceptAgent && nudgeGrace

  // "Verified only" rooms block Join until you've signed in (honest-user gate; the host
  // enforces the rest). Sign-in is required, not optional, in the lobby then.
  const mustVerifyToJoin = requireVerified && call.identityEnabled && !call.selfIdentity
  // Lobby-skip (autoJoin): an upstream step already took the name + consent, so join automatically on load —
  // MUTED, camera off (join()'s iOS-safe default). Unlike auto-REJOIN we DON'T skip iOS: joining muted needs no
  // gesture, the mic opens on the first in-call unmute tap, and the global pointerdown `unlock` (above) replays
  // remote audio on that same first tap. One-shot; never fights a gate/lobby/verify or an already-live call. A
  // failed attempt falls back to the normal lobby so the user can join by hand. MUST stay ABOVE the collapse
  // return below (it's a hook — see the Rules-of-Hooks note there).
  useEffect(() => {
    if (!autoJoin || autoJoinFiredRef.current) return
    if (!room || call.inCall || kicked || lobbyStatus || mustVerifyToJoin || call.retired) return
    if (joinGate?.declare?.length && !myClaim) return // a declare/claim gate still needs the human to pick a seat first
    autoJoinFiredRef.current = true
    // An auto-join should enter with the mic OPEN on EVERY device — this is a gift call, the caller is here to talk to
    // the painter. The one-tap "Tap to join & talk" gate is what opens the mic (see gestureJoin), so route everyone
    // through it whenever audio is still locked (a fresh page — the usual case on desktop AND mobile). It ALSO unlocks
    // audio autoplay so the agent's voice isn't left paused (the "heard nothing until the end" report). Previously this
    // was iOS/touch-only, so DESKTOP fell through to the silent branch below and joined MUTED — landing behind the "tap
    // to unmute" nudge. If audio is somehow already unlocked (rare — a pre-resumed AudioContext), join right away but
    // STILL open the mic so we never land muted. Gated on the ACTUAL audio state, so it never double-taps.
    if (!audioUnlocked()) {
      setNeedsGesture(true)
    } else {
      void call.join().then((ok) => {
        if (ok) call.toggleMic() // audio already unlocked → no gate needed, but still enter unmuted
        else setAutoJoinFailed(true) // couldn't auto-join → reveal the real lobby so they can join by hand
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoJoin, room, call.inCall, call.join, kicked, lobbyStatus, mustVerifyToJoin, call.retired, myClaim])
  // While autoJoin is connecting (before we're in the call) show a clean "joining…" splash instead of the full
  // pre-join lobby — so a lobby-skip reads as one smooth hop, not a flash of the lobby. Reveal the lobby only if
  // the auto-join can't proceed (a gate/verify blocks it, or the join attempt failed).
  const autoJoinSplash =
    !!autoJoin && !call.inCall && !autoJoinFailed && !needsGesture && !kicked && !lobbyStatus && !mustVerifyToJoin && !call.retired && !(joinGate?.declare?.length && !myClaim)
  // Never strand on the splash: if we're still not in the call after ~20s, reveal the real lobby so the user can
  // retry / see what's wrong. MUST stay ABOVE the collapse return below (it's a hook).
  useEffect(() => {
    if (!autoJoinSplash) return
    const t = setTimeout(() => setAutoJoinFailed(true), 20000)
    return () => clearTimeout(t)
  }, [autoJoinSplash])

  // Collapsed → render the floating mic pill. This early return MUST sit after EVERY hook above:
  // React's Rules of Hooks require an identical hook sequence on every render, so a return placed
  // among the hooks (as this once was, just above the autoHideChrome effect) makes the open render
  // run more hooks than the collapsed one — which crashes the whole widget on the very first tap of
  // the pill (React #310, "rendered more hooks than during the previous render"). Keep it down here.
  if (!open) {
    // Someone waiting at the door takes priority over the roster count — the host
    // must reopen to admit them, so the pill flags it (amber, and gently pulses).
    const waiting = hostLobby.knocks.length
    return (
      <>
        {debugEl}
        <button
          className={`kw-pill${waiting > 0 ? ' kw-pill-knock' : ''}`}
          style={style}
          onClick={() => setOpen(true)}
          title={waiting > 0 ? `${waiting} waiting to be let in` : `${brandName} — start talking`}
        >
          <MicIcon />
          {waiting > 0 ? (
            <span className="kw-badge kw-badge-knock">✋{waiting}</span>
          ) : (
            call.rosterCount > 0 && <span className="kw-badge">{call.rosterCount}</span>
          )}
        </button>
      </>
    )
  }

  // Verified-roster (docs §7) derived UI state. `compromised` = a present peer proved an
  // OFF-roster identity (an intruder past admission) → block content + alarm + offer Leave.
  // `holding` = still verifying ≥1 peer (or myself) → a quiet "verifying the room…" hold.
  // `notOnRoster` = I signed in, but with an identity the committed roster doesn't list.
  const rg = call.rosterGate
  const rosterCompromised = rg.active && rg.compromised
  const rosterHolding = rg.active && !rg.canShare && !rg.compromised && call.inCall
  const notOnRoster = rg.active && !!call.selfIdentity && !rg.selfVerified
  // A user-dragged width wins over the CSS default (and the stage's auto-widen). The
  // PiP window manages its own size, so skip it there. Re-clamp to the CURRENT
  // viewport on every render (the resize listener re-renders us) so a size saved on a
  // big screen doesn't overflow a phone, and rotation is handled.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 9999
  const vh = typeof window !== 'undefined' ? window.innerHeight : 9999
  const sizeStyle: React.CSSProperties = size && !pip ? { width: Math.min(size.w, vw - 16) } : {}
  // The dragged tile-area height applies to the grid / stage (not pre-join, chat, or
  // full screen — where the grid flexes to fill the viewport instead).
  const tileH =
    size && call.inCall && !chatOpen && !fullscreen && !fillMode && view !== 'strip'
      ? Math.min(size.h, Math.max(MIN_H, vh - 16))
      : undefined
  // In full screen / PiP the panel owns its own box (CSS-driven). The room window (fillMode) also fills
  // its window via CSS (.kw-fillwin.kw-winmax) so resizing is smooth and always tracks the native window.
  const panelStyle =
    pip || fullscreen || fillMode
      ? ({ '--kw-ghost-op': 1 - transparency } as React.CSSProperties)
      : ({ ...style, ...sizeStyle, '--kw-ghost-op': 1 - transparency } as React.CSSProperties)

  // The in-call control buttons, rendered EITHER in the top header (embedded corner panel) or in the
  // Zoom-style bottom bar (room window / full screen) — see `bottomBar`. Extracted so the two surfaces
  // share one source of truth instead of duplicating the block.
  const callControls = (
    <>
      <MediaControls call={call} canTouch={canTouch} deaf={deaf} setDeaf={setDeaf} portalRef={panelRef} />
      <ShareControls call={call} preview={!!preview} fill={!!fill} presentingImage={presentingImage} startShare={startShare} stopImagePresent={stopImagePresent} hideStageStop={stageHdrCtl} />
      <button
        className={`kw-ic${call.avatar ? ' active' : ''}`}
        onClick={() => setPickerOpen((o) => !o)}
        aria-label="Choose an animated avatar"
        title="Choose an animated avatar"
      >
        <EmojiAvatar value={call.avatar || '🙂'} />
      </button>
      {view !== 'car' && view !== 'gallery' && (
        <button
          className={`kw-ic${chatOpen ? ' active' : ''}`}
          onClick={() => {
            setChatOpen((o) => !o)
            setVerifyOpen(false)
          }}
          title={chatOpen ? 'Back to the room' : 'Chat'}
        >
          <ChatIcon />
          {unread > 0 && !chatOpen && <span className="kw-badge kw-badge-sm">{unread}</span>}
        </button>
      )}
      {/* The master "Agents" menu: every agent present, with a per-viewer checkbox to show/hide its
          on-call menu locally. Plus agents that chose the 'controls' placement, popped from here. */}
      <AgentsMenu call={call} hidden={hiddenAgents} onToggle={toggleAgentHidden} onOpenChange={setAgentsMenuOpen} />
      {!bubbleOn && <AgentActionsBar call={call} placement="controls" hidden={hiddenAgents} />}
      {/* Rate-the-agent moved into the bubble panel (a ⭐ in the header) when the bubble is on — keep the bottom-bar entry only for the legacy (non-bubble) UI. */}
      {!bubbleOn && <HostMenuBar call={call} placement="controls" menuOrigin={menuOrigin} room={roomName} />}
      {/* Touch-only (hidden on a mouse via CSS): maximize to fill the screen —
          the one-tap replacement for the fiddly corner-drag resize. The room
          window already fills the window, so it's not shown there. */}
      {!fillMode && (
        <button
          className={`kw-ic kw-fs${fullscreen ? ' active' : ''}`}
          onClick={() => setFull((f) => !f)}
          aria-pressed={fullscreen}
          aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
          title={fullscreen ? 'Exit full screen' : 'Full screen'}
        >
          {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
        </button>
      )}
      {/* The view switcher only makes sense with ≥2 pageable views (a solo desktop call is just Speaker).
          Shown as a tappable icon in the corner panel and on DESKTOP big surfaces. On a MOBILE big surface
          the page-dots + swipe ARE the switcher (showViewDots) — so the icon is hidden there, no duplicate
          control for the same thing. */}
      <ViewSwitcher availableViews={availableViews} showViewDots={!!showViewDots} chatSplit={!!chatSplit} view={view} cycleView={cycleView} />
      {/* See-through "ghost" mode needs a host page underneath: the embedded panel — corner OR
          maximized to fullscreen. The standalone surfaces (the dedicated room window + the pop-out
          PiP window) have nothing behind them, so hide the toggle there. */}
      {/* Document-PiP (float the room into a desktop OS window) is a DESKTOP affordance, but Chromium mobile
          browsers (Samsung Internet, Android Chrome) also expose window.documentPictureInPicture — which made the
          phone show the desktop "pop out" button and suppressed the mobile video-PiP. Gate it on !canTouch so touch
          devices fall through to the video-PiP path (float the speaker over the home screen) instead. */}
      <WindowControls fillMode={fillMode} pip={!!pip} ghost={ghost} setGhost={setGhost} host={!!host} pipApi={!!pipApi && !canTouch} popOut={popOut} videoPip={videoPip} />
    </>
  )

  // Secondary controls — verify (shield) + copy-invite (link). In the big surfaces these ride the TOP
  // header (the bottom bar is crowded; the title strip is sparse), so the two bars stay balanced. In
  // the embedded panel they sit at the end of the header row with the rest.
  const secondaryControls = !preview && (
    <SecondaryControls
      hidePrivacyChrome={brand.hidePrivacyChrome}
      verifyOpen={verifyOpen}
      setVerifyOpen={setVerifyOpen}
      safetyAlarm={safetyAlarm}
      setChatOpen={setChatOpen}
      copied={copied}
      copyInvite={copyInvite}
      bigSurface={!!bigSurface}
      inviteOpen={inviteOpen}
      toggleInvite={toggleInvite}
      hostLobby={hostLobby}
      hostMenuOpen={hostMenuOpen}
      setHostMenuOpen={setHostMenuOpen}
      roomHasHost={roomHasHost}
      isVerifiedHost={call.isVerifiedHost}
      hostKeyTier={hostKeyTier}
      claimOpen={claimOpen}
      setClaimOpen={setClaimOpen}
      softHostName={softHostName}
      doClaimByName={doClaimByName}
      oidcHostEmail={oidcHostEmail}
    />
  )

  return (
    <div
      ref={panelRef}
      className={`kw-panel${ghosting ? ' kw-ghostmode' : ''}${pip ? ' kw-pip' : ''}${fullscreen ? ' kw-full' : ''}${fillMode || pip ? ' kw-fillwin' : ''}${fillMode || pip ? ' kw-winmax' : ''}${preview && !call.inCall ? ' kw-preview' : ''}${carMode && !chatOpen && !verifyOpen ? ' kw-car' : ''}${view === 'strip' && !presenter && !chatOpen && !verifyOpen ? ' kw-strip' : ''}${presenter && !carMode && !chatOpen ? ' kw-staging' : ''}${focus && !carMode && !presenter && !chatOpen && !stagedWidget ? ' kw-speaker' : ''}${chromeHidden ? ' kw-chromehidden' : ''}${fillMode && !call.inCall && !preview ? ' kw-prejoinwin' : ''}${chatSplit ? ' kw-chatsplit kw-haschat' : ''}${(presenter || stagedWidget) && !carMode ? ' kw-hasstage' : ''}`}
      style={panelStyle}
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      onKeyUp={onPanelKeyUp}
    >
      {debugEl}
      {/* Hidden sinks that PLAY each peer's staged-video SOUND (the 2nd audio lane) — their share VIDEO renders on
          the stage; this plays the matching audio. Reuses KibitzerSink so speaker-off (deaf) + the output device
          (sinkId) apply, exactly like every other participant's audio. Opt-in lane → usually empty. */}
      {/* #2: if WE hold the staged file's local copy (opt1Src), we play ITS audio via StageLocalVideo — so mute the
          presenter's share-audio (the streamed clip sound) to avoid doubling. During the gap (no copy) we DON'T mute,
          so we hear the streamed clip while we watch it. */}
      {call.participants.map((p) => (p.shareAudioStream ? <KibitzerSink key={`sa-${p.id}`} stream={p.shareAudioStream} muted={deaf || (!!opt1Src && !!presenter && p.id === presenter.id)} sinkId={call.speakerId} local={p.isSelf} /> : null))}
      {/* The staged VIDEO's control surface (presenter): a real <video controls> the presenter plays/pauses/seeks/
          mutes — a big centered overlay over the stage. MUST render whenever a video is staged (not gated on being
          the presenter), because its onCanPlay is what captures + STARTS the share — gating it would deadlock. */}
      {/* Unified fallback: the presenter renders the staged IMAGE locally here (works ALONE; independent of the share
          lane). Other participants receive it via the shared canvas track (best-effort in presentMedia). Stop is in
          the call bar (ShareControls, keyed off presentingImage). */}
      {stagedImageSrc && (
        <div className="kw-staged-vid">
          <img
            ref={(el) => { stageContentRef.current = el }}
            src={stagedImageSrc}
            alt="staged"
            style={{ pointerEvents: 'auto', maxWidth: '100%', maxHeight: '100%', borderRadius: 10, background: '#000', boxShadow: '0 6px 24px rgba(0, 0, 0, 0.5)' }}
          />
        </div>
      )}
      {/* AUDIO (or a video with no resolvable local copy) — the legacy STREAMED stage: our own master <video> + the
          custom transport bar; a captured stream reaches viewers, who scrub via the relayed bar. */}
      {stagedVideoSrc && !stageOpt1 && (
        <div className="kw-staged-vid">
          {/* Starts PAUSED on its first frame (no autoPlay) and does NOT loop (a movie shouldn't restart at the
              end). play/pause broadcast so viewers' ⏯ tracks it; a viewer's toggle (if allowed) drives this same
              element via the ctl channel. */}
          <video
            key={stagedVideoSrc}
            ref={(el) => { imgElRef.current = el; stageContentRef.current = el }}
            src={stagedVideoSrc}
            playsInline
            onCanPlay={() => void captureStagedVideo()}
            onLoadedMetadata={(e) => {
              stageDurRef.current = (e.currentTarget as HTMLVideoElement).duration || 0
              broadcastStageState()
            }}
            onTimeUpdate={(e) => {
              // ~4×/s — the master broadcasts its position so every viewer's custom scrub bar tracks it.
              stageTimeRef.current = (e.currentTarget as HTMLVideoElement).currentTime || 0
              broadcastStageState()
            }}
            onPlay={() => {
              stagePlayingRef.current = true
              broadcastStageState()
            }}
            onPause={() => {
              stagePlayingRef.current = false
              broadcastStageState()
            }}
          />
          {/* The presenter is the MASTER: this custom bar drives the real <video> directly (play/pause/seek), and
              the onPlay/onPause/onTimeUpdate handlers re-broadcast the transport so every viewer's bar syncs. The
              red ⏹ Stop (top-left) + scrub come from the SAME shared component everyone renders. */}
          <StageVideoBar
            hideStop={stageHdrCtl}
            videoRef={imgElRef}
            xport={null}
            /* No inkSlotRef here: our OWN staged-clip overlay is z:8, but our ink canvas is bumped to z:10 (so our ink
               paints over the overlay video) — a toolbar inside this overlay would sit UNDER the active canvas and its
               taps (pen re-tap, colour swatches) would be eaten. The presenter's toolbar is portaled to .kw-stage-inktop
               (z:11, above the canvas) instead — see the .kw-stage block below. */
            onStop={stopImagePresent}
            onPlayPause={() => {
              const v = imgElRef.current
              if (!v) return
              if (v.paused) void v.play().catch(() => {})
              else v.pause()
            }}
            onSeek={(t) => {
              if (imgElRef.current) imgElRef.current.currentTime = Math.max(0, t)
            }}
          />
        </div>
      )}
      {/* OPTION 1 (send-the-state) — a staged VIDEO shown from each peer's OWN local copy: a native <video controls>
          (full quality), kept in lockstep by the timeline broadcast. The authority shares only a low-fps poster
          (onPoster); followers apply the broadcast + relay their own actions back. The ⏹ Stop + ink ride a
          transport-less bar (native controls handle play/seek/scrub/volume/fullscreen). */}
      {opt1Src && (
        <div className="kw-staged-vid">
          <StageLocalVideo
            src={opt1Src}
            role={opt1Role}
            deaf={deaf}
            videoRef={imgElRef}
            xport={opt1Role === 'follower' && stageXport && presenter && stageXport.from === presenter.id ? { playing: stageXport.playing, time: stageXport.time, dur: stageXport.dur } : null}
            onPoster={() => void captureStageForOpt1()}
            onBroadcast={(s) => {
              stagePlayingRef.current = s.playing
              stageTimeRef.current = s.time
              stageDurRef.current = s.dur
              broadcastStageState()
            }}
            onCmd={(cmd) => {
              if (presenter) call.sendCtlTo(presenter.id, { t: 'stagecmd', ...cmd })
            }}
          />
          <StageVideoBar
            hideStop={stageHdrCtl}
            videoRef={null}
            xport={null}
            transport={false}
            inkSlotRef={!chatOpen ? setInkSlot : undefined}
            onStop={
              opt1Role === 'authority'
                ? stopImagePresent
                : () => {
                    if (presenter) call.sendCtlTo(presenter.id, { t: 'stagecmd', cmd: 'offstage' })
                  }
            }
          />
        </div>
      )}
      {/* A bounded WIDGET (a map) on the shared stage — a full-bleed, INTERACTIVE overlay every peer renders from
          the same instance data (unlike a screen-share, it isn't a video, so everyone can pan + drop shared pins).
          Driven by the roster-meta `stageWidget` pointer (stageWidget.ts): anyone pushed it; the newest push wins;
          anyone can take it off. Gated by the kbz.mapWidget flag and only while we actually hold the instance. */}
      <StagedWidget call={call} preview={!!preview} someonePresenting={someonePresenting} stagedWidget={stagedWidget} mapInstances={mapInstances} widgetInstances={widgetInstances} dropMapPin={dropMapPin} driveMapView={driveMapView} stageMapWidget={stageMapWidget} />
      {/* The dedicated room window's PRE-JOIN screen drops the header entirely (just an ✕ top-left). */}
      {!(fillMode && !call.inCall && !preview) && (
      <div
        className="kw-head"
        onPointerDown={onBarDown}
        onPointerMove={onBarMove}
        onPointerUp={onBarUp}
        onPointerCancel={onBarUp}
        onClickCapture={onBarClickCapture}
      >
        <span className="kw-title">
          {call.inCall ? (
            <span className="kw-rostercount" title={`${call.rosterCount} in the call`}>
              <PeopleIcon /> {call.rosterCount}
            </span>
          ) : (
            `${brandName} · ${roomName}`
          )}
        </span>
        {/* Stage controls — DIRECT children of the header so they share its height + gap (align with the roster count
            and the right-side buttons, instead of being nested in the title). Shown only while staging: a SHARED
            ⏹ Stop (two-tap confirm — it takes content off-stage for everyone) + a LOCAL ⛶ full-screen. */}
        {stageHdrCtl && (
          <>
            <button
              type="button"
              className={`kw-ic kw-stagehdr-stop${stopArmed ? ' armed' : ''}`}
              onClick={() => (stopArmed ? (setStopArmed(false), leaveStage()) : setStopArmed(true))}
              aria-label="Stop showing on stage"
              title={stopArmed ? 'Tap again to stop showing on stage' : 'Stop showing on stage'}
            >
              {stopArmed ? <span className="kw-stophint">Stop?</span> : <StopIcon />}
            </button>
            <button
              type="button"
              className="kw-ic"
              onClick={toggleStageFs}
              aria-pressed={stageBig}
              aria-label={stageBig ? 'Exit full screen' : 'Full screen'}
              title={stageBig ? 'Exit full screen' : 'Full screen'}
            >
              {stageBig ? <MinimizeIcon /> : <MaximizeIcon />}
            </button>
          </>
        )}
        <span className="kw-spacer" />
        {/* When the primary controls ride a bottom bar — the big surfaces (`bottomBar`) AND the embedded
            tile view (`embedBar`) — the header keeps only the secondary ones (verify + invite) so the two
            bars stay balanced. Otherwise (chat/verify takeover on the embed) ALL controls live in the
            header, in their own span so ghost mode can fade just them, leaving the title strip tappable. */}
        {call.inCall &&
          (bottomBar || embedBar ? (
            secondaryControls
          ) : (
            <span className="kw-headctrls">
              {callControls}
              {secondaryControls}
            </span>
          ))}
        {/* Minimize-to-pill is for the embedded corner panel (collapse to a floating mic bubble over the
            host page). The dedicated room window has ← Home + ✕ Leave instead, so hide it there. */}
        {!fillMode && (
          <button className="kw-ic" onClick={() => setOpen(false)} title="Minimize to a bubble">
            –
          </button>
        )}
        {call.inCall && (
          <button
            className={`kw-ic leave${leaveArmed ? ' armed' : ''}`}
            onClick={() => {
              if (leaveArmed) {
                if (leaveArmTimer.current) clearTimeout(leaveArmTimer.current)
                setLeaveArmed(false)
                leaveCall()
              } else {
                setLeaveArmed(true)
                if (leaveArmTimer.current) clearTimeout(leaveArmTimer.current)
                leaveArmTimer.current = setTimeout(() => setLeaveArmed(false), 3000)
              }
            }}
            title={leaveArmed ? 'Tap again to leave' : 'Leave room'}
            aria-label={leaveArmed ? 'Tap again to leave the room' : 'Leave the room'}
          >
            {leaveArmed ? 'Leave?' : <CloseIcon />}
          </button>
        )}
      </div>
      )}
      {/* Car mode hides the top bar; this standalone Leave ✕ mirrors the top-bar ✕ (same look via .kw-ic.leave,
          same arm-then-confirm) in the same top-right spot, so hanging up stays one tap. */}
      {carMode && call.inCall && (
        <button
          className={`kw-ic leave kw-car-x${leaveArmed ? ' armed' : ''}`}
          onClick={() => {
            if (leaveArmed) {
              if (leaveArmTimer.current) clearTimeout(leaveArmTimer.current)
              setLeaveArmed(false)
              leaveCall()
            } else {
              setLeaveArmed(true)
              if (leaveArmTimer.current) clearTimeout(leaveArmTimer.current)
              leaveArmTimer.current = setTimeout(() => setLeaveArmed(false), 3000)
            }
          }}
          title={leaveArmed ? 'Tap again to leave' : 'Leave room'}
          aria-label={leaveArmed ? 'Tap again to leave the room' : 'Leave the room'}
        >
          {leaveArmed ? 'Leave?' : <CloseIcon />}
        </button>
      )}
      {fillMode && !call.inCall && !preview && (onExit || returnUrl) && (
        <button
          className="kw-prejoin-x"
          onClick={() => {
            stopPreview()
            // Same "return home" as hanging up: if the brand set a back-link (e.g. the gift dashboard), go there
            // instead of dumping onto the app's landing — and splash first so the landing never flashes. Only
            // fall back to the app's own exit when there's no back-link.
            if (returnHome()) return
            onExit?.()
          }}
          aria-label="Close"
          title="Close"
        >
          <CloseIcon />
        </button>
      )}

      {/* (Removed the "share your screen" nudge banner — the screen-share icon in the controls already offers it.) */}

      {/* Brand "Summon an AI agent" CTA — a top banner (mirrors the share-screen nudge). When the brand
          wired ONE-TAP summon (`summonApi`) it NEVER opens a page: with the room link's summon key it POSTs
          the key (the brand re-launches from stored params, no coupon); on a transient failure the button
          just retries. Without a key it doesn't show (no wizard fallback). A brand that set ONLY `summonPath`
          (never wired one-tap) opens that wizard instead. Generic product sets neither → no banner. Dismissible. */}
      {call.inCall && !preview && fill && (summonApi ? !!summonKey : !!summonPath) && !agentPresent && summonNudge && !chromeHidden && !bubbleOn && (
        <div
          className="kw-summon-nudge"
          style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px', padding: '10px 12px', borderRadius: 10, background: 'rgba(120,110,255,0.18)', fontSize: '0.95em', lineHeight: 1.35 }}
        >
          {summonBusy === 'summoning' && !summonSlow ? (
            // SUMMONING: the agent is cold-starting + joining (no instant feedback otherwise). Spinner + a staged
            // message; this runs until the agent appears on the roster (agentPresent → the nudge hides).
            <>
              <span className="kw-summon-spin" aria-hidden="true" />
              <span style={{ flex: 1 }}>
                {summonElapsed < 8000
                  ? agentResumable
                    ? 'Bringing your agent back…'
                    : 'Summoning your agent…'
                  : 'First launch can take ~20 seconds — almost there…'}
              </span>
            </>
          ) : (
            <>
              <span style={{ flex: 1 }}>
                {summonSlow
                  ? '⚠️ This is taking longer than usual — you can try again.'
                  : summonBusy === 'neterror'
                    ? "⚠️ Couldn't reach the agent service — check your connection (some firewalls/Wi-Fi block it)."
                    : summonBusy === 'error'
                      ? "⚠️ Couldn't summon — the link may have expired."
                      : agentResumable
                        ? '🤖 Your agent left — bring it back (it picks up where you left off).'
                        : '🤖 Add an AI agent to this call.'}
              </span>
              <button type="button" className="kw-summon-cta" disabled={summonBusy === 'sending'} onClick={summonAgent}>
                {summonBusy === 'sending' ? '…' : summonSlow || summonBusy === 'error' || summonBusy === 'neterror' ? 'Try again' : agentResumable ? 'Bring it back' : 'Summon'}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setSummonNudge(false)}
            aria-label="Dismiss"
            title="Not now"
            style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', opacity: 0.6, padding: '0 2px', alignSelf: 'flex-start' }}
          >
            ✕
          </button>
        </div>
      )}

      {call.inCall && pickerOpen && (
        <AvatarPicker avatar={call.avatar} setAvatar={call.setAvatar} onPick={() => setPickerOpen(false)} />
      )}

      {inviteOpen && call.inCall && (
        // In-call: centre it over the call (the panel IS the call area). The PRE-JOIN copy lives inside .kw-pre
        // (above), so it centres on the video tile rather than the whole lobby window.
        <InvitePanel inviteUrl={inviteUrl} copied={copied} onClose={() => setInviteOpen(false)} onCopy={copyInvite} />
      )}

      {call.inCall && ghost && !fillMode && !pip && (
        <div className="kw-oprow">
          <span aria-hidden="true" title="Transparency">
            ▒
          </span>
          <input
            className="kw-op"
            type="range"
            min={0}
            max={92}
            value={Math.round(transparency * 100)}
            onChange={(e) => {
              const v = Number(e.target.value) / 100
              setTransparency(v)
              try {
                localStorage.setItem(OP_KEY, String(v))
              } catch {
                /* ignore */
              }
            }}
            aria-label="Video transparency"
          />
        </div>
      )}

      {claimOpen && roomHasHost && !call.isVerifiedHost && (
        <ClaimAdminDialog
          pw={claimPw}
          err={claimErr}
          onPwChange={(v) => {
            setClaimPw(v)
            setClaimErr(false)
          }}
          onSubmit={doClaim}
          onClose={() => setClaimOpen(false)}
        />
      )}

      {hostLobby.canGate && hostMenuOpen && (
        <HostToolsMenu
          hostLobby={hostLobby}
          identityEnabled={call.identityEnabled}
          requireVerified={requireVerified}
          setRequireVerified={setRequireVerified}
          guestEmails={guestEmails}
          setGuestEmails={setGuestEmails}
          guestInput={guestInput}
          setGuestInput={setGuestInput}
          bannedEmails={bannedEmails}
          setBannedEmails={setBannedEmails}
          roomKey={roomKey}
          onClose={() => setHostMenuOpen(false)}
        />
      )}

      {payRequests
        .filter((p) => !p.self && !payDismissed.has(p.id))
        .slice(-3)
        .map((p) => {
          const link = normalizePayLink(p.url)
          return (
            <div key={p.id} className="kw-pay">
              <button
                className="kw-pay-x"
                onClick={() => setPayDismissed((s) => new Set(s).add(p.id))}
                aria-label="Dismiss"
                title="Dismiss"
              >
                ✕
              </button>
              <div className="kw-pay-head">
                💳 <strong>{p.name || 'Someone'}</strong> requests payment{p.dm ? ' (just from you 🔒)' : ''}
              </div>
              {p.label && <div className="kw-pay-note">{p.label}</div>}
              {link ? (
                <>
                  <a className="kw-pay-link" href={link.href} target="_blank" rel="noopener noreferrer nofollow">
                    {link.display}
                  </a>
                  <QrBox text={link.display} className="kw-pay-qr" />
                  <p className="kw-pay-fine">Scan or tap to pay them directly — Kibitz never touches the money.</p>
                </>
              ) : (
                <p className="kw-pay-fine">This payment link looked unsafe and was hidden.</p>
              )}
            </div>
          )
        })}

      {idle.nudging && (
        // useIdleNudge listens on WINDOW for pointerdown/touchstart/keydown as "user is active" → bump() clears
        // the nudge. A tap on THESE buttons is one of those events, so it would unmount the prompt BEFORE the
        // button's onClick runs — silently dropping "Leave the call" / "Don't ask again" ("Yes, keep going" only
        // survived because bump == stay). Stop the tap from reaching the window listeners so onClick fires.
        <div
          className="kw-knock"
          onPointerDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="kw-knock-icon" aria-hidden="true">
            👋
          </div>
          <p className="kw-knock-title">Still there?</p>
          <p className="kw-hint">The call's been quiet for a while — keep it going?</p>
          <button className="kw-invite" onClick={() => idle.stay()}>
            Yes, keep going
          </button>
          <button className="kw-invite" onClick={() => leaveCall()}>
            Leave the call
          </button>
          <button
            onClick={() => setNudgeOff(true)}
            style={{ background: 'none', border: 'none', color: 'inherit', opacity: 0.6, fontSize: '0.8em', textDecoration: 'underline', cursor: 'pointer', marginTop: '6px' }}
          >
            Don't ask again on this call
          </button>
        </div>
      )}

      {kicked ? (
        <div className="kw-knock">
          <div className="kw-knock-icon" aria-hidden="true">
            🚫
          </div>
          <p className="kw-knock-title">The host removed you from the room.</p>
          <p className="kw-hint">You'd need the host to let you back in. Ask them if you think this was a mistake.</p>
          <button className="kw-invite" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      ) : lobbyStatus ? (
        <div className="kw-knock">
          {lobbyStatus === 'waiting' ? (
            <>
              <div className="kw-knock-icon kw-knock-wave" aria-hidden="true">
                ✋
              </div>
              <p className="kw-knock-title">Waiting for the host…</p>
              <p className="kw-hint">
                You've knocked — the host needs to let you in before you can join. Keep this open.
              </p>
              <input
                className="kw-knock-name"
                value={name}
                maxLength={14}
                placeholder="Your name"
                onChange={(e) => setName(e.target.value)}
                aria-label="Your name — shown to the host while you wait"
              />
            </>
          ) : lobbyStatus === 'locked' ? (
            <>
              <div className="kw-knock-icon" aria-hidden="true">
                🔐
              </div>
              <p className="kw-knock-title">This room is locked.</p>
              <p className="kw-hint">The host has sealed it to new people. Ask them to unlock it, or close this.</p>
              <button className="kw-invite" onClick={() => setOpen(false)}>
                Close
              </button>
            </>
          ) : lobbyStatus === 'unverified' && joinGate?.mode === 'invite' ? (
            <>
              <div className="kw-knock-icon" aria-hidden="true">
                🎟️
              </div>
              <p className="kw-knock-title">This room is invite-only.</p>
              <p className="kw-hint">Open your personal invite link, or paste it here to be let in.</p>
              <form
                className="kw-guestadd"
                onSubmit={(e) => {
                  e.preventDefault()
                  const tok = tokenFromPaste(inviteInput)
                  if (tok) room?.link.setIdentityToken?.(tok)
                }}
              >
                <input
                  className="kw-guestinput"
                  value={inviteInput}
                  onChange={(e) => setInviteInput(e.target.value)}
                  placeholder="paste your invite…"
                  aria-label="Paste your invite link or token"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button className="kw-guestaddbtn" type="submit">
                  Enter
                </button>
              </form>
              <button className="kw-invite" onClick={() => setOpen(false)}>
                Close
              </button>
            </>
          ) : lobbyStatus === 'unverified' && joinGate?.mode === 'names' ? (
            <>
              <div className="kw-knock-icon" aria-hidden="true">
                🪪
              </div>
              <p className="kw-knock-title">Who are you?</p>
              <p className="kw-hint">Pick your name to join.</p>
              <div className="kw-guests">
                {(joinGate.names ?? []).map((n) => (
                  <button key={n} className="kw-lobtoggle" onClick={() => room?.link.setIdentityToken?.(n)}>
                    {n}
                  </button>
                ))}
              </div>
              <button className="kw-invite" onClick={() => setOpen(false)}>
                Close
              </button>
            </>
          ) : lobbyStatus === 'unverified' ? (
            <>
              <div className="kw-knock-icon" aria-hidden="true">
                🛡️
              </div>
              <p className="kw-knock-title">This room is for verified people.</p>
              <p className="kw-hint">
                Sign in to prove who you are, then you'll be let in. The host only admits guests with a verified
                identity.
              </p>
              {verifyIdentity && <div ref={mountSignin} className="kw-id-gbtn" />}
              <button className="kw-invite" onClick={() => setOpen(false)}>
                Close
              </button>
            </>
          ) : (
            <>
              <div className="kw-knock-icon" aria-hidden="true">
                🚪
              </div>
              <p className="kw-knock-title">The host didn't let you in.</p>
              <p className="kw-hint">Ask them for a fresh link, or close this.</p>
              <button className="kw-invite" onClick={() => setOpen(false)}>
                Close
              </button>
            </>
          )}
        </div>
      ) : call.inCall ? (
        <>
          {/* Verified-roster (docs §7) status. Priority: my own off-roster sign-in (the host
              self-gate — actionable by me) → an intruder present (compromised — leave) → a
              transient "verifying everyone" hold. Sharing is already blocked in useCall; this
              tells the user WHY and what to do. */}
          {notOnRoster ? (
            <div className="kw-rosteralarm" role="alert">
              <span className="kw-rosteralarm-i">⚠️</span>
              <div className="kw-rosteralarm-tx">
                <strong>You're not on this room's roster.</strong>
                <span>
                  {' '}
                  Signed in as {call.selfIdentity?.email} — but the room was created for specific people, so others
                  won't accept content from you. Sign in with a listed account.
                </span>
              </div>
            </div>
          ) : rosterCompromised ? (
            <div className="kw-rosteralarm" role="alert">
              <span className="kw-rosteralarm-i">⚠️</span>
              <div className="kw-rosteralarm-tx">
                <strong>Someone here isn't on the verified roster.</strong>
                <span> Sharing is blocked — an unlisted person is in the room. Leave to stay safe.</span>
                {rg.peers
                  .filter((p) => p.state === 'rejected' && p.identity)
                  .map((p) => (
                    <span key={p.id} className="kw-rosteralarm-id">
                      {p.identity}
                    </span>
                  ))}
              </div>
              <button className="kw-rosteralarm-go" onClick={leaveCall}>
                Leave
              </button>
            </div>
          ) : rosterHolding ? (
            <div className="kw-rosterhold" role="status">
              🔒 Verifying everyone in the room… sharing is paused until each person proves they're on the roster.
            </div>
          ) : null}
          {/* The tiles stay MOUNTED while chat is open (display:none) — the remote
              <audio>/<video> sinks live in them, and unmounting would silence the
              call mid-chat. With a presenter, their screen is the big letterboxed
              stage and everyone else drops to a face strip. */}
          {/* Body region (stage + verify + chat). On a big surface with chat open it becomes a SPLIT
              container (kw-chatsplit on the panel): portrait stacks tiles-strip + chat, landscape/desktop
              puts them side by side. Otherwise it's a plain column and chat/verify take it over. */}
          <div className="kw-bodysplit">
          <div
            className="kw-stagewrap"
            ref={tilesRef}
            onPointerDown={onStageSwipeDown}
            onPointerUp={onStageSwipeUp}
            onPointerCancel={onStageSwipeUp}
            style={verifyOpen || (chatOpen && !chatSplit) ? { display: 'none' } : undefined}
          >
            {/* Agent menus that asked to live on the call surface: a top bar ('stage') or a corner
                card ('tile'). Each renders nothing unless an agent requested that placement. They sit
                over the video as overlays (pointer-events scoped to the chips) so taps pass through.
                Only while actually viewing the call — not in car mode (no video) nor behind chat/verify
                (the wrap is display:none then, which would leave focusable buttons in the DOM). */}
            {!carMode && !chatOpen && !verifyOpen && (
              <>
                {!bubbleOn && (
                  <>
                    <AgentActionsBar call={call} placement="stage" hidden={hiddenAgents} />
                    <AgentActionsBar call={call} placement="tile" hidden={hiddenAgents} />
                  </>
                )}
                <HostMenuBar call={call} placement="stage" menuOrigin={menuOrigin} room={roomName} />
              </>
            )}
            {carMode ? (
              <div className="kw-carview">
                <div className="kw-car-status">
                  <span className="kw-car-title">
                    {carSpeaker ? carSpeaker.name || 'Someone' : `${call.rosterCount} in the call`}
                  </span>
                  <span className="kw-car-sub">{carSpeaker ? 'speaking…' : 'Driving mode — video hidden'}</span>
                </div>
                <button
                  className={`kw-car-mic${call.micOn ? '' : ' off'}`}
                  onClick={() => void call.toggleMic()}
                  aria-pressed={call.micOn}
                  aria-label={call.micOn ? 'Mute microphone' : 'Unmute microphone'}
                >
                  {call.micOn ? <MicIcon /> : <MicOffIcon />}
                </button>
                <span className="kw-car-hint">{call.micOn ? 'Tap to mute' : 'Muted — tap to talk'}</span>
              </div>
            ) : focus ? (
              <>
                <div
                  className={`kw-stage${presenter ? ' kw-zoomable' : ''}${zoom.zoomed ? ' kw-zoomclip' : ''}${stageBig ? ' kw-stagemax' : ''}`}
                  ref={setStageEl}
                  style={tileH ? { height: tileH, aspectRatio: 'auto', maxHeight: 'none' } : undefined}
                >
                  {/* The zoom layer scales the video AND the ink (passed the same transform)
                      so annotations stay pinned to the screen while you pinch in. */}
                  <div className="kw-zoomlayer" style={{ transform: zoom.transform, transformOrigin: '0 0', willChange: zoom.zoomed ? 'transform' : undefined }}>
                    <Tile
                      // Key the STAGE tile on the presenter's SHARE TRACK id, not just their peer id: when a viewer
                      // rejoins, the presenter's id is unchanged so the tile wouldn't remount, and iOS WebKit won't
                      // repaint a fresh share track onto the existing (stale) <video> — it just shows black. A new
                      // share track id forces a remount → a fresh <video> that iOS actually paints. (Chromium repaints
                      // in place either way, so this only changes iOS behaviour.)
                      key={presenter ? `${focus.id}:${focus.shareStream?.getVideoTracks()[0]?.id ?? 'none'}` : focus.id}
                      // On the stage we show the presenter's SHARE (their dedicated share lane), forcing video;
                      // a plain active-speaker focus (no presenter) shows their camera as usual.
                      // While WE stage a VIDEO, the control overlay shows it — blank the stage Tile's captured copy
                      // so the presenter doesn't see it twice. For AUDIO there's no picture overlap, so keep the
                      // 🎵 card on our own stage too. Peers always get the share.
                      p={presenter ? { ...focus, stream: focus.isSelf && ((stagedVideoSrc && !stagedIsAudio) || stagedImageSrc) ? null : focus.shareStream, cam: true, mirror: false } : focus}
                      speaking={speaking.has(focus.id)}
                      micOn={call.micOn}
                      onBlocked={onBlocked}
                      onFlip={focus.isSelf && call.canFlip ? () => void call.flipCam() : undefined}
                      {...tileExtras(focus)}
                      stage={!!presenter}
                    />
                  </div>
                  {/* Ink/pointer only over a shared SCREEN — annotating someone's face is pointless. The
                      toolbar is portalled to the slot below (out of the stage's tap-eating subtree). */}
                  {presenter && !preview && (
                    <StageInk room={inkApi} stageRef={stageRef} contentRef={stageContentRef} zoomTransform={zoom.transform} toolbarSlot={inkSlot} onActiveChange={setInkActive} selfId={selfId} imageKey={typeof presenter?.meta?.stageImage === 'string' ? (presenter.meta.stageImage as string) : undefined} />
                  )}
                  {/* Ink toolbar slot for OUR OWN staged clip — sits INSIDE .kw-stage at z:11, ABOVE the ink canvas
                      (z:10, bumped by :has(.kw-staged-vid)) so its buttons + colour palette stay tappable while a tool
                      is armed. (The overlay's own inkslot is z:8 → under the canvas → dead taps.) Rendered only for the
                      self-presenter's clip with chat closed; a viewer's toolbar rides its in-stage StageVideoBar (below,
                      where the viewer's canvas isn't bumped), and a screen-share uses .kw-toolslot in .kw-side. */}
                  {presenter?.isSelf && !preview && !chatOpen && stagedClipBar && <div className="kw-stage-inktop" ref={setInkSlot} />}
                  {zoom.zoomed && (
                    <button className="kw-zoomreset" onClick={zoom.reset} title="Reset zoom (or double-tap)" aria-label="Reset zoom">
                      ⤢ 1×
                    </button>
                  )}
                  {/* Viewer's synced control bar for the presenter's STREAMED staged clip — RELAYS play/pause/seek/
                      offstage to the master over ctl. Shown only when we're a viewer of a streamed clip AND we don't
                      have a local copy (opt1Src) — with a local copy the native-controls option-1 overlay owns it. */}
                  {presenter && !presenter.isSelf && stageXport && stageXport.from === presenter.id && !opt1Src && (
                    <StageVideoBar
                      hideStop={stageHdrCtl}
                      videoRef={null}
                      xport={stageXport}
                      inkSlotRef={!chatOpen ? setInkSlot : undefined}
                      onStop={() => call.sendCtlTo(presenter.id, { t: 'stagecmd', cmd: 'offstage' })}
                      onPlayPause={() => call.sendCtlTo(presenter.id, { t: 'stagecmd', cmd: stageXport.playing ? 'pause' : 'play' })}
                      onSeek={(t) => call.sendCtlTo(presenter.id, { t: 'stagecmd', cmd: 'seek', time: t })}
                    />
                  )}
                  {/* Enter full-screen lives in the HEADER now. This on-stage button is the EXIT only — shown when
                      maxed, because the CSS-max overlay covers the header, so the way back must sit ON the stage. */}
                  {presenter && !preview && stageBig && (
                    <button
                      className="kw-stagefs active"
                      onClick={toggleStageFs}
                      title="Exit full screen"
                      aria-label="Exit full screen"
                      aria-pressed={true}
                    >
                      <MinimizeIcon />
                    </button>
                  )}
                </div>
                {/* The tiles + the ink toolbar share the SIDE area (a right column in landscape/desktop,
                    a bottom strip in portrait). The toolbar portals into kw-toolslot — placed here, OUTSIDE
                    the stage, so it's always tappable. */}
                {(focusOthers.length > 0 || (presenter && !preview)) && (
                  <div className="kw-side" data-faces={focusOthers.length}>
                    {focusOthers.length > 0 && (
                      <div className="kw-grid kw-faces">
                        {focusOthers.map((p) => (
                          <Tile
                            key={p.id}
                            p={p}
                            speaking={speaking.has(p.id)}
                            micOn={call.micOn}
                            onBlocked={onBlocked}
                            onFlip={p.isSelf && call.canFlip ? () => void call.flipCam() : undefined}
                            {...tileExtras(p)}
                          />
                        ))}
                      </div>
                    )}
                    {/* Pen toolbar lives here ONLY when chat is closed; with chat open it moves into the
                        chat box (above the composer) so the tiles column stays clean. */}
                    {presenter && !preview && !chatOpen && !stagedClipBar && <div className="kw-toolslot" ref={setInkSlot} />}
                  </div>
                )}
              </>
            ) : (
              <div
                className={`kw-grid${
                  tileParticipants.length === 1 ? ' kw-solo' : tileParticipants.length <= 2 ? ' kw-duo' : ''
                }`}
                data-tiles={tileParticipants.length}
                style={tileH ? { height: tileH } : undefined}
              >
                {tileParticipants.map((p) => (
                  <Tile
                    key={p.id}
                    p={p}
                    speaking={speaking.has(p.id)}
                    micOn={call.micOn}
                    onBlocked={onBlocked}
                    onFlip={p.isSelf && call.canFlip ? () => void call.flipCam() : undefined}
                    {...tileExtras(p)}
                  />
                ))}
              </div>
            )}
            {/* Kibitzers get no tile — but we still play their audio so an unseen agent can be HEARD.
                Speaker-off (deaf) mutes them too, like every other participant. */}
            {kibitzerStreams.map((p) => (
              <KibitzerSink key={p.id} stream={p.stream!} muted={deaf} sinkId={call.speakerId} local={p.isSelf} />
            ))}
            {/* Zoom-style page dots: one per pageable view (Speaker · Car solo; + Gallery in a group). */}
            {showViewDots && (
              <div className="kw-viewdots" role="tablist" aria-label="Switch layout">
                {availableViews.map((v) => (
                  <button
                    key={v}
                    className={`kw-viewdot${view === v ? ' on' : ''}`}
                    role="tab"
                    aria-selected={view === v}
                    aria-label={`${VIEW_LABEL[v]} view`}
                    title={`${VIEW_LABEL[v]} view`}
                    onClick={() => selectView(v)}
                  />
                ))}
              </div>
            )}
          </div>
          {hostLobby.isHost && (
            <AgentConsent
              agents={call.participants
                .filter((p) => !p.isSelf && p.meta?.role === 'agent')
                .map((p) => ({ id: p.id, name: p.name }))}
              getGrant={call.getCapabilityGrant}
              setGrant={call.setCapabilityGrant}
              getAudit={call.getAgentAudit}
            />
          )}
          {verifyOpen && (
            <VerifyPanel
              identityEnabled={call.identityEnabled}
              selfIdentity={call.selfIdentity}
              verifyPeers={verifyPeers}
              safety={safety}
              identities={identities}
              verify={verify}
              unverify={unverify}
              mountSignin={mountSignin}
            />
          )}
          {chatOpen && (
            <div className="kw-chat">
              <AgentActionsBar call={call} placement="chat" hidden={hiddenAgents} />
              <div className="kw-msgs" ref={msgsRef}>
                {call.chat.length === 0 && !brand.hidePrivacyChrome && (
                  <p className="kw-chat-hint">
                    Peer-to-peer and ephemeral — only people here right now see this, and nothing is stored anywhere.
                  </p>
                )}
                {call.chat.map((m) =>
                  m.widget ? (
                    <WidgetBubble key={m.id} m={m} call={call} preview={!!preview} mapInstances={mapInstances} widgetInstances={widgetInstances} stagedWidget={stagedWidget} dropMapPin={dropMapPin} stageMapWidget={stageMapWidget} stageWidgetPixels={STAGE_WIDGET_PIXELS ? stageWidgetPixels : undefined} dismiss={dismissWidget} />
                  ) : (
                    <ChatMessage key={m.id} m={m} call={call} deaf={deaf} preview={!!preview} presentMedia={presentMedia} />
                  ),
                )}
              </div>
              {payOpen && (
                <div className="kw-payform">
                  <input
                    className="kw-pay-in"
                    value={payDraft}
                    maxLength={512}
                    placeholder="Your payment link (Stripe, PayPal, Lightning…)"
                    onChange={(e) => {
                      setPayDraft(e.target.value)
                      setPayErr(null)
                    }}
                  />
                  <input
                    className="kw-pay-in"
                    value={payNote}
                    maxLength={80}
                    placeholder="Note (optional) — e.g. $20 for lunch"
                    onChange={(e) => setPayNote(e.target.value)}
                  />
                  {payErr && <p className="kw-pay-err">{payErr}</p>}
                  <div className="kw-payform-row">
                    <button type="button" className="kw-pay-send" onClick={sendPayRequest} disabled={!payDraft.trim()}>
                      Request payment
                    </button>
                    <button
                      type="button"
                      className="kw-pay-cancel"
                      onClick={() => {
                        setPayOpen(false)
                        setPayErr(null)
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                  <p className="kw-pay-fine">{brandName} only shares the link — your money moves on the provider, never through us.</p>
                </div>
              )}
              <ChatComposer
                draft={draft}
                setDraft={setDraft}
                sendDraft={sendDraft}
                recipients={recipients}
                recipientId={recipientId}
                setRecipientId={setRecipientId}
                presenter={!!presenter}
                preview={!!preview}
                setInkSlot={setInkSlot}
                sendImageAttach={sendImageAttach}
                sendAttachFile={sendAttachFile}
                rg={rg}
                rosterCompromised={rosterCompromised}
                onFocusChange={setComposerFocused}
              />
              {/* Chatsplit: the control bar sits UNDER the composer (in the chat column), not full-width across
                  the bottom — the people rail gets the full height beside it, and only the top bar auto-hides. */}
              {/* Hide the control bar while the message input is focused — no need for the mic/cam/etc. row
                  crammed above the keyboard while typing; it returns the moment you blur (tap Done / send). */}
              {chatSplit && !composerFocused && <div className="kw-controlbar kw-controlbar-inchat">{callControls}</div>}
            </div>
          )}
          </div>
          {call.error && <p className="kw-error">{call.error}</p>}
          {/* Zoom-style bottom control bar. Big surfaces (room window / full screen): an in-flow bar that
              collapses with the rest of the chrome. Embedded tile view (`embedBar`): the SAME controls,
              but the bar (`kw-controlbar-float`) floats over the foot of the tile and only it auto-hides —
              the top bar stays, and because it's an overlay the tile never resizes when it goes. */}
          {(bottomBar || embedBar) && !chatSplit && (
            <div className={`kw-controlbar${embedBar ? ' kw-controlbar-float' : ''}`}>{callControls}</div>
          )}
          {/* Floating agent-control bubble — a top-level overlay on the FIXED panel, so its offsetParent is
              the whole window: draggable anywhere over the call (incl. the speaker/stage tile), never confined
              to a sub-region, and unaffected by the top bar auto-hiding. Clamped in JS to stay clear of the
              bottom control bar. */}
          {bubbleOn && (
            <AgentBubbleLayer
              call={call}
              isCreator={!!summonKey}
              summonAgent={summonAgent}
              summoning={summonBusy === 'summoning'}
              agentResumable={agentResumable}
              speaking={speaking}
              menuOrigin={menuOrigin}
              room={roomName}
              hidden={hiddenAgents}
              topupUrl={brand.topupUrl}
            />
          )}
          {/* A FLOATING mic reminder — like the agent bubble, it lives at the panel level (above the tiles/stage),
              not anchored to the bottom-bar mic icon (where the video tiles buried it). Tap the pill to unmute; tap
              the ✕ to dismiss it without unmuting. */}
          {micNudge && !micNudgeDismissed && (
            <div className="kw-micnudge">
              <button type="button" className="kw-micnudge-main" onClick={() => void call.toggleMic()} aria-label="Your mic is off — tap to unmute">
                <MicOffIcon /> Tap to unmute
              </button>
              <button type="button" className="kw-micnudge-x" onClick={() => setMicNudgeDismissed(true)} aria-label="Dismiss">
                ✕
              </button>
            </div>
          )}
        </>
      ) : needsGesture ? (
        // autoJoin on a touch device with audio still locked: ONE entry tap that unlocks the agent's voice and joins.
        // Not a device lobby, not a "tap for sound" nag — the natural "enter the call" gesture the gift path skips.
        <div className="kw-lobby kw-autojoin kw-autojoin-gate">
          <button type="button" className="kw-autojoin-tap" onClick={gestureJoin}>
            <span className="kw-autojoin-play kw-autojoin-mic" aria-hidden="true">
              <MicIcon />
            </span>
            <p className="kw-autojoin-tx">Tap to join &amp; talk</p>
          </button>
        </div>
      ) : autoJoinSplash ? (
        // Lobby-skip: a clean centred "joining…" splash instead of the pre-join lobby, so it reads as one smooth
        // hop into the call (no flash of the lobby while the room connects).
        <div className="kw-lobby kw-autojoin">
          <div className="kw-autojoin-inner">
            <span className="kw-join-spin" aria-hidden="true" />
            <p className="kw-autojoin-tx">{joinSlow ? 'Still connecting…' : 'Joining…'}</p>
          </div>
        </div>
      ) : (
        <div className="kw-lobby">
          {call.retired && (
            <div className="kw-retired" role="alert">
              <strong>⚠️ This version is out of date</strong>
              <span>
                {call.retired.message ||
                  `This build of ${brandName} has been retired for security. Reload the page to get the latest.`}
              </span>
              <button type="button" className="kw-retired-reload" onClick={() => location.reload()}>
                Reload
              </button>
            </div>
          )}
          {!preview && !headless && (
            <div className="kw-pre">
              <PreviewTile preCam={preCam} previewStream={previewStream} previewVidEl={previewVidEl} preFacing={preFacing} name={name} preSpeaker={preSpeaker} setPreSpeaker={setPreSpeaker} flipPre={flipPre} preMic={preMic} togglePreMic={togglePreMic} togglePreCam={togglePreCam} />
              {previewErr && <p className="kw-pre-err">{previewErr}</p>}
              <p className="kw-pre-title">
                <span className="kw-pre-roomlbl">ROOM</span> {roomDesc || roomName}
              </p>
              {/* Pre-join invite: render it INSIDE the tile region so it centres on the video tile, not the whole
                  lobby window. The panel-level copy below covers the in-call case (there the panel IS the call). */}
              {inviteOpen && (
                <InvitePanel inviteUrl={inviteUrl} copied={copied} onClose={() => setInviteOpen(false)} onCopy={copyInvite} />
              )}
            </div>
          )}
          {/* Everything except the preview — stacks below the tile in portrait, sits beside it in landscape. */}
          <div className="kw-lobby-form">
          {/* Device pickers: pick which mic / camera / speaker to use. On DESKTOP (no touch) show a
              selector whenever a device of that kind exists (>0); on touch show mic/speaker only with a
              real choice (>1). The CAMERA picker is DESKTOP-ONLY: phones enumerate several lenses (front,
              ultra-wide, tele…) so ">1" is always true there, and the flip button already covers front/rear
              — a raw lens dropdown is just clutter on mobile. Labels appear once media permission is granted;
              the speaker (output) needs setSinkId (Chromium). */}
          <PreJoinDevices mics={mics} cams={cams} speakers={speakers} canTouch={canTouch} preMicId={preMicId} selectMic={selectMic} preCamId={preCamId} selectCam={selectCam} preSpeakerId={preSpeakerId} setPreSpeakerId={setPreSpeakerId} />
          {/* One banner: the generic AI-consent warning WITH the room's specific disclosure folded in as a
              sub-line (was two near-identical boxes — a red generic + a yellow specific). */}
          <AgentWarn agentCall={agentCall} notice={notice} />
          {wantRejoin && !rejoinDismissed && (
            <div className="kw-rejoin">
              <span className="kw-rejoin-ico" aria-hidden="true">
                ↻
              </span>
              <span className="kw-rejoin-txt">You were just in this call.</span>
            </div>
          )}
          {call.identityEnabled &&
            (call.selfIdentity ? (
              <div className="kw-id-signedin" title="Your identity is verified and bound to this call's encryption">
                <span className="kw-id-check" aria-hidden="true">
                  ✓
                </span>
                Signed in as <strong>{call.selfIdentity.email}</strong>
              </div>
            ) : (
              <div className="kw-id-signin">
                <div ref={mountSignin} className="kw-id-gbtn" />
                {emailAccepted &&
                  (emailOpen ? (
                    <div ref={mountEmailSignin} className="kw-email-host" />
                  ) : (
                    <button type="button" className="kw-id-emailbtn" onClick={() => setEmailOpen(true)}>
                      ✉️ Verify by email
                    </button>
                  ))}
                <p className="kw-id-hint">
                  {requireVerified
                    ? 'This room is for verified people — sign in to join.'
                    : 'Optional — prove who you are so others see a verified ✓.'}
                </p>
              </div>
            ))}
          {joinGate?.declare?.length ? (
            <div className="kw-declare">
              <p className="kw-declare-h">Who are you?</p>
              <div className="kw-declare-opts">
                {joinGate.declare.map((entry) => {
                  const isGuest = entry.trim().toLowerCase() === 'guest'
                  const on = isGuest ? myClaim?.kind === 'guest' : myClaim?.kind === 'email' && myClaim.email === entry
                  return (
                    <button
                      key={entry}
                      type="button"
                      className={`kw-declare-opt${on ? ' on' : ''}`}
                      aria-pressed={on}
                      onClick={() => setMyClaim(isGuest ? { kind: 'guest' } : { kind: 'email', email: entry })}
                    >
                      {isGuest ? 'Guest' : entry}
                    </button>
                  )
                })}
              </div>
              <p className="kw-declare-hint">Unverified — others see this as a claim. Sign in above for a verified ✓.</p>
            </div>
          ) : null}
          <input
            ref={nameRef}
            value={name}
            maxLength={14}
            placeholder="Your name"
            className={nameErr ? 'kw-name-missing' : undefined}
            aria-invalid={nameErr || undefined}
            onChange={(e) => {
              setName(e.target.value)
              if (nameErr) setNameErr(false)
            }}
            onKeyDown={(e) => e.key === 'Enter' && !joining && !mustVerifyToJoin && !(joinGate?.declare?.length && !myClaim) && joinCall()}
          />
          {nameErr && <p className="kw-name-err">Please add your name so people know who joined.</p>}
          <button
            className="kw-join"
            disabled={joining || !room || room.status() === 'closed' || mustVerifyToJoin || !!call.retired || (!!joinGate?.declare?.length && !myClaim)}
            onClick={joinCall}
          >
            {joining ? (
              <>
                <span className="kw-join-spin" aria-hidden="true" />
                {joinSlow ? 'Still connecting…' : 'Joining…'}
              </>
            ) : (
              <>
                {call.retired ? 'Out of date' : mustVerifyToJoin ? 'Sign in to join' : wantRejoin && !rejoinDismissed ? '↻ Rejoin' : 'Join'}
                {!mustVerifyToJoin && call.rosterCount > 0 ? ` (${call.rosterCount} in)` : ''}
              </>
            )}
          </button>
          {!preview && (
            // Invite others BEFORE joining — opens the same QR + copy panel as the in-call invite, so you can hand
            // the room link (the clean, re-shareable one — not the address-bar URL with your one-time summon key).
            <button className="kw-invite kw-invite-cta" onClick={toggleInvite} title="Show a QR + copy the room link to invite others">
              <PeopleIcon /> Invite others
            </button>
          )}
          {wantRejoin && !rejoinDismissed && (
            <button
              className="kw-startfresh"
              onClick={() => {
                clearInCall()
                setRejoinDismissed(true)
              }}
            >
              Start fresh instead
            </button>
          )}
          {(agentCall || notice) && <p className="kw-hint">By joining, you agree to the above.</p>}
          {call.error && <p className="kw-error">{call.error}</p>}
          </div>
        </div>
      )}

      {/* Window-style resize handles on the embedded panel's FREE edges — the top edge, the left edge,
          and the top-left corner (the bottom-right is docked to the screen). Drag any of them to stretch
          the box like a regular window. Hidden in chat / the pop-out window (which size themselves), in
          full screen, in the room window (resized natively), and — via CSS — on touch (the full-screen
          toggle replaces drag-resize there). */}
      {call.inCall && !pip && !chatOpen && !verifyOpen && !fullscreen && !fillMode && (
        <>
          <div className="kw-rsz kw-rsz-l" onPointerDown={startResize(true, false, false, false)} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onPointerCancel={onResizeUp} title="Drag to resize" aria-label="Resize width (left)" />
          <div className="kw-rsz kw-rsz-r" onPointerDown={startResize(false, true, false, false)} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onPointerCancel={onResizeUp} title="Drag to resize" aria-label="Resize width (right)" />
          <div className="kw-rsz kw-rsz-t" onPointerDown={startResize(false, false, true, false)} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onPointerCancel={onResizeUp} title="Drag to resize" aria-label="Resize height (top)" />
          <div className="kw-rsz kw-rsz-b" onPointerDown={startResize(false, false, false, true)} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onPointerCancel={onResizeUp} title="Drag to resize" aria-label="Resize height (bottom)" />
          {/* A diagonal handle at every corner. The bottom-bar buttons are inset and the header's right
              buttons are nudged clear (CSS), so the corner handles never block a control. */}
          <div className="kw-rsz kw-rsz-tl" onPointerDown={startResize(true, false, true, false)} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onPointerCancel={onResizeUp} title="Drag to resize" aria-label="Resize (top-left)" />
          <div className="kw-rsz kw-rsz-tr" onPointerDown={startResize(false, true, true, false)} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onPointerCancel={onResizeUp} title="Drag to resize" aria-label="Resize (top-right)" />
          <div className="kw-rsz kw-rsz-bl" onPointerDown={startResize(true, false, false, true)} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onPointerCancel={onResizeUp} title="Drag to resize" aria-label="Resize (bottom-left)" />
          <div className="kw-rsz kw-rsz-br" onPointerDown={startResize(false, true, false, true)} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onPointerCancel={onResizeUp} title="Drag to resize" aria-label="Resize (bottom-right)" />
        </>
      )}

      {/* No internal edge handles for the room window: it always fills its OS/browser window
          (CSS .kw-fillwin.kw-winmax) and is resized natively by dragging the window's own edge —
          smoother, and it never fights the native resize border. */}

      {/* iOS released the mic/camera while the app was backgrounded and a silent re-grab needs a gesture —
          a TAPPABLE prompt (the tap is the gesture getUserMedia wants) to bring back what's still wanted. */}
      {call.inCall && call.needsMediaGesture && (
        <button className="kw-resume" onClick={() => call.resumeMedia()} aria-label="Resume microphone and camera">
          ↺ Tap to resume {[call.micOn && 'mic', call.camOn && 'camera'].filter(Boolean).join(' & ') || 'mic & camera'}
        </button>
      )}
      {/* Transient heads-up (mic/camera/share hiccup). A neutral, auto-dismissing toast floated over the
          panel — NOT the red error banner — since the mic/camera button on/off already conveys the result.
          Panel-level so it shows whether the failure happened at join (pre-join screen) or in-call. */}
      {call.notice && (
        <div className="kw-toast" role="status" aria-live="polite">
          {call.notice}
        </div>
      )}
      {/* Return splash: a full-cover, language-neutral spinner shown the instant we start redirecting to the
          brand's back-link (leaving a call, or closing the pre-join). It hides the pre-join/landing that would
          otherwise flash behind the navigation until the destination document loads. */}
      {returning && (
        <div className="kw-returning" role="status" aria-live="polite" aria-label="Returning">
          <span className="kw-returning-spin" aria-hidden="true" />
        </div>
      )}
    </div>
  )
}
