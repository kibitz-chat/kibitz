import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pageableViews, VIEW_ORDER, type CallView } from './pageableViews'
import { joinRoom, type RoomStatus } from '../core/room'
import { sanitizeGrant, type Grant } from '../core/capabilities'
import { AgentConsent } from './AgentConsent'
import { AgentActionsBar } from './AgentActionsBar'
import { AgentsMenu } from './AgentsMenu'
import { normalizeRoom } from '../core/transport'
import { loadBans, saveBans } from '../react/bans'
import { joinLanRoom, type LanRoom } from '../core/lanRoom'
import { hasGalaxy } from '../core/galaxyHub'
import { lanMedia, peerJsMedia, previewMedia } from '../core/callMedia'
import { canScreenShare, isIOS } from '../core/media'
import { clearInCall, markInCall, shouldRejoin } from '../core/rejoinIntent'
import { getDiag } from '../core/diag'
import { getIceServers } from '../core/iceConfig'
import { chooseSignal } from '../core/signalConfig'
import type { AuditEntry, CallRoom, ChatItem, SchemaInfo } from '../react/useCall'
import type { AppMessage, PayRequest } from '../core/protocol'
import { normalizePayLink } from '../core/payLink'
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
  addAllowedEmail,
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
import { verifyManifest, type AgentEntry } from '../core/roomManifest'
import { verifyAgentAssertion } from '../core/agentKey'
import { canonicalFingerprint } from '../core/oidcBinding'
import { splitRoomHash, type GateDescriptor } from '../core/joinGateLink'
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

const POS_KEY = 'kibitz.widget.pos2' // left/top coords (v2 — was bottom-right offsets)
const OP_KEY = 'kibitz.widget.op'
const SIZE_KEY = 'kibitz.widget.size' // user-dragged panel width + tile-area height

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
const VIEW_LABEL: Record<CallView, string> = { speaker: 'Speaker', gallery: 'Gallery', car: 'Car', strip: 'Strip' }
const VIEW_ICON: Record<CallView, string> = { speaker: '▭', gallery: '▦', car: '🚗', strip: '▥' }

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
const DRAG_THRESHOLD = 6 // px of movement before a header press becomes a drag (vs a tap)
const MIN_W = 240 // resize clamps — smaller than this and the controls crowd
const MIN_H = 130

// The original card-game app's avatar set, verbatim.
const AVATARS = ['😀', '😎', '🤓', '🥳', '😺', '🦊', '🐼', '🐵', '🦁', '🐸', '🐯', '🐨', '🤖', '👽', '🦄', '🐲', '🔥', '⭐']

const svgProps = {
  viewBox: '0 0 24 24',
  width: 15,
  height: 15,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}
const MicIcon = () => (
  <svg {...svgProps}>
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
)
const MicOffIcon = () => (
  <svg {...svgProps}>
    <line x1="1" y1="1" x2="23" y2="23" />
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
)
const VideoIcon = () => (
  <svg {...svgProps}>
    <polygon points="23 7 16 12 23 17 23 7" />
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
  </svg>
)
const VideoOffIcon = () => (
  <svg {...svgProps}>
    <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
)
// The conventional chain-link glyph = "copy link". (Not ⧉, which is the pop-out
// and reads as "new window/duplicate".)
const LinkIcon = () => (
  <svg {...svgProps}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
)
const QrIcon = () => (
  <svg viewBox="0 0 24 24" width={15} height={15} aria-hidden="true">
    {/* three finder squares (corners) — the unmistakable QR signature, distinct from a 2×2 grid */}
    <g fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="3" width="6" height="6" rx="1" />
      <rect x="3" y="15" width="6" height="6" rx="1" />
    </g>
    {/* filled centres + scattered data modules in the fourth corner */}
    <g fill="currentColor">
      <rect x="5" y="5" width="2" height="2" />
      <rect x="17" y="5" width="2" height="2" />
      <rect x="5" y="17" width="2" height="2" />
      <rect x="14" y="14" width="3" height="3" />
      <rect x="19" y="14" width="2" height="2" />
      <rect x="14" y="19" width="2" height="2" />
      <rect x="19" y="18" width="2" height="3" />
    </g>
  </svg>
)
const CheckIcon = () => (
  <svg {...svgProps}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
)
const ChatIcon = () => (
  <svg {...svgProps}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)
// A shield with a check — "verify this call is private" (the safety-code panel).
const ShieldIcon = () => (
  <svg {...svgProps}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <polyline points="9 12 11 14 14 9" />
  </svg>
)
// Host tools — "who's in the room" (waiting room, lock). A two-person glyph, distinct from the
// verify shield, so the host's admission controls read clearly.
const HostIcon = () => (
  <svg {...svgProps}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19.5c0-3 2.4-5 5.5-5s5.5 2 5.5 5" />
    <path d="M16.6 5.2a3.2 3.2 0 0 1 0 5.6" />
    <path d="M17.6 19.5c0-2.3-1-4-2.6-4.9" />
  </svg>
)
// Corner arrows pointing OUT — enter full screen (the touch alternative to drag-resize).
const MaximizeIcon = () => (
  <svg {...svgProps}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3" />
  </svg>
)
// Corner arrows pointing IN — exit full screen.
const MinimizeIcon = () => (
  <svg {...svgProps}>
    <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3m8 0v-3a2 2 0 0 1 2-2h3" />
  </svg>
)
const SpeakerIcon = () => (
  <svg {...svgProps}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
)
const SpeakerOffIcon = () => (
  <svg {...svgProps}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <line x1="23" y1="9" x2="17" y2="15" />
    <line x1="17" y1="9" x2="23" y2="15" />
  </svg>
)
// Switch/forward camera — a camera body with a rotating circle (a circular arrow) inside the lens.
const FlipCamIcon = () => (
  <svg {...svgProps}>
    <path d="M20 5h-3.2L15 3H9L7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" />
    <g transform="translate(12 13) scale(0.44) translate(-12 -12)">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" vectorEffect="non-scaling-stroke" />
      <polyline points="21 3 21 9 15 9" vectorEffect="non-scaling-stroke" />
    </g>
  </svg>
)
const CloseIcon = () => (
  <svg {...svgProps}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

// Audio-OUTPUT picking (which speaker) needs HTMLMediaElement.setSinkId — desktop Chromium only. Guard
// for SSR/prerender where HTMLMediaElement is undefined. Used to gate the lobby's speaker dropdown.
const CAN_PICK_SPEAKER = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

// A hidden audio sink for an UNSEEN kibitzer (no tile in the grid). Honors speaker-off (`muted`/deaf):
// el.muted is set IMPERATIVELY (React's `muted` prop is unreliable on media elements) and reactively
// when deaf flips — without this the agent's voice kept playing even with the speaker turned off.
function KibitzerSink({ stream, muted, sinkId }: { stream: MediaStream; muted: boolean; sinkId?: string }) {
  const ref = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && el.srcObject !== stream) el.srcObject = stream
  }, [stream])
  useEffect(() => {
    if (ref.current) ref.current.muted = muted
  }, [muted])
  useEffect(() => {
    const el = ref.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null
    if (el && typeof el.setSinkId === 'function') el.setSinkId(sinkId || '').catch(() => {})
  }, [sinkId])
  return <audio ref={ref} autoPlay />
}

interface Pos {
  x: number // viewport left/top of the panel, in px
  y: number
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
  shareScreen(): Promise<boolean>
  shareTrack(track: MediaStreamTrack): Promise<boolean>
  stopShare(): void
  /** Publish a custom outgoing audio track (e.g. a synthesized song); null restores silence. */
  publishAudioTrack(track: MediaStreamTrack | null): void
  setName(name: string): void
  setAvatar(avatar: string): void
  setMeta(meta: Record<string, unknown>): void
  /** Post a line to the room's built-in chat (the same chat humans see). With `to`
   *  (a participant id) it's a private/directed message to just that peer. Lets a
   *  headless agent talk in the room without its own UI. */
  sendChat(text: string, to?: string): void
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

function loadPos(): Pos | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Pos
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) return p
    }
  } catch {
    /* ignore */
  }
  return null // default: the CSS bottom-right anchor
}

/** Panel width + tile-area height once the user has corner-dragged it; null = the
 *  CSS defaults (300px / content-driven). */
interface Size {
  w: number
  h: number
}
function loadSize(): Size | null {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    if (raw) {
      const s = JSON.parse(raw) as Size
      if (Number.isFinite(s.w) && Number.isFinite(s.h) && s.w >= MIN_W && s.h >= MIN_H) return s
    }
  } catch {
    /* ignore */
  }
  return null
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
    verify: (agentCredit: string | undefined) => Promise<{ ok: boolean; reason?: string; creditExp?: number }>
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
        return credit!.verify(agentCredit)
      }
      return { ok: true }
    }
    // No key assertion: a credit-only declared agent (credit-gated room with no manifest).
    if (requireCredit && agentCredit) return credit!.verify(agentCredit)
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
    verify: async (agentCredit: string | undefined): Promise<{ ok: boolean; reason?: string; creditExp?: number }> => {
      if (!agentCredit) return { ok: false, reason: 'agent credit required' }
      let jwks: Jwk[]
      try {
        jwks = await resolveCreditJwks(cfg)
      } catch {
        return { ok: false, reason: 'credit keys unavailable' } // fail-closed
      }
      return verifyCreditCredential(agentCredit, { jwks, issuer: cfg.issuer, now: Math.floor(Date.now() / 1000), kind: cfg.kind })
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
  relayOnly,
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
  /** Privacy (Layer 3): force media/data through TURN so peers never learn your IP (only the
   *  relay does). Fail-closed — no reachable TURN ⇒ the call can't connect rather than leak. */
  relayOnly?: boolean
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
  const [open, setOpen] = useState(headless || (startOpen ?? false) || wantRejoin)
  const [pos, setPos] = useState<Pos | null>(loadPos)
  const [size, setSize] = useState<Size | null>(loadSize)
  // ?debug overlay: read once, and tick a re-render so the live diagnostic updates.
  const debug = useState(() => {
    try {
      return new URLSearchParams(location.search).has('debug')
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
  // Auto-hiding chrome (dedicated room window / full screen only): the header + controls fade
  // away after a few idle seconds and reappear on any pointer move / tap / key — the immersive,
  // video-first behaviour of a pro call client. Set up in an effect once fillMode/fullscreen exist.
  const [chromeHidden, setChromeHidden] = useState(false)
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
  // Claim admin: a room that committed a host key lets a peer prove it (enter the host password) to
  // unlock the moderation controls. The prompt + state; the unseal+sign happens in call.claimHost.
  const [claimOpen, setClaimOpen] = useState(false)
  const [claimPw, setClaimPw] = useState('')
  const [claimErr, setClaimErr] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
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
  // One-time nudge: after you join, point you at screen-share so "look at something together" is one
  // obvious click (the room is a call by default — sharing is opt-in). Cleared once you share or dismiss.
  const [shareNudge, setShareNudge] = useState(true)
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
      setAgentKeys(null)
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
        setAgentKeys(mv.ok ? (mv.manifest.agentKeys ?? null) : null)
      } catch {
        if (alive) {
          setRosterMembers(null)
          setRosterDomains(null)
          setEmailAccepted(false)
          setAgentKeys(null)
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [joinGate, verifyIdentity, roomKey])
  const [draft, setDraft] = useState('')
  // Directed messaging: who the next chat / pay goes to — null = the whole room, else
  // a participant id (private, point-to-point over the mesh).
  const [recipientId, setRecipientId] = useState<string | null>(null)
  const msgsRef = useRef<HTMLDivElement | null>(null)
  // Pay requests (transport-only "pay me" links) — a small composer in chat, and
  // incoming requests shown as always-visible cards. Kibitz never touches funds.
  type PayItem = PayRequest & { id: number; self: boolean }
  const [payRequests, setPayRequests] = useState<readonly PayItem[]>([])
  const [payDismissed, setPayDismissed] = useState<ReadonlySet<number>>(() => new Set())
  const [payOpen, setPayOpen] = useState(false)
  const [payDraft, setPayDraft] = useState('') // the payment link
  const [payNote, setPayNote] = useState('') // optional note (what / how much)
  const [payErr, setPayErr] = useState<string | null>(null)
  const paySeqRef = useRef(0)
  const [name, setName] = useState(() => {
    try {
      return defaultName ?? localStorage.getItem('kibitz.name') ?? ''
    } catch {
      return defaultName ?? ''
    }
  })
  // Offline (LAN) mode: a relay is configured via ?galaxy= — everyone on this
  // WiFi calls directly through it, no internet/broker. Read once.
  const offline = useState(() => hasGalaxy())[0]
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
  )
  const speaking = useActiveSpeakers(call.participants)
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
    () => (focus ? tileParticipants.filter((p) => p.id !== focus.id) : []),
    [focus, tileParticipants],
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
      // One relay = one LAN call (the room name is moot with no broker namespace).
      const r = joinLanRoom()
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
      void Promise.all([
        chooseSignal(),
        getIceServers(),
        vid ? generatePinnedCert() : Promise.resolve(null),
        linkGated ? gateVerifierFor(lgate, roomKey) : Promise.resolve(null),
      ]).then(([peer, iceServers, cert, linkVerify]) => {
        if (cancelled) return
        // Only override ICE when a TURN relay is actually configured. getIceServers
        // returns STUN-only until TURN is set up — and overriding with that would
        // DROP PeerJS's own default fallback TURN. With real TURN present, the data
        // connection can relay, which is what iOS Safari needs on a LAN.
        const hasTurn = iceServers.some((s) => /turn:/i.test([s.urls].flat().join(' ')))
        const config: RTCConfiguration = {}
        if (hasTurn) config.iceServers = iceServers
        if (cert) config.certificates = [cert]
        // Privacy (Layer 3): force the PRESENCE peer through the relay too, so the authority (a
        // peer) never sees the joiner's IP either — relay-only must cover both meshes to mean
        // anything. Fail-closed: no reachable TURN ⇒ no relay candidates ⇒ no connection (no leak).
        if (relayOnlyRef.current) config.iceTransportPolicy = 'relay'
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
              }
            : linkVerify
              ? {
                  require: true,
                  requireAgentCredits: wantCreditGate,
                  verify: withAgentGate(linkVerify, roomKey, () => agentKeysRef.current, (fp, caps) => agentCapsByFpRef.current.set(fp, caps), creditOpt),
                  bindsFingerprint: false,
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
  const leaveCall = useCallback(() => {
    clearInCall()
    call.leave()
  }, [call.leave])

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
    bind('togglemicrophone', () => void call.toggleMic())
    bind('togglecamera', () => void call.toggleCam())
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

  // Incoming "pay me" requests — peer-to-peer over the data mesh now. You never
  // receive your own back (no relay echo), so every card is someone else's. Capped.
  useEffect(() => {
    call.onPay((p) => {
      paySeqRef.current += 1
      setPayRequests((prev) => [...prev, { ...p, id: paySeqRef.current, self: false }].slice(-8))
    })
  }, [call.onPay])

  const sendPayRequest = useCallback(() => {
    const link = normalizePayLink(payDraft)
    if (!link) {
      setPayErr('Enter a valid payment link (https://…, a Stripe/PayPal link, or a bitcoin:/lightning: URI).')
      return
    }
    call.sendPay(payNote.trim(), link.display, recipientId ?? undefined)
    setPayDraft('')
    setPayNote('')
    setPayErr(null)
    setPayOpen(false)
  }, [call.sendPay, payDraft, payNote, recipientId])

  // --- Composable-engine bridge (Kibitz.mount controller) ---------------------
  // Bridge the live call up to the host page. The app channel rides the data mesh
  // (useCall), so attach the call's stable app methods; the controller snapshot/
  // controls are pushed whenever the call state changes.
  useEffect(() => {
    if (!bridge) return
    bridge.attach({
      sendApp: call.sendApp,
      onApp: call.onApp,
      sendAppTo: call.sendAppTo,
      registerSchema: call.registerSchema,
      getSchemas: call.getSchemas,
      onSchema: call.onSchema,
    })
    return () => bridge.detach()
  }, [bridge, call.sendApp, call.onApp, call.sendAppTo, call.registerSchema, call.getSchemas, call.onSchema])

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
      shareScreen: call.shareScreen,
      shareTrack: call.shareTrack,
      stopShare: call.stopShare,
      publishAudioTrack: call.publishAudioTrack,
      setName: (n) => setName(n),
      setAvatar: call.setAvatar,
      setMeta: call.setMeta,
      sendChat: call.sendChat,
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
  }, [bridge, joinWith, leaveCall, call.toggleMic, call.toggleCam, call.shareScreen, call.shareTrack, call.stopShare, call.setAvatar, call.setMeta, call.sendChat, setLobbyCtl, admitCtl, denyCtl, removeCtl, setLockedCtl, resetCtl, knockCtl, call.signInIdentity, call.identityNonce, call.provideIdentityToken, call.provideAgentKey, call.provideAgentCredit, call.getCapabilityGrant, call.setCapabilityGrant, call.getAgentAudit])

  // Apply the initial `meta` mount option once.
  const initialMeta = useRef(meta)
  useEffect(() => {
    if (initialMeta.current) call.setMeta(initialMeta.current)
  }, [call.setMeta])

  // Headless: unlock the hidden remote-audio sinks on the first page gesture (iOS
  // refuses autoplay until then). Any click on the host page counts.
  useEffect(() => {
    if (!headless) return
    const go = () => tilesRef.current?.querySelectorAll('audio').forEach((a) => a.play().catch(() => {}))
    document.addEventListener('pointerdown', go, { passive: true })
    return () => document.removeEventListener('pointerdown', go)
  }, [headless])

  // Drag — the original pattern: the WHOLE header drags, buttons included. A
  // press only becomes a drag past a 6px threshold (so taps stay taps); the
  // pointer is captured once dragging, and the click that trails a real drag
  // is swallowed so the button under the finger doesn't fire.
  const panelRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ ox: number; oy: number; gx: number; gy: number; moved: boolean } | null>(null)
  const draggedRef = useRef(false)

  const clampPos = useCallback((x: number, y: number): Pos => {
    const rect = panelRef.current?.getBoundingClientRect()
    const w = rect?.width ?? 300
    const h = rect?.height ?? 160
    return {
      x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w)),
      y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - h)),
    }
  }, [])

  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (fill) return // the room window is anchored — resize it by its edges, don't drag it
    draggedRef.current = false // clear any stale suppression
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    dragRef.current = { ox: e.clientX - rect.left, oy: e.clientY - rect.top, gx: e.clientX, gy: e.clientY, moved: false }
  }
  const onBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    if (!d.moved) {
      if (Math.abs(e.clientX - d.gx) + Math.abs(e.clientY - d.gy) < DRAG_THRESHOLD) return
      d.moved = true
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }
    setPos(clampPos(e.clientX - d.ox, e.clientY - d.oy))
  }
  const onBarUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.moved) {
      draggedRef.current = true // suppress the click that follows a drag
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      setPos((p) => {
        try {
          if (p) localStorage.setItem(POS_KEY, JSON.stringify(p))
        } catch {
          /* ignore */
        }
        return p
      })
    }
    dragRef.current = null
  }
  const onBarClickCapture = (e: React.MouseEvent) => {
    if (draggedRef.current) {
      e.preventDefault()
      e.stopPropagation()
      draggedRef.current = false
    }
  }

  // Window-style resize from ANY edge / corner (pointer events → mouse AND touch, desktop-only via CSS).
  // On grab we snapshot the four edges + the tile/chrome split; whichever edge(s) the chosen handle drives
  // (l/r/t/b) follow the pointer while the OPPOSITE edges stay pinned — exactly like a real window. Width
  // sizes the panel; height sizes the tile area (grid / stage); `chrome` is the constant non-tile part.
  const resizeRef = useRef<{ L: number; T: number; R: number; B: number; chrome: number; l: boolean; r: boolean; t: boolean; b: boolean } | null>(null)
  const startResize = (l: boolean, r: boolean, t: boolean, b: boolean) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    setPos((p) => p ?? { x: rect.left, y: rect.top }) // pin the current top-left so the panel can move
    const tileH = tilesRef.current?.getBoundingClientRect().height ?? 200
    resizeRef.current = { L: rect.left, T: rect.top, R: rect.right, B: rect.bottom, chrome: Math.max(0, rect.height - tileH), l, r, t, b }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const z = resizeRef.current
    if (!z) return
    const M = 8 // keep the box this far inside the viewport on every edge
    const vw = window.innerWidth
    const vh = window.innerHeight
    const maxW = Math.max(MIN_W, vw - 2 * M)
    const maxH = Math.max(MIN_H, vh - 2 * M)
    // Horizontal: the dragged side follows the pointer but is CLAMPED to the viewport (so the box never
    // runs off-screen right/left); the opposite side stays pinned. Then derive width + left.
    const left = z.l ? Math.max(M, Math.min(e.clientX, z.R - MIN_W)) : z.L
    const right = z.r ? Math.min(vw - M, Math.max(e.clientX, z.L + MIN_W)) : z.R
    const w = Math.min(Math.max(MIN_W, right - left), maxW)
    const posX = z.l ? right - w : left // left moved → right edge fixed; else left edge fixed
    // Vertical: same, on the panel height (chrome + tile), clamped top/bottom to the viewport.
    const top = z.t ? Math.max(M, Math.min(e.clientY, z.B - (z.chrome + MIN_H))) : z.T
    const bottom = z.b ? Math.min(vh - M, Math.max(e.clientY, z.T + z.chrome + MIN_H)) : z.B
    const h = Math.min(Math.max(MIN_H, bottom - top - z.chrome), maxH)
    const posY = z.t ? bottom - (z.chrome + h) : top // top moved → bottom edge fixed; else top edge fixed
    setSize({ w, h })
    setPos({ x: Math.max(M, posX), y: Math.max(M, posY) })
  }
  const onResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return
    resizeRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    setSize((s) => {
      try {
        if (s) localStorage.setItem(SIZE_KEY, JSON.stringify(s))
      } catch {
        /* ignore */
      }
      return s
    })
    setPos((p) => {
      try {
        if (p) localStorage.setItem(POS_KEY, JSON.stringify(p))
      } catch {
        /* ignore */
      }
      return p
    })
  }

  // Keep a moved panel on-screen across rotation / resize.
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampPos(p.x, p.y) : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampPos])

  // iOS STANDALONE PWA, the moment you rotate to landscape: it leaves a PHANTOM document scroll behind
  // AND a stale position:fixed hit map, so taps land offset (you tap the control, the hit lands where it
  // was before the rotation) until a real touch re-syncs it (the user's "touch the header fixes it").
  // Compositing the panel + a transform nudge didn't move it. This resets the phantom scroll and forces
  // a genuine RE-LAYOUT of the fixed panel (a 0.01% height blip) after the rotation settles — the closest
  // programmatic equivalent to the manual touch. Touch devices only; debounced past iOS's settle delay.
  useEffect(() => {
    if (!canTouch) return
    // Gate on the orientation FLIP: `resize` also fires for the on-screen keyboard and
    // chrome collapse, and blipping the panel height on those causes a visible jump while
    // typing in chat. Only a real rotation needs the re-layout (checked after the settle).
    let wasLandscape = window.innerWidth > window.innerHeight
    const fix = () => {
      const landscape = window.innerWidth > window.innerHeight
      if (landscape === wasLandscape) return // not a rotation — don't blip the live panel
      wasLandscape = landscape
      try {
        window.scrollTo(0, 0)
      } catch {
        /* ignore */
      }
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0
      const el = panelRef.current
      if (!el) return
      const prev = el.style.height
      el.style.height = '100.01%' // a real (imperceptible) size change → forces the fixed panel to re-lay-out + re-hit-test
      void el.offsetHeight
      el.style.height = prev
    }
    let t = 0
    const onRotate = () => {
      clearTimeout(t)
      t = window.setTimeout(fix, 350) // iOS settles the new orientation a beat after the event fires
    }
    window.addEventListener('orientationchange', onRotate)
    window.addEventListener('resize', onRotate)
    return () => {
      clearTimeout(t)
      window.removeEventListener('orientationchange', onRotate)
      window.removeEventListener('resize', onRotate)
    }
  }, [canTouch])

  // The panel widens for the stage (and narrows again when chat covers it); re-clamp
  // a dragged panel so it can't overflow the right edge as the width changes.
  useEffect(() => {
    setPos((p) => (p ? clampPos(p.x, p.y) : p))
  }, [presenter, chatOpen, clampPos])

  // ── Pre-join camera/mic preview (Zoom-style) ───────────────────────────────────────────
  // A purely LOCAL getUserMedia preview shown in the lobby so you can set mic/camera BEFORE entering.
  // Kept entirely separate from the call's own media (which has its own hard-won iOS lifecycle): we
  // fully stop the preview tracks before call.join(), then re-apply the chosen mic/cam via the call's
  // own toggles. preMic/preCam are the chosen intents; previewStream is the live local stream.
  const [preMic, setPreMic] = useState(false)
  const [preCam, setPreCam] = useState(false)
  const [preFacing, setPreFacing] = useState<'user' | 'environment'>('user')
  // Speaker (audio-output) toggle — shown like Zoom's. Web has no earpiece/loudspeaker route API, so
  // this is a display preference only (it doesn't change routing); kept for parity with the reference.
  const [preSpeaker, setPreSpeaker] = useState(true)
  // Chosen INPUT/OUTPUT device ids ('' = system default) — desktop especially has several. mic/cam are
  // applied to the preview now and carried into the call on join; speaker (output) is carried on join
  // (no remote audio to route in the lobby). Device lists come from enumerateDevices (labels appear
  // only after media permission — see applyPreview re-enumerating, and the devicechange listener).
  const [preMicId, setPreMicId] = useState('')
  const [preCamId, setPreCamId] = useState('')
  const [preSpeakerId, setPreSpeakerId] = useState('')
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [cams, setCams] = useState<MediaDeviceInfo[]>([])
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([])
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null)
  const previewStreamRef = useRef<MediaStream | null>(null)
  previewStreamRef.current = previewStream
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const previewBusyRef = useRef(false)
  const previewVidEl = useRef<HTMLVideoElement | null>(null)

  const refreshDevices = useCallback(async () => {
    try {
      const ds = await navigator.mediaDevices.enumerateDevices()
      setMics(ds.filter((d) => d.kind === 'audioinput'))
      setCams(ds.filter((d) => d.kind === 'videoinput'))
      setSpeakers(ds.filter((d) => d.kind === 'audiooutput'))
    } catch {
      /* enumerate unavailable (no permission / unsupported) — leave the lists as-is */
    }
  }, [])

  const stopPreview = useCallback(() => {
    previewStreamRef.current?.getTracks().forEach((t) => t.stop())
    previewStreamRef.current = null
    setPreviewStream(null)
  }, [])

  // Rebuild the local preview for the desired mic/cam (facing OR a specific deviceId) — one getUserMedia,
  // stopping the old stream first so we never hold two camera handles. On denial, roll the intent back.
  const applyPreview = useCallback(
    async (wantMic: boolean, wantCam: boolean, facing: 'user' | 'environment', micId: string, camId: string) => {
      if (previewBusyRef.current) return
      previewBusyRef.current = true
      try {
        previewStreamRef.current?.getTracks().forEach((t) => t.stop())
        previewStreamRef.current = null
        setPreviewStream(null)
        if (!wantMic && !wantCam) {
          setPreviewErr(null)
          return
        }
        const audio = wantMic ? (micId ? { deviceId: { exact: micId } } : true) : false
        const video = wantCam ? (camId ? { deviceId: { exact: camId } } : { facingMode: facing }) : false
        const s = await navigator.mediaDevices.getUserMedia({ audio, video })
        previewStreamRef.current = s
        setPreviewStream(s)
        setPreviewErr(null)
        void refreshDevices() // permission granted → device LABELS are now readable
      } catch {
        setPreviewErr(wantCam ? 'Camera/mic blocked — allow access, or just join.' : 'Mic blocked — allow access, or just join.')
        setPreMic(false)
        setPreCam(false)
      } finally {
        previewBusyRef.current = false
      }
    },
    [refreshDevices],
  )

  const togglePreMic = useCallback(() => {
    const next = !preMic
    setPreMic(next)
    void applyPreview(next, preCam, preFacing, preMicId, preCamId)
  }, [preMic, preCam, preFacing, preMicId, preCamId, applyPreview])
  const togglePreCam = useCallback(() => {
    const next = !preCam
    setPreCam(next)
    void applyPreview(preMic, next, preFacing, preMicId, preCamId)
  }, [preMic, preCam, preFacing, preMicId, preCamId, applyPreview])
  const flipPre = useCallback(() => {
    const f = preFacing === 'user' ? 'environment' : 'user'
    setPreFacing(f)
    setPreCamId('') // a manual flip clears any specific-camera pick (facing decides front/rear)
    if (preCam) void applyPreview(preMic, true, f, preMicId, '')
  }, [preFacing, preMic, preCam, preMicId, applyPreview])
  // Device-picker changes (desktop): switch the preview's mic/cam immediately; speaker rides into the call.
  const selectMic = useCallback(
    (id: string) => {
      setPreMicId(id)
      if (preMic) void applyPreview(true, preCam, preFacing, id, preCamId)
    },
    [preMic, preCam, preFacing, preCamId, applyPreview],
  )
  const selectCam = useCallback(
    (id: string) => {
      setPreCamId(id)
      if (preCam) void applyPreview(preMic, true, preFacing, preMicId, id)
    },
    [preMic, preCam, preFacing, preMicId, applyPreview],
  )

  // Attach the preview stream to the <video> whenever it changes; tear it all down on join / unmount.
  useEffect(() => {
    const el = previewVidEl.current
    if (el) {
      el.srcObject = previewStream
      if (previewStream) void el.play?.().catch(() => {})
    }
  }, [previewStream])
  useEffect(() => {
    if (call.inCall) stopPreview()
  }, [call.inCall, stopPreview])
  useEffect(() => () => stopPreview(), [stopPreview])
  // Populate the device pickers in the lobby — once at mount (labels are generic until permission) and
  // again whenever devices are plugged/unplugged. (applyPreview also re-enumerates after permission.)
  useEffect(() => {
    if (call.inCall || preview || headless) return
    void refreshDevices()
    const md = navigator.mediaDevices
    md?.addEventListener?.('devicechange', refreshDevices)
    return () => md?.removeEventListener?.('devicechange', refreshDevices)
  }, [call.inCall, preview, headless, refreshDevices])

  const joinCall = () => {
    try {
      localStorage.setItem('kibitz.name', name.trim())
    } catch {
      /* ignore */
    }
    const wantMic = preMic
    const wantCam = preCam
    stopPreview() // free the preview's devices before the call grabs its own
    void (async () => {
      const ok = await call.join() // joins muted, camera off
      if (!ok) return
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

  const sendDraft = () => {
    const text = draft.trim()
    if (!text) return
    call.sendChat(text, recipientId ?? undefined)
    setDraft('')
  }

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
  const showViewDots = bigSurface && canTouch && !presenter && availableViews.length > 1
  // Auto-hide the chrome in the big surfaces (room window / full screen) AND in the see-through ghost
  // panel, while in a call. In the big surfaces the whole header + bottom bar + host controls fade to
  // give full-bleed video (or full-height chat — the chat/verify panel is flex:1 and its own input
  // stays put, so it grows into the freed rows); in ghost only the call buttons fade, leaving the slim
  // title strip as the tap target. The avatar picker pins the chrome (so the picker doesn't fade
  // mid-choice), as does a pending knock (so the host never misses Admit/Deny).
  const autoHideChrome =
    (bigSurface || ghosting || embedBar) &&
    call.inCall &&
    // A SEE-THROUGH fullscreen keeps its chrome put: the panel is click-through, and fullscreen's
    // hide fully collapses the top bar — so auto-hiding would leave nothing to tap to bring it back.
    // (The video is already translucent, so a persistent slim bar costs nothing.)
    !(fullscreen && ghosting) &&
    !pickerOpen &&
    !hostMenuOpen &&
    !preview &&
    hostLobby.knocks.length === 0 &&
    // DESKTOP + a shared screen keeps the controls up (a mouse user expects them; touch surfaces don't).
    !(presenter && !canTouch) &&
    // While a pen/laser tool is ACTIVE, pin the chrome so the ink toolbar stays put while you annotate.
    // Otherwise a presentation auto-hides for full-bleed like any call — "fixed only when we laser/pen".
    // (The landscape tap-offset that made this look unsafe was the iOS rotation bug, now fixed separately.)
    !inkActive
  useEffect(() => {
    if (!autoHideChrome || !host) {
      setChromeHidden(false)
      return
    }
    let t = 0
    const show = (e?: Event) => {
      // A stage swipe (layout change) must NOT pop the bars up — onStageSwipeUp reveals on a tap instead.
      if (swipeActiveRef.current) return
      // A tap on an AGENT MENU (the stage pill, its chips, etc.) is an interaction with the agent — not a
      // request to reveal the call chrome. Don't pop the top/bottom bars for it. (composedPath pierces the
      // shadow root; an explicit tap-to-reveal calls show() with no event, so it still works.)
      if (
        e?.composedPath?.().some((n) => {
          const cl = (n as HTMLElement)?.classList
          return !!cl && (cl.contains('kw-agentbar') || cl.contains('kw-agentbar-ctrlwrap') || cl.contains('kw-agentsmenu-wrap'))
        })
      )
        return
      setChromeHidden(false)
      clearTimeout(t)
      t = window.setTimeout(() => setChromeHidden(true), 3000)
    }
    revealChromeRef.current = show // so a TAP (vs swipe) on the stage can trigger the reveal explicitly
    // Pointer/key activity ANYWHERE in the panel reveals the chrome and re-arms the idle timer;
    // listen on the shadow host so events from inside the shadow root bubble up to us. In ghost mode
    // the tiles are click-through (pointer-events:none) so only a tap on the title strip reaches us —
    // which is exactly the intent: touch the top bar to bring the buttons back.
    host.addEventListener('pointermove', show)
    host.addEventListener('pointerdown', show)
    host.addEventListener('keydown', show)
    show() // visible now, and ARM the idle-hide immediately so the chrome fades a few seconds after
    // join even with no interaction (Zoom-style) — not only after the first pointer move.
    return () => {
      clearTimeout(t)
      revealChromeRef.current = null
      host.removeEventListener('pointermove', show)
      host.removeEventListener('pointerdown', show)
      host.removeEventListener('keydown', show)
    }
  }, [autoHideChrome, host])

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

  // "Verified only" rooms block Join until you've signed in (honest-user gate; the host
  // enforces the rest). Sign-in is required, not optional, in the lobby then.
  const mustVerifyToJoin = requireVerified && call.identityEnabled && !call.selfIdentity
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
      <button
        className={`kw-ic${call.micOn ? '' : ' off'}`}
        onClick={() => void call.toggleMic()}
        aria-label={call.micOn ? 'Mute microphone' : 'Unmute microphone'}
        title={call.micOn ? 'Mute (M)' : 'Unmute (M · hold Space to talk)'}
      >
        {call.micOn ? <MicIcon /> : <MicOffIcon />}
      </button>
      <button
        className={`kw-ic${call.camOn ? '' : ' off'}`}
        onClick={() => void call.toggleCam()}
        aria-label={call.camOn ? 'Turn camera off' : 'Turn camera on'}
        title={call.camOn ? 'Turn camera off (V)' : 'Turn camera on (V)'}
      >
        {call.camOn ? <VideoIcon /> : <VideoOffIcon />}
      </button>
      {call.camOn && (canTouch || call.canFlip) && (
        <button
          className="kw-ic"
          onClick={() => void call.flipCam()}
          aria-label="Flip camera (front/back)"
          title="Switch front/back camera"
        >
          <FlipCamIcon />
        </button>
      )}
      <button
        className={`kw-ic${deaf ? ' off' : ''}`}
        onClick={() => setDeaf((d) => !d)}
        aria-label={deaf ? 'Turn speaker on — hear others' : 'Turn speaker off — mute everyone for you'}
        title={deaf ? 'Speaker off — tap to hear others' : 'Mute everyone (speaker off)'}
      >
        {deaf ? <SpeakerOffIcon /> : <SpeakerIcon />}
      </button>
      {/* Screen-share lives in the dedicated room window only, not the embedded widget: sharing your
          desktop FROM a little box floating on someone else's page is an odd fit, so the widget stays a
          lightweight call. (canScreenShare is desktop-only anyway, which is where the widget showed it.) */}
      {!preview && fill && canScreenShare() && (
        <button
          className={`kw-ic${call.sharing ? ' active' : ''}`}
          onClick={() => (call.sharing ? call.stopShare() : void startShare())}
          aria-label={call.sharing ? 'Stop sharing your screen' : 'Share your screen or a tab'}
          title={call.sharing ? 'Stop presenting' : 'Present your screen or a tab to everyone'}
        >
          {call.sharing ? '🛑' : '🖥️'}
        </button>
      )}
      <button
        className={`kw-ic${call.avatar ? ' active' : ''}`}
        onClick={() => setPickerOpen((o) => !o)}
        aria-label="Choose an animated avatar"
        title="Choose an animated avatar"
      >
        <EmojiAvatar value={call.avatar || '🙂'} />
      </button>
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
      {/* The master "Agents" menu: every agent present, with a per-viewer checkbox to show/hide its
          on-call menu locally. Plus agents that chose the 'controls' placement, popped from here. */}
      <AgentsMenu call={call} hidden={hiddenAgents} onToggle={toggleAgentHidden} />
      <AgentActionsBar call={call} placement="controls" hidden={hiddenAgents} />
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
      {/* The view switcher only makes sense with ≥2 pageable views (e.g. a solo desktop call is just
          Speaker, so there's nothing to switch to). Shown as an explicit tappable icon EVERYWHERE — the
          corner panel and the big surfaces — so the layout (incl. Gallery / "tiles in a row") is always
          discoverable; the big surfaces also keep the page-dots for the swipe-position cue. */}
      {availableViews.length > 1 && (
        <button
          className={`kw-ic${view !== 'speaker' ? ' active' : ''}`}
          onClick={() => cycleView(1, true)}
          aria-label={`${VIEW_LABEL[view]} view — tap to switch`}
          title={`${VIEW_LABEL[view]} view (tap to cycle ${availableViews.map((v) => VIEW_LABEL[v]).join(' · ')}${
            isIOS() ? '; or swipe the video' : ''
          })`}
        >
          {VIEW_ICON[view]}
        </button>
      )}
      {/* See-through "ghost" mode needs a host page underneath: the embedded panel — corner OR
          maximized to fullscreen. The standalone surfaces (the dedicated room window + the pop-out
          PiP window) have nothing behind them, so hide the toggle there. */}
      {!fillMode && !pip && (
        <button
          className={`kw-ic${ghost ? ' active' : ''}`}
          onClick={() => setGhost((g) => !g)}
          aria-pressed={ghost}
          title={ghost ? 'Make the panel solid' : 'See-through (use the page underneath)'}
        >
          {ghost ? '◐' : '◑'}
        </button>
      )}
      {host && pipApi && (
        <button
          className={`kw-ic${pip ? ' active' : ''}`}
          onClick={() => void popOut()}
          title={pip ? 'Bring the room back to this page' : 'Pop out — float over every tab and app'}
        >
          ⧉
        </button>
      )}
      {/* Video Picture-in-Picture (Android Chrome): float the active speaker over the home
          screen. Shown only where Document PiP (above) isn't available. NOT on iOS: Safari
          exposes the PiP API but refuses to put a live-call (canvas/MediaStream) video into
          PiP — that floating-window privilege is reserved for native apps + file/HLS video —
          so the button would be dead there. */}
      {videoPip.supported && !pipApi && !isIOS() && (
        <button
          className={`kw-ic${videoPip.active ? ' active' : ''}`}
          onClick={videoPip.toggle}
          aria-label={videoPip.active ? 'Stop the floating video' : 'Float the call over the home screen'}
          title={videoPip.active ? 'Stop the floating video' : 'Pop out video — float over the home screen'}
        >
          ⧉
        </button>
      )}
    </>
  )

  // Secondary controls — verify (shield) + copy-invite (link). In the big surfaces these ride the TOP
  // header (the bottom bar is crowded; the title strip is sparse), so the two bars stay balanced. In
  // the embedded panel they sit at the end of the header row with the rest.
  const secondaryControls = !preview && (
    <>
      <button
        className={`kw-ic${verifyOpen ? ' active' : ''}${safetyAlarm ? ' warn' : ''}`}
        onClick={() => {
          setVerifyOpen((o) => !o)
          setChatOpen(false)
        }}
        aria-label="Verify this call is private"
        title={
          safetyAlarm
            ? "A peer's security key changed — check the safety code"
            : 'Verify your call is private (safety code)'
        }
      >
        <ShieldIcon />
        {safetyAlarm && <span className="kw-badge kw-badge-knock kw-badge-sm">!</span>}
      </button>
      <button
        className={`kw-ic${copied ? ' active' : ''}`}
        onClick={() => void copyInvite()}
        aria-label="Copy invite link"
        title={copied ? 'Invite link copied!' : 'Copy the invite link — one tap'}
      >
        {copied ? <CheckIcon /> : <LinkIcon />}
      </button>
      {/* The QR-to-join is only worth showing where there's room to render a scannable code — the big
          surfaces (the widget maximized to fullscreen, or the dedicated room window). The cramped corner
          panel keeps just the copy-link button above; a QR there would be too small to scan anyway. */}
      {bigSurface && (
        <button
          className={`kw-ic${inviteOpen ? ' active' : ''}`}
          onClick={toggleInvite}
          aria-label="Show a QR code to scan and join"
          aria-expanded={inviteOpen}
          title="Show a QR to scan — bring someone in"
        >
          <QrIcon />
        </button>
      )}
      {/* Host tools — only the room authority. One icon opens the waiting-room + lock (+ verified
          gate) menu, so those controls aren't a permanent row in the bar. A badge flags anyone
          waiting to be let in. */}
      {hostLobby.canGate && (
        <button
          className={`kw-ic${hostMenuOpen ? ' active' : ''}`}
          onClick={() => setHostMenuOpen((o) => !o)}
          aria-label="Host tools"
          aria-expanded={hostMenuOpen}
          title="Host tools — waiting room, lock the room"
        >
          <HostIcon />
          {hostLobby.knocks.length > 0 && (
            <span className="kw-badge kw-badge-knock kw-badge-sm">{hostLobby.knocks.length}</span>
          )}
        </button>
      )}
      {/* Claim admin — the room committed a host and we haven't claimed it. PASSWORD tier opens a prompt;
          SOFT (name) tier claims in one tap (adopt the host name + re-announce). */}
      {roomHasHost && !call.isVerifiedHost && hostKeyTier && (
        <button
          className={`kw-ic${claimOpen ? ' active' : ''}`}
          onClick={() => setClaimOpen((o) => !o)}
          aria-label="Claim admin"
          aria-expanded={claimOpen}
          title="Claim admin — enter the host password"
        >
          🔑
        </button>
      )}
      {roomHasHost && !call.isVerifiedHost && !hostKeyTier && softHostName && (
        <button
          className="kw-ic"
          onClick={() => doClaimByName()}
          aria-label="I'm the host"
          title={`Claim host — join as “${softHostName}”`}
        >
          🪪
        </button>
      )}
      {/* OIDC tier: signing in IS claiming — the button opens the Verify panel where you sign in. Once
          your verified email matches, the authority marks you host (the effect above) and this hides. */}
      {roomHasHost && !call.isVerifiedHost && oidcHostEmail && (
        <button
          className="kw-ic"
          onClick={() => setVerifyOpen(true)}
          aria-label="Sign in to claim host"
          title={`Claim host — sign in as ${oidcHostEmail}`}
        >
          🔐
        </button>
      )}
    </>
  )

  return (
    <div
      ref={panelRef}
      className={`kw-panel${ghosting ? ' kw-ghostmode' : ''}${pip ? ' kw-pip' : ''}${fullscreen ? ' kw-full' : ''}${fillMode || pip ? ' kw-fillwin' : ''}${fillMode || pip ? ' kw-winmax' : ''}${preview && !call.inCall ? ' kw-preview' : ''}${carMode && !chatOpen && !verifyOpen ? ' kw-car' : ''}${view === 'strip' && !presenter && !chatOpen && !verifyOpen ? ' kw-strip' : ''}${presenter && !carMode && !chatOpen ? ' kw-staging' : ''}${focus && !carMode && !presenter && !chatOpen ? ' kw-speaker' : ''}${chromeHidden ? ' kw-chromehidden' : ''}${fillMode && !call.inCall && !preview ? ' kw-prejoinwin' : ''}${chatSplit ? ' kw-chatsplit' : ''}`}
      style={panelStyle}
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      onKeyUp={onPanelKeyUp}
    >
      {debugEl}
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
        <span className="kw-title">{call.inCall ? `🎙️ ${call.rosterCount}` : `Kibitz · ${roomName}`}</span>
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
            {leaveArmed ? 'Leave?' : '✕'}
          </button>
        )}
      </div>
      )}
      {fillMode && !call.inCall && !preview && onExit && (
        <button
          className="kw-prejoin-x"
          onClick={() => {
            stopPreview()
            onExit()
          }}
          aria-label="Close"
          title="Close"
        >
          <CloseIcon />
        </button>
      )}

      {call.inCall && !preview && fill && canScreenShare() && shareNudge && !call.sharing && !chromeHidden && (
        <div
          className="kw-share-nudge"
          style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 8px', padding: '7px 10px', borderRadius: 8, background: 'rgba(90,150,255,0.16)', fontSize: '0.85em', lineHeight: 1.3 }}
        >
          <span style={{ flex: 1 }}>📺 Look at something together — share your screen.</span>
          <button
            type="button"
            onClick={() => void startShare()}
            style={{ border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', font: 'inherit', fontWeight: 600, background: 'rgba(90,150,255,0.9)', color: '#fff' }}
          >
            Share screen
          </button>
          <button
            type="button"
            onClick={() => setShareNudge(false)}
            aria-label="Dismiss"
            title="Not now"
            style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', opacity: 0.6, padding: '0 2px' }}
          >
            ✕
          </button>
        </div>
      )}

      {call.inCall && pickerOpen && (
        <div className="kw-avatars">
          <button
            className={`kw-av${call.avatar ? '' : ' sel'}`}
            onClick={() => {
              call.setAvatar('')
              setPickerOpen(false)
            }}
            title="Use your initials"
          >
            🔤
          </button>
          {AVATARS.map((a) => (
            <button
              key={a}
              className={`kw-av${call.avatar === a ? ' sel' : ''}`}
              onClick={() => {
                call.setAvatar(a)
                setPickerOpen(false)
              }}
            >
              <EmojiAvatar value={a} />
            </button>
          ))}
        </div>
      )}

      {call.inCall && inviteOpen && (
        <div className="kw-invitepanel">
          <div className="kw-invite-head">
            <span>📱 Scan to join</span>
            <button className="kw-invite-x" onClick={() => setInviteOpen(false)} aria-label="Close" title="Close">
              ✕
            </button>
          </div>
          {inviteUrl ? (
            <>
              <QrBox text={inviteUrl} className="kw-invite-qr" />
              <p className="kw-invite-hint">Point a phone camera at this to join — watch + talk, no install.</p>
              <button
                className={`kw-invite-copy${copied ? ' done' : ''}`}
                onClick={() => void copyInvite()}
                title="Copy the invite link instead"
              >
                {copied ? '✓ Link copied' : '🔗 Copy link instead'}
              </button>
            </>
          ) : (
            <p className="kw-invite-hint">Preparing your invite…</p>
          )}
        </div>
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
        <div className="kw-hostmenu kw-claimadmin" role="dialog" aria-label="Claim admin">
          <div className="kw-hostmenu-head">
            <span>Claim admin</span>
            <button className="kw-hostmenu-x" onClick={() => setClaimOpen(false)} aria-label="Close" title="Close">
              ✕
            </button>
          </div>
          <p className="kw-claim-hint">Enter the host password to unlock moderation (kick · lock · waiting room).</p>
          <input
            className="kw-claim-pw"
            type="password"
            value={claimPw}
            autoComplete="off"
            placeholder="Host password"
            onChange={(e) => {
              setClaimPw(e.target.value)
              setClaimErr(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doClaim()
            }}
          />
          {claimErr && <p className="kw-claim-err">That password didn’t work.</p>}
          <button className="kw-claim-go" onClick={() => void doClaim()} disabled={!claimPw}>
            Claim admin
          </button>
        </div>
      )}

      {hostLobby.canGate && hostMenuOpen && (
        <div className="kw-hostmenu" role="dialog" aria-label="Host tools">
          <div className="kw-hostmenu-head">
            <span>Host tools</span>
            <button
              className="kw-hostmenu-x"
              onClick={() => setHostMenuOpen(false)}
              aria-label="Close host tools"
            >
              ✕
            </button>
          </div>
          {call.identityEnabled && (
            <>
              <button
                className={`kw-lobtoggle${requireVerified ? ' on' : ''}`}
                onClick={() => setRequireVerified((v) => !v)}
                aria-pressed={requireVerified}
                title={
                  requireVerified
                    ? 'Verified only — people must sign in; anyone unverified is removed. Tap to allow guests.'
                    : 'Anyone can join (guests welcome). Tap to require a verified identity.'
                }
              >
                {requireVerified ? '🪪 Verified people only' : '🪪 Guests allowed'}
              </button>
              {requireVerified && (
                <div className="kw-guestlist">
                  <p className="kw-guesthint">
                    {guestEmails.length
                      ? 'Only these verified people can join:'
                      : 'Any verified person can join. Add emails to limit it to specific people.'}
                  </p>
                  {guestEmails.length > 0 && (
                    <ul className="kw-guests">
                      {guestEmails.map((e) => (
                        <li key={e} className="kw-guestrow">
                          <span className="kw-guestmail" title={e}>
                            {e}
                          </span>
                          <button
                            className="kw-guestx"
                            onClick={() => setGuestEmails((l) => l.filter((x) => x !== e))}
                            aria-label={`Remove ${e} from the guest list`}
                            title={`Remove ${e}`}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <form
                    className="kw-guestadd"
                    onSubmit={(ev) => {
                      ev.preventDefault()
                      setGuestEmails((l) => addAllowedEmail(l, guestInput))
                      setGuestInput('')
                    }}
                  >
                    <input
                      className="kw-guestinput"
                      type="email"
                      value={guestInput}
                      onChange={(ev) => setGuestInput(ev.target.value)}
                      placeholder="add an email…"
                      aria-label="Add an email to the guest list"
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                    <button className="kw-guestaddbtn" type="submit">
                      Add
                    </button>
                  </form>
                </div>
              )}
            </>
          )}
          <div className="kw-host-row">
            <button
              className={`kw-lobtoggle${hostLobby.lobbyOn ? ' on' : ''}`}
              onClick={() => hostLobby.setLobby(!hostLobby.lobbyOn)}
              aria-pressed={hostLobby.lobbyOn}
              title={
                hostLobby.lobbyOn
                  ? 'Lobby on — you approve who joins. Tap to let the link admit anyone.'
                  : 'Anyone with the link joins. Tap to require your approval.'
              }
            >
              {hostLobby.lobbyOn ? '🔒 Approving joiners' : '🔓 Anyone with the link'}
            </button>
            <button
              className={`kw-lockbtn${hostLobby.locked ? ' on' : ''}`}
              onClick={() => hostLobby.setLocked(!hostLobby.locked)}
              aria-pressed={hostLobby.locked}
              title={
                hostLobby.locked
                  ? 'Room locked — no one new can join (people here can still reconnect). Tap to unlock.'
                  : 'Seal the room: no new people can join, even with the link.'
              }
            >
              {hostLobby.locked ? '🔐 Locked' : '🔐 Lock room'}
            </button>
            {/* No human "Reset/clear chat" button — chat is ephemeral (it vanishes when everyone
                leaves), so a wipe-the-scrollback control earned more confusion than value. The
                `resetRoom()` controller method stays for embedders who want to surface it. */}
          </div>
          {bannedEmails.size > 0 && (
            <div className="kw-banrow">
              <span title="People you removed are blocked from rejoining with that signed-in account">
                🚫 {bannedEmails.size} banned
              </span>
              <button
                className="kw-banclear"
                onClick={() => {
                  setBannedEmails(new Set())
                  saveBans(roomKey, new Set())
                }}
                title="Lift all bans for this room"
              >
                Clear
              </button>
            </div>
          )}
          {hostLobby.knocks.length > 0 && (
            <ul className="kw-knocks">
              {hostLobby.knocks.map((k) => (
                <li key={k.id} className="kw-knockrow">
                  <span className="kw-knocker">
                    <span aria-hidden="true">{k.avatar || '✋'}</span> {k.name || 'Guest'}
                  </span>
                  <button className="kw-admit" onClick={() => hostLobby.admit(k.id)} title={`Let ${k.name || 'them'} in`}>
                    Admit
                  </button>
                  <button className="kw-deny" onClick={() => hostLobby.deny(k.id)} title="Refuse">
                    Deny
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
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
                <AgentActionsBar call={call} placement="stage" hidden={hiddenAgents} />
                <AgentActionsBar call={call} placement="tile" hidden={hiddenAgents} />
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
                  className={`kw-stage${presenter ? ' kw-zoomable' : ''}${zoom.zoomed ? ' kw-zoomclip' : ''}`}
                  ref={stageRef}
                  style={tileH ? { height: tileH, aspectRatio: 'auto', maxHeight: 'none' } : undefined}
                >
                  {/* The zoom layer scales the video AND the ink (passed the same transform)
                      so annotations stay pinned to the screen while you pinch in. */}
                  <div className="kw-zoomlayer" style={{ transform: zoom.transform, transformOrigin: '0 0', willChange: zoom.zoomed ? 'transform' : undefined }}>
                    <Tile
                      key={focus.id}
                      p={focus}
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
                    <StageInk room={inkApi} stageRef={stageRef} zoomTransform={zoom.transform} toolbarSlot={inkSlot} onActiveChange={setInkActive} selfId={selfId} />
                  )}
                  {zoom.zoomed && (
                    <button className="kw-zoomreset" onClick={zoom.reset} title="Reset zoom (or double-tap)" aria-label="Reset zoom">
                      ⤢ 1×
                    </button>
                  )}
                </div>
                {/* The tiles + the ink toolbar share the SIDE area (a right column in landscape/desktop,
                    a bottom strip in portrait). The toolbar portals into kw-toolslot — placed here, OUTSIDE
                    the stage, so it's always tappable. */}
                {(focusOthers.length > 0 || (presenter && !preview)) && (
                  <div className="kw-side">
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
                    {presenter && !preview && <div className="kw-toolslot" ref={setInkSlot} />}
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
              <KibitzerSink key={p.id} stream={p.stream!} muted={deaf} sinkId={call.speakerId} />
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
            <div className="kw-verify">
              <div className="kw-verify-head">
                <ShieldIcon /> Verify your call is private
              </div>
              <p className="kw-verify-intro">
                {call.identityEnabled
                  ? 'A ✓ with someone’s email means Google confirmed who they are AND that no one is in the middle — nothing more to do for them. For anyone who hasn’t signed in, compare the emoji aloud: if they match on both screens, your call is private.'
                  : 'Read these emoji aloud to each other. If they match on both screens, your video and voice are end-to-end encrypted directly between you — no one is listening in the middle.'}
              </p>
              <p className="kw-verify-scope">
                This code verifies the <strong>media</strong> connection (your video and voice). Per-message
                verification of the data channel (chat, co-browse) is a planned follow-up.
              </p>
              {call.identityEnabled &&
                (call.selfIdentity ? (
                  <p className="kw-verify-self">
                    <span className="kw-id-check" aria-hidden="true">
                      ✓
                    </span>{' '}
                    You're verified as <strong>{call.selfIdentity.email}</strong>
                  </p>
                ) : (
                  <div className="kw-verify-signin">
                    <div ref={mountSignin} className="kw-id-gbtn" />
                    <p className="kw-id-hint">Sign in to prove who you are — others see a verified ✓.</p>
                  </div>
                ))}
              {verifyPeers.length === 0 ? (
                <p className="kw-verify-empty">No one else is here yet — the code appears once someone joins.</p>
              ) : (
                verifyPeers.map((p) => {
                  const s = safety[p.id]
                  const vid = identities[p.id]
                  return (
                    <div
                      key={p.id}
                      className={`kw-verify-row${vid ? ' idok' : s?.changed ? ' changed' : s?.verified ? ' ok' : ''}`}
                    >
                      <div className="kw-verify-who">
                        <span aria-hidden="true"><EmojiAvatar value={p.avatar || '🙂'} /></span> {p.name}
                        {/* The emoji "✓ verified" tag is only meaningful when we're showing the
                            emoji — a verified IDENTITY makes its own (stronger) statement below. */}
                        {!vid && s?.verified && !s.changed && (
                          <span className="kw-verify-tag" title="You confirmed this person's code">
                            ✓ verified
                          </span>
                        )}
                      </div>
                      {vid ? (
                        // Identity verified → the strong, combined guarantee. The binding can't
                        // succeed through a man-in-the-middle, so the emoji ritual is redundant
                        // and we drop it entirely for this person.
                        <>
                          <p className="kw-verify-id ok">
                            <span aria-hidden="true">✓</span> Verified as <strong>{vid.email}</strong>
                          </p>
                          <p className="kw-verify-idsub">
                            Google confirmed who they are, and it's bound to this encrypted connection — so no
                            one is in the middle. No need to compare emoji for them.
                          </p>
                        </>
                      ) : (
                        // Not identity-verified → the emoji ritual is the man-in-the-middle check.
                        <>
                          {call.identityEnabled && (
                            <p className="kw-verify-id">
                              Identity not proven (they haven't signed in) — compare the emoji to be sure:
                            </p>
                          )}
                          {s?.changed && (
                            <p className="kw-verify-warn">
                              ⚠️ This person's security key is different from the one you verified before. It may be a
                              new device — or someone impersonating them. Re-read the emoji with them before you trust
                              the call again.
                            </p>
                          )}
                          {s?.code ? (
                            <>
                              <div className="kw-verify-code">{s.code}</div>
                              {s.verified && !s.changed ? (
                                <button className="kw-verify-btn ok" onClick={() => unverify(p.id)}>
                                  Verified — tap to clear
                                </button>
                              ) : (
                                <button className="kw-verify-btn" onClick={() => verify(p.id)}>
                                  They match — mark verified
                                </button>
                              )}
                            </>
                          ) : (
                            <div className="kw-verify-pending">Establishing a direct secure link…</div>
                          )}
                        </>
                      )}
                    </div>
                  )
                })
              )}
              <p className="kw-verify-fine">
                These emoji verify the live video &amp; voice. Chat, links and co-browse also travel directly
                between browsers (encrypted in transit, no one in the middle relaying them).
              </p>
            </div>
          )}
          {chatOpen && (
            <div className="kw-chat">
              <AgentActionsBar call={call} placement="chat" hidden={hiddenAgents} />
              <div className="kw-msgs" ref={msgsRef}>
                {call.chat.length === 0 && (
                  <p className="kw-chat-hint">
                    Peer-to-peer and ephemeral — only people here right now see this, and nothing is stored anywhere.
                  </p>
                )}
                {call.chat.map((m) => (
                  <div key={m.id} className={`kw-msg${m.self ? ' self' : ''}${m.dm ? ' dm' : ''}`}>
                    <span className="kw-msg-name">
                      {m.self ? (m.dm && m.to ? `You → ${m.to}` : 'You') : m.name}
                      {m.dm && !m.self && <span className="kw-msg-priv"> · private</span>}
                    </span>
                    <span className="kw-msg-text">{m.text}</span>
                  </div>
                ))}
              </div>
              {recipients.length > 0 && (
                <div className="kw-to-row">
                  <label htmlFor="kw-to">To</label>
                  <select
                    id="kw-to"
                    className="kw-to"
                    value={recipientId ?? ''}
                    onChange={(e) => setRecipientId(e.target.value || null)}
                    title={recipientId ? 'Sending privately to one person' : 'Sending to everyone in the room'}
                  >
                    <option value="">Everyone</option>
                    {recipients.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name || 'Guest'}
                      </option>
                    ))}
                  </select>
                  {recipientId && <span className="kw-to-priv">🔒 private</span>}
                </div>
              )}
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
              <form
                className="kw-chatrow"
                onSubmit={(e) => {
                  e.preventDefault()
                  sendDraft()
                }}
              >
                {!preview && (
                  <button
                    type="button"
                    className={`kw-chat-pay${payOpen ? ' active' : ''}`}
                    onClick={() => setPayOpen((o) => !o)}
                    title="Request a payment"
                    aria-label="Request a payment"
                  >
                    💳
                  </button>
                )}
                <input
                  value={draft}
                  maxLength={500}
                  disabled={rg.active && !rg.canShare}
                  placeholder={
                    rg.active && !rg.canShare
                      ? rosterCompromised
                        ? 'Blocked — an unlisted person is here'
                        : 'Verifying the room…'
                      : recipientId
                        ? `Private to ${recipients.find((p) => p.id === recipientId)?.name || 'them'}…`
                        : 'Say it quietly…'
                  }
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button type="submit" disabled={!draft.trim() || (rg.active && !rg.canShare)}>
                  ➤
                </button>
              </form>
            </div>
          )}
          </div>
          {call.error && <p className="kw-error">{call.error}</p>}
          {/* Zoom-style bottom control bar. Big surfaces (room window / full screen): an in-flow bar that
              collapses with the rest of the chrome. Embedded tile view (`embedBar`): the SAME controls,
              but the bar (`kw-controlbar-float`) floats over the foot of the tile and only it auto-hides —
              the top bar stays, and because it's an overlay the tile never resizes when it goes. */}
          {(bottomBar || embedBar) && (
            <div className={`kw-controlbar${embedBar ? ' kw-controlbar-float' : ''}`}>{callControls}</div>
          )}
        </>
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
              <div className="kw-pre-tile">
                {preCam && previewStream && previewStream.getVideoTracks().length > 0 ? (
                  <video ref={previewVidEl} autoPlay playsInline muted className={`kw-pre-vid${preFacing === 'environment' ? ' no-mirror' : ''}`} />
                ) : (
                  <div className="kw-pre-face" aria-hidden="true">
                    {(name || '?').charAt(0).toUpperCase()}
                  </div>
                )}
                {/* Top-right stack, like Zoom: speaker (audio output) + forward/flip camera. */}
                <div className="kw-pre-side">
                  <button
                    type="button"
                    className="kw-pre-sidebtn"
                    aria-pressed={preSpeaker}
                    aria-label={preSpeaker ? 'Speaker on' : 'Speaker off'}
                    title="Speaker"
                    onClick={() => setPreSpeaker((v) => !v)}
                  >
                    {preSpeaker ? <SpeakerIcon /> : <SpeakerOffIcon />}
                  </button>
                  {preCam && (
                    <button type="button" className="kw-pre-sidebtn" aria-label="Flip camera" title="Flip camera" onClick={flipPre}>
                      <FlipCamIcon />
                    </button>
                  )}
                </div>
                <div className="kw-pre-ctl">
                  <button
                    type="button"
                    className={`kw-pre-btn${preMic ? ' on' : ''}`}
                    aria-pressed={preMic}
                    aria-label={preMic ? 'Mute microphone' : 'Unmute microphone'}
                    title="Microphone"
                    onClick={togglePreMic}
                  >
                    {preMic ? <MicIcon /> : <MicOffIcon />}
                  </button>
                  <button
                    type="button"
                    className={`kw-pre-btn${preCam ? ' on' : ''}`}
                    aria-pressed={preCam}
                    aria-label={preCam ? 'Turn camera off' : 'Turn camera on'}
                    title="Camera"
                    onClick={togglePreCam}
                  >
                    {preCam ? <VideoIcon /> : <VideoOffIcon />}
                  </button>
                </div>
              </div>
              {previewErr && <p className="kw-pre-err">{previewErr}</p>}
              <p className="kw-pre-title">
                <span className="kw-pre-roomlbl">ROOM</span> {roomDesc || roomName}
              </p>
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
          {(mics.length > (canTouch ? 1 : 0) || (!canTouch && cams.length > 0) || (CAN_PICK_SPEAKER && speakers.length > (canTouch ? 1 : 0))) && (
            <div className="kw-pre-devices">
              {mics.length > (canTouch ? 1 : 0) && (
                <label className="kw-pre-dev">
                  <span className="kw-pre-dev-ico" aria-hidden="true">
                    <MicIcon />
                  </span>
                  <select value={preMicId} onChange={(e) => selectMic(e.target.value)} aria-label="Microphone">
                    <option value="">Default microphone</option>
                    {mics.map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>
                    ))}
                  </select>
                </label>
              )}
              {!canTouch && cams.length > 0 && (
                <label className="kw-pre-dev">
                  <span className="kw-pre-dev-ico" aria-hidden="true">
                    <VideoIcon />
                  </span>
                  <select value={preCamId} onChange={(e) => selectCam(e.target.value)} aria-label="Camera">
                    <option value="">Default camera</option>
                    {cams.map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>
                    ))}
                  </select>
                </label>
              )}
              {CAN_PICK_SPEAKER && speakers.length > (canTouch ? 1 : 0) && (
                <label className="kw-pre-dev">
                  <span className="kw-pre-dev-ico" aria-hidden="true">
                    <SpeakerIcon />
                  </span>
                  <select value={preSpeakerId} onChange={(e) => setPreSpeakerId(e.target.value)} aria-label="Speaker">
                    <option value="">Default speaker</option>
                    {speakers.map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>{d.label || `Speaker ${i + 1}`}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
          {agentCall && (
            <div className="kw-agentwarn" role="alert">
              <div className="kw-agentwarn-h">
                <span aria-hidden="true">🤖</span> AI-assisted call{agentCall === 'audiovideo' ? ' (audio + video)' : ' (audio)'}
              </div>
              <p className="kw-agentwarn-b">
                {agentCall === 'audiovideo'
                  ? 'What you say, your camera/video, and the messages you send may be recorded and sent to third-party services for processing. By joining, you consent.'
                  : 'What you say — and the messages you send — may be recorded and sent to third-party services for processing. By joining, you consent.'}
              </p>
            </div>
          )}
          {notice && (
            <div className="kw-notice" role="note">
              <span className="kw-notice-ico" aria-hidden="true">
                ⓘ
              </span>
              <span className="kw-notice-txt">{notice}</span>
            </div>
          )}
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
          <input
            value={name}
            maxLength={14}
            placeholder="Your name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !mustVerifyToJoin && joinCall()}
          />
          <button
            className="kw-join"
            disabled={!room || room.status() === 'closed' || mustVerifyToJoin || !!call.retired}
            onClick={joinCall}
          >
            {call.retired ? 'Out of date' : mustVerifyToJoin ? 'Sign in to join' : wantRejoin && !rejoinDismissed ? '↻ Rejoin' : 'Join'}
            {!mustVerifyToJoin && call.rosterCount > 0 ? ` (${call.rosterCount} in)` : ''}
          </button>
          {!preview && (
            <button className={`kw-invite${copied ? ' copied' : ''}`} onClick={() => void copyInvite()}>
              {copied ? (
                <>
                  <CheckIcon /> Link copied — send it
                </>
              ) : (
                <>
                  <LinkIcon /> Copy invite link
                </>
              )}
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

      {/* Transient heads-up (mic/camera/share hiccup). A neutral, auto-dismissing toast floated over the
          panel — NOT the red error banner — since the mic/camera button on/off already conveys the result.
          Panel-level so it shows whether the failure happened at join (pre-join screen) or in-call. */}
      {call.notice && (
        <div className="kw-toast" role="status" aria-live="polite">
          {call.notice}
        </div>
      )}
    </div>
  )
}
