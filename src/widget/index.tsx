import { createRoot, type Root } from 'react-dom/client'
import { normalizeRoom } from '../core/transport'
import type { AgentCreditConfig, IdentityConfig } from '../core/identity'
import { decodeGateParams, gateParamsFrom, type GateDescriptor } from '../core/joinGateLink'
import { createAgent, createAgentFromBridge, cooldown } from '../agent/agent'
import { newChatLines, type ChatItem } from '../react/useCall'
import { setSignalHost } from '../core/signalConfig'
import { setTurnHost } from '../core/turnConfig'
import { setLicenseKey } from '../core/license'
import { setGrant } from '../core/grant'
import {
  type AppChannel,
  type CallControls,
  type CallSnapshot,
  type Knock,
  type LobbyJoinerStatus,
  type Participant,
  type WidgetBridge,
  Widget,
} from './Widget'
import css from './widget.css?inline'

export type { Participant } from './Widget'
export type { Knock, LobbyJoinerStatus } from './Widget'
export type { ChatItem } from '../react/useCall'

/**
 * Kibitz widget loader. Two ways in:
 *
 *   <script src="https://kibitz.chat/widget.js" data-room="my-room"></script>
 *
 * or programmatically:
 *
 *   <script src="https://kibitz.chat/widget.js"></script>
 *   <script>Kibitz.mount({ room: 'my-room' })</script>
 *
 * The widget renders inside a shadow root — the host page's styles can't break
 * it and its styles can't leak out.
 */

export interface MountOptions {
  room: string
  /** Pre-fill the visitor's display name (they can still edit it). */
  name?: string
  /** Start with the panel expanded (deliberate room visits) instead of the pill.
   *  Required if you drive the call via the returned controller (the data link
   *  connects on open). */
  startOpen?: boolean
  /** Dedicated room window (the kibitz.chat room page, NOT a third-party embed): the
   *  widget FILLS the window and is opaque — no see-through "ghost" mode (nothing
   *  underneath to see), and on desktop it resizes by dragging its edges like a normal
   *  window. Embedders omit this and keep the floating, ghostable panel. */
  fill?: boolean
  /** Dedicated room window only: called when the user leaves via the header's ← Home button.
   *  The kibitz.chat room page wires this to navigate back to the landing — the way OUT of a
   *  full-window room in an installed PWA (no browser back button / address bar). */
  onExit?: () => void
  /** Landing demo: render the real panel but never dial — local self-view only. */
  preview?: boolean
  /** Render NO panel — drive and render the call yourself via the returned
   *  controller (getParticipants / on('participants') / controls). Connects the
   *  call immediately. Attach each participant's stream to a MUTED `<video>`;
   *  Kibitz plays the audio for you (so camera-off peers are still heard). */
  headless?: boolean
  /** Stable host identity (per-user / per-seat / per-session). Makes reconnect
   *  dedupe + resume deterministic; otherwise a random per-tab token is used. */
  identity?: string
  /** Initial opaque per-participant metadata (seat, userId…) attached to you and
   *  carried in the roster. Update later with `setMeta()`. Keep it small. */
  meta?: Record<string, unknown>
  /** Force the signaling host, bypassing the /api/signal probe. For the browser
   *  extension, which runs on a chrome-extension:// origin (no /api/signal there)
   *  and must point straight at the worker, e.g. 'signal.kibitz.chat'. */
  signalHost?: string
  /** Point TURN + entitlement at an INDEPENDENT provider instead of this
   *  build's own `/api/turn` — e.g. 'turn.example.com' or a full origin. Lets a
   *  third party (or you, via a separate billing entity) provide and charge for
   *  TURN while this client stays free/pseudonymous. Omit → same-origin default.
   *  The twin of `signalHost`. */
  turnHost?: string
  /** A premium license key (an opaque bearer token) sent as
   *  `Authorization: Bearer` to `/api/turn`, so a gated endpoint grants TURN —
   *  see §7 of the docs. Stored locally; the caller stays anonymous. Omit for
   *  the free tier (STUN / open TURN). */
  licenseKey?: string
  /** A room-grant token (the "opener pays" capability) presented to `/api/turn`
   *  as `X-Kibitz-Grant`, so the room opener's license sponsors this peer's TURN.
   *  Usually carried in the invite link (`?grant=`); pass it here to drive it
   *  yourself. See §7 of the docs. */
  grant?: string
  /** OPT-IN verified identity (L3): require/allow participants to prove who they are
   *  with an OIDC provider, peer-to-peer (no server). Pass a provider + your OAuth
   *  client_id; a "Continue with Google" button appears in the lobby and verified
   *  peers get a ✓ badge bound to their encrypted connection. Omit (default) → fully
   *  account-free. See `IdentityConfig`. */
  verifyIdentity?: IdentityConfig
  /** Opt-in: require DECLARED agents to hold a valid network-access credit credential (verified
   *  against the issuer's JWKS). Default OFF/dormant — humans unaffected. See `AgentCreditConfig`. */
  agentCredits?: AgentCreditConfig
  /** Link-driven join gate ("link is everything"): the gate descriptor decoded from the
   *  invite link — signed invites or a name list. Decode it with
   *  `decodeGateParams(new URLSearchParams(location.search))` and pass it here; the room
   *  authority rebuilds the admission check from it alone (no server, no stored state). */
  joinGate?: GateDescriptor
  /** This peer's own credential for `joinGate` — their signed invite token (usually the
   *  `?gt=` param of their personal link). Auto-presented at the door. */
  joinCredential?: string
  /** Absolute base URL of the Kibitz email-code backend (issuer + `/api/email/jwks`), for
   *  embedders whose own origin isn't where the backend runs — e.g. the extension on
   *  chrome-extension://, which verifies email-method peers against `https://kibitz.chat`.
   *  Defaults to this page's origin (correct for kibitz.chat itself). */
  apiBase?: string
  /** Privacy: force media/data through the TURN relay (`iceTransportPolicy:'relay'`) so other
   *  participants never see your IP — only the relay does. Fail-closed: with no reachable TURN the
   *  call can't connect (it never silently falls back to a direct, IP-revealing path). You trust
   *  the relay with your IP; it still can't decrypt your media/data (DTLS). Needs a TURN server. */
  relayOnly?: boolean
  /** Host-supplied builder for the "Copy invite link" button — return the share URL to copy (e.g. a
   *  WhatsApp-friendly /j/room link, possibly with a freshly-minted TURN grant). Omit → copies the
   *  current page URL as before. */
  inviteLink?: () => string | Promise<string>
  /** Don't play other participants' audio through the speakers — a DEAF spectator. Useful for a
   *  second engine running in the SAME page (e.g. an in-page AI kibitzer) that would otherwise echo
   *  the local user's mic back out the speakers. It still receives the streams (and the controller
   *  exposes them); it just doesn't render an audible sink. */
  mutePlayback?: boolean
  /** Mark this as an AI-assisted ("agent") call, and say WHAT the agent perceives:
   *    'audio'      — it hears audio (+ chat): a voice agent.
   *    'audiovideo' — it also SEES video (your camera / shared screen): a video agent.
   *  Kibitz shows its OWN standard pre-join warning, worded to match the scope — that what's
   *  said/sent (and, for 'audiovideo', your video) may be recorded and passed to third-party services,
   *  and that joining = consent. This is the generic, floor-owned half of consent (Part 1); the
   *  SPECIFIC details (which agent / which third parties) come from `notice` (Part 2). */
  agentCall?: 'audio' | 'audiovideo'
  /** Optional SPECIFIC disclosure shown on the pre-join screen below Kibitz's generic warning (e.g.
   *  "Kibitzer 🧐 transcribes the call; audio → OpenAI & ElevenLabs"). Host-supplied TEXT — Kibitz
   *  renders it verbatim and stays agnostic about what it says. Joining the call = agreeing to it. */
  notice?: string
  /** Friendly room description shown as the pre-join title instead of the raw room code (when set). */
  roomDesc?: string
  /** White-label accent colour (any CSS colour). Recolours the call's green UI — the pre-join Join
   *  button, primary actions, speaking ring, agent chips — to this colour. Set on the shadow host as
   *  `--kw-accent` (custom properties inherit across the shadow boundary); a darker `--kw-accent-strong`
   *  is derived. Omit → the default Kibitz green. */
  accent?: string
  /** White-label product name shown in the call's own chrome (the OS Now-Playing title, the pop-out
   *  window title, the "start talking" tooltip, etc.). Omit → 'Kibitz'. */
  brandName?: string
}

/** A snapshot of the call's own state (the local participant + flags). */
export interface CallState {
  inCall: boolean
  micOn: boolean
  camOn: boolean
  /** You are sharing a screen/tab (rather than the camera) on the video lane. */
  sharing: boolean
  /** The local participant, or null when not in the call. */
  self: Participant | null
  /** We're the room authority — the only role that can gate entry. */
  isHost: boolean
  /** The admit-gate is on (joiners are held until admitted). Host-meaningful. */
  lobbyOn: boolean
  /** The room is locked — sealed to new members. Host-meaningful. */
  locked: boolean
  /** Our OWN knock state as a joiner: held, refused, or nothing in play. */
  lobbyStatus: LobbyJoinerStatus
  /** Verified identity is configured for this room. */
  identityEnabled: boolean
  /** Our own verified email once signed in (null until then). */
  selfEmail: string | null
  /** Verified-roster: active, whether content may flow, and whether an off-roster peer is present. */
  rosterActive: boolean
  rosterCanShare: boolean
  rosterCompromised: boolean
}

type CallEvent = 'participants' | 'join' | 'leave' | 'speaking' | 'state' | 'knocks' | 'lobby' | 'chat'

export interface MountedWidget {
  unmount(): void
  /**
   * Broadcast an opaque message to everyone ELSE on the call — the seam for
   * shared state that rides the call's data channel (co-browse / follow-me).
   * Kibitz never inspects `data`; it must be structured-clone-able. A no-op until
   * the call's data link is connected (i.e. once the panel has been opened); you
   * never receive your own message back.
   */
  broadcast(data: unknown): void
  /**
   * Send an opaque message to ONE participant by id (e.g. a game's per-player hidden
   * state). They receive it via `onMessage` like any other. Sent DIRECTLY peer-to-peer
   * over a DTLS-encrypted data connection — no other participant (not even the room
   * host) relays or sees it. No-op until you're in the call.
   */
  sendTo(participantId: string, data: unknown): void
  /**
   * Subscribe to messages from other people on the call. The callback also receives
   * the sender's participant id. Additive — each call adds a listener; the returned
   * function removes it.
   */
  onMessage(cb: (data: unknown, from: string) => void): () => void

  // ── App-message schema discovery (agent self-description) ────────────────────
  /**
   * Publish a schema describing your `broadcast`/`sendTo` messages (and/or shared view), so an
   * agent on the call can discover how to read them without out-of-band docs. Re-broadcast to
   * anyone who joins later, so discovery is order-independent. Re-publishing a `name` replaces it.
   * Keep it small — it rides the data mesh. No-op until you're in the call.
   */
  registerSchema(name: string, version: string, schema: unknown): void
  /** Every schema currently known — yours and every peer's, each attributed by its publisher id. */
  getSchemas(): readonly import('../react/useCall').SchemaInfo[]
  /** Subscribe to schemas as peers publish them. Returns an unsubscribe function. */
  onSchema(cb: (s: import('../react/useCall').SchemaInfo) => void): () => void

  // ── Composable-engine controller (read / drive / observe the call) ───────────
  /** Current call state (in-call flag, mic/cam, and the local participant). */
  getState(): CallState
  /** The live participant list (includes yourself once in the call). */
  getParticipants(): Participant[]
  /** Join the call (muted, camera off by default; pass mic/cam to turn them on).
   *  Needs the data link up — mount with `startOpen: true` when driving headlessly. */
  join(opts?: { mic?: boolean; cam?: boolean }): Promise<boolean>
  leave(): void
  toggleMic(): void
  toggleCam(): Promise<void>
  /** Share your screen/tab via the browser picker (getDisplayMedia). Returns false
   *  if blocked/cancelled. Replaces the camera on the video lane while active. */
  shareScreen(): Promise<boolean>
  /** Publish an externally-captured video track (e.g. an extension's
   *  chrome.tabCapture stream) on the video lane. */
  shareTrack(track: MediaStreamTrack): Promise<boolean>
  /** Stop sharing; the video lane returns to off. */
  stopShare(): void
  /** Publish a custom outgoing audio track (e.g. a synthesized song or TTS speech); pass null to
   *  restore silence. Lets a headless agent SPEAK into the call, not just listen. */
  publishAudioTrack(track: MediaStreamTrack | null): void
  /** Set your display name. */
  setName(name: string): void
  /** Set your emoji avatar ('' = initials). */
  setAvatar(avatar: string): void
  /** Update your opaque per-participant metadata (seat, userId…). */
  setMeta(meta: Record<string, unknown>): void

  // ── Built-in room chat (the chat humans see) ─────────────────────────────────
  /** Post a line to the room's built-in chat. With `to` (a participant id) it's a private
   *  message to just that peer. Lets a headless agent talk in the room with no UI of its own.
   *  Honest peers drop chat from a read-only agent (meta.role='agent') unless the host grants
   *  `send-chat`; mount without that role (a normal participant) to talk in an open room. */
  sendChat(text: string, to?: string): void
  /** The room's ephemeral chat scrollback (capped buffer; newest last). */
  getChat(): readonly ChatItem[]

  // ── Lobby / knock-to-admit ──────────────────────────────────────────────────
  /** The host's live waiting list (people who knocked). Empty unless we're the
   *  gating host. Pair with `on('knocks', …)` to render an admit/deny queue. */
  getKnocks(): Knock[]
  /** Turn the admit-gate on/off — held joiners must be admitted. No-op off-host. */
  setLobby(on: boolean): void
  /** Let a waiting knocker in / refuse them, by their knock id. Host only. */
  admit(id: string): void
  deny(id: string): void
  /** Remove a call member by their participant id (host only). The removed peer is
   *  told to leave and blocked from rejoining this room with the same link. */
  remove(id: string): void
  /** Lock / unlock the room (host only) — sealed to new members; existing ones may
   *  still reconnect. */
  setLocked(on: boolean): void
  /** Reset the room (host only) — clear everyone's ephemeral chat scrollback. */
  resetRoom(): void
  /** Introduce yourself to the host's lobby before joining (name + emoji avatar) —
   *  what the host sees in the queue. Re-callable to rename while you wait. */
  knock(name: string, avatar: string): void
  /** Verified rooms: render the provider's sign-in into `container` (Google button, or the
   *  email→code form for `method:'email'`); on success the cert-bound token is broadcast.
   *  Resolves true if signed in. Inert unless verified identity is configured. */
  signInIdentity(container: HTMLElement, method?: 'google' | 'email'): Promise<boolean>
  /** The cert-bound nonce an EXTERNAL sign-in surface must echo so its minted token binds to
   *  THIS connection. Null until the cert is ready. For embedders that run sign-in on another
   *  origin (where GIS / a backend work) — pair with `provideIdentityToken`. */
  identityNonce(): Promise<string | null>
  /** Adopt a cert-bound token obtained out-of-page (signed against `identityNonce()`), exactly
   *  as an in-page sign-in would. Resolves true if adopted (broadcast to peers). */
  provideIdentityToken(jwt: string): Promise<boolean>
  /** Mount AS an AI agent: adopt the agent's own private signing key (a JWK the operator holds) so
   *  it presents a cert-bound key assertion the authority checks against the room's allow-list — an
   *  agent enters by its OWN key, no human. Kept fresh for reconnects. True if adopted. */
  provideAgentKey(privateKeyJwk: JsonWebKey): Promise<boolean>
  /** Mount AS a paid agent: forward a short-lived network-access credit credential (fetched from a
   *  trusted issuer) so it rides our announce — a credit-gated authority verifies it and keeps
   *  admitting us. Call ~every minute with a freshly-renewed credential. No-op before join. */
  provideAgentCredit(credential: string): void
  /** A participant's effective capability grant — what it may perceive (content that flows to it)
   *  and act (what it may emit). Humans default to full; agents (meta.role='agent') to read-only.
   *  For building a host-side consent/permission UI. */
  getCapabilityGrant(id: string): import('../core/capabilities').Grant
  /** Set (null clears) a participant's capability override; the engine enforces it per-peer
   *  (host-local in v1). Host action. */
  setCapabilityGrant(id: string, grant: import('../core/capabilities').Grant | null): void
  /** Recent local capability-audit events for a participant — acts blocked by its grant + grant
   *  changes (host-visible; nothing stored or sent). Newest first. */
  getAgentAudit(id: string): readonly import('../react/useCall').AuditEntry[]

  /** Subscribe to call events. Returns an unsubscribe function. */
  on(event: 'participants', cb: (people: Participant[]) => void): () => void
  on(event: 'join' | 'leave', cb: (p: Participant) => void): () => void
  on(event: 'speaking', cb: (speakingIds: string[]) => void): () => void
  on(
    event: 'state',
    cb: (s: {
      inCall: boolean
      micOn: boolean
      camOn: boolean
      sharing: boolean
      isHost: boolean
      lobbyOn: boolean
      locked: boolean
      lobbyStatus: LobbyJoinerStatus
      identityEnabled: boolean
      selfEmail: string | null
      rosterActive: boolean
      rosterCanShare: boolean
      rosterCompromised: boolean
    }) => void,
  ): () => void
  /** The host's waiting list changed (someone knocked / was admitted / left). */
  on(event: 'knocks', cb: (knocks: Knock[]) => void): () => void
  /** OUR own lobby status changed: held ('waiting'), refused ('denied'), or in
   *  (null). Drive a "waiting to be let in" overlay off this. */
  on(event: 'lobby', cb: (status: LobbyJoinerStatus) => void): () => void
  /** A new chat line arrived from another participant (not our own). */
  on(event: 'chat', cb: (line: ChatItem) => void): () => void
}

export function mount(opts: MountOptions): MountedWidget {
  const room = normalizeRoom(opts.room)
  if (!room) throw new Error('Kibitz.mount: a non-empty `room` is required')

  // Link-driven gate ("the gate is the link"): if the embedder didn't pass a joinGate, decode it
  // from the current URL — the gate descriptor (+ a google clientId, + a per-guest `gt` credential)
  // all ride the link. So a HEADLESS host (e.g. a game embedding Kibitz) admits gated joiners with
  // zero gate code of its own — it just loads the gated link. `require` stays manifest-driven (a
  // human roster forces it on once the manifest loads; an agent-only room stays open for people but
  // gated for agents). An embedder can still pass joinGate/verifyIdentity explicitly to override.
  let effGate = opts.joinGate
  let effVerify = opts.verifyIdentity
  let effCred = opts.joinCredential
  if (!effGate && typeof location !== 'undefined') {
    const params = gateParamsFrom(location.hash, location.search)
    const decoded = decodeGateParams(params)
    if (decoded.mode !== 'open') {
      effGate = decoded
      if (!effVerify && decoded.mode === 'google' && decoded.clientId) effVerify = { provider: 'google', clientId: decoded.clientId }
      if (!effCred) effCred = params.get('gt') ?? undefined
    }
  }
  if (opts.signalHost) setSignalHost(opts.signalHost)
  if (opts.turnHost) setTurnHost(opts.turnHost)
  if (opts.licenseKey) setLicenseKey(opts.licenseKey)
  if (opts.grant) setGrant(opts.grant)

  const host = document.createElement('div')
  host.setAttribute('data-kibitz', '')
  // White-label accent: set on the host so it inherits across the shadow boundary into widget.css's
  // `var(--kw-accent)`. A darker companion (`--kw-accent-strong`) is derived for hovers/pressed states.
  if (opts.accent) {
    host.style.setProperty('--kw-accent', opts.accent)
    host.style.setProperty('--kw-accent-strong', `color-mix(in srgb, ${opts.accent}, #000 16%)`)
  }
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = css
  shadow.appendChild(style)
  const mountEl = document.createElement('div')
  shadow.appendChild(mountEl)
  document.body.appendChild(host)

  // Bridge between the live call (inside the Widget) and this returned controller.
  // The app channel + controls aren't live until the Widget connects a room (panel
  // open), so calls before then no-op gracefully.
  let liveLink: AppChannel | null = null
  const messageListeners = new Set<(data: unknown, from: string) => void>()
  let controls: CallControls | null = null
  let snapshot: CallSnapshot = {
    participants: [],
    inCall: false,
    micOn: false,
    camOn: false,
    sharing: false,
    isHost: false,
    lobbyOn: false,
    locked: false,
    knocks: [],
    chat: [],
    lobbyStatus: null,
    identityEnabled: false,
    selfEmail: null,
    rosterActive: false,
    rosterCanShare: true,
    rosterCompromised: false,
  }
  const listeners: Record<CallEvent, Set<(arg: never) => void>> = {
    participants: new Set(),
    join: new Set(),
    leave: new Set(),
    speaking: new Set(),
    state: new Set(),
    knocks: new Set(),
    lobby: new Set(),
    chat: new Set(),
  }
  const emit = (e: CallEvent, arg: unknown) =>
    listeners[e].forEach((cb) => {
      try {
        ;(cb as (a: unknown) => void)(arg)
      } catch {
        /* a host callback threw — don't let it break our diff loop */
      }
    })
  // Cheap change key: id + cam + speaking + name + stream identity + meta. Includes
  // stream id so null→MediaStream (media arrived) fires a 'participants' event.
  const pkey = (ps: Participant[]) =>
    ps.map((p) => `${p.id}|${p.camOn}|${p.speaking}|${p.name}|${p.stream?.id ?? '-'}|${JSON.stringify(p.meta)}`).join('//')
  // Knock-list change key: id + name + avatar, so a live rename fires 'knocks' too.
  const kkey = (ks: Knock[]) => ks.map((k) => `${k.id}|${k.name}|${k.avatar}`).join('//')

  const bridge: WidgetBridge = {
    attach(link) {
      liveLink = link
      link.onApp((m) =>
        messageListeners.forEach((cb) => {
          try {
            cb(m.data, m.from)
          } catch {
            /* a host listener threw — don't let it break delivery to the others */
          }
        }),
      )
    },
    detach() {
      liveLink = null
    },
    setControls(c) {
      controls = c
    },
    pushSnapshot(s) {
      const prev = snapshot
      const prevById = new Map(prev.participants.map((p) => [p.id, p]))
      const nowById = new Map(s.participants.map((p) => [p.id, p]))
      snapshot = s
      for (const p of s.participants) if (!prevById.has(p.id)) emit('join', p)
      for (const p of prev.participants) if (!nowById.has(p.id)) emit('leave', p)
      if (pkey(prev.participants) !== pkey(s.participants)) emit('participants', s.participants)
      const nowSpk = s.participants.filter((p) => p.speaking).map((p) => p.id)
      const prevSpk = prev.participants.filter((p) => p.speaking).map((p) => p.id)
      if (nowSpk.join(',') !== prevSpk.join(',')) emit('speaking', nowSpk)
      if (
        s.inCall !== prev.inCall ||
        s.micOn !== prev.micOn ||
        s.camOn !== prev.camOn ||
        s.sharing !== prev.sharing ||
        s.isHost !== prev.isHost ||
        s.lobbyOn !== prev.lobbyOn ||
        s.locked !== prev.locked ||
        s.lobbyStatus !== prev.lobbyStatus ||
        s.identityEnabled !== prev.identityEnabled ||
        s.selfEmail !== prev.selfEmail ||
        s.rosterActive !== prev.rosterActive ||
        s.rosterCanShare !== prev.rosterCanShare ||
        s.rosterCompromised !== prev.rosterCompromised
      )
        emit('state', {
          inCall: s.inCall,
          micOn: s.micOn,
          camOn: s.camOn,
          sharing: s.sharing,
          isHost: s.isHost,
          lobbyOn: s.lobbyOn,
          locked: s.locked,
          lobbyStatus: s.lobbyStatus,
          identityEnabled: s.identityEnabled,
          selfEmail: s.selfEmail,
          rosterActive: s.rosterActive,
          rosterCanShare: s.rosterCanShare,
          rosterCompromised: s.rosterCompromised,
        })
      // Lobby-specific events: the host's queue, and our own knock status.
      if (kkey(prev.knocks) !== kkey(s.knocks)) emit('knocks', s.knocks)
      if (prev.lobbyStatus !== s.lobbyStatus) emit('lobby', s.lobbyStatus)
      // Built-in chat: fire 'chat' for each freshly-received (non-self) line, so a headless
      // agent can react to typed messages the way a human reads the chat panel.
      for (const line of newChatLines(prev.chat, s.chat)) emit('chat', line)
    },
  }

  const root: Root = createRoot(mountEl)
  root.render(
    <Widget
      room={room}
      defaultName={opts.name}
      brandName={opts.brandName}
      startOpen={opts.startOpen}
      fill={opts.fill}
      onExit={opts.onExit}
      host={host}
      preview={opts.preview}
      headless={opts.headless}
      mutePlayback={opts.mutePlayback}
      identity={opts.identity}
      meta={opts.meta}
      verifyIdentity={effVerify}
      agentCredits={opts.agentCredits}
      relayOnly={opts.relayOnly}
      joinGate={effGate}
      joinCredential={effCred}
      apiBase={opts.apiBase}
      inviteLink={opts.inviteLink}
      agentCall={opts.agentCall}
      notice={opts.notice}
      roomDesc={opts.roomDesc}
      bridge={bridge}
    />,
  )

  const selfOf = (s: CallSnapshot): Participant | null => s.participants.find((p) => p.isSelf) ?? null

  return {
    unmount() {
      root.unmount()
      host.remove()
    },
    broadcast(data) {
      liveLink?.sendApp(data)
    },
    sendTo(participantId, data) {
      liveLink?.sendAppTo?.(participantId, data)
    },
    onMessage(cb) {
      messageListeners.add(cb)
      return () => {
        messageListeners.delete(cb)
      }
    },
    registerSchema(name, version, schema) {
      liveLink?.registerSchema?.(name, version, schema)
    },
    getSchemas() {
      return liveLink?.getSchemas?.() ?? []
    },
    onSchema(cb) {
      // Until the call's data link is attached, there's nothing to subscribe to; hand back a
      // no-op unsubscribe so the caller's contract holds. (Schemas are re-broadcast on join, so a
      // listener added after attach still sees everything.)
      return liveLink?.onSchema?.(cb) ?? (() => {})
    },
    getState() {
      return {
        inCall: snapshot.inCall,
        micOn: snapshot.micOn,
        camOn: snapshot.camOn,
        sharing: snapshot.sharing,
        self: selfOf(snapshot),
        isHost: snapshot.isHost,
        lobbyOn: snapshot.lobbyOn,
        locked: snapshot.locked,
        lobbyStatus: snapshot.lobbyStatus,
        identityEnabled: snapshot.identityEnabled,
        selfEmail: snapshot.selfEmail,
        rosterActive: snapshot.rosterActive,
        rosterCanShare: snapshot.rosterCanShare,
        rosterCompromised: snapshot.rosterCompromised,
      }
    },
    getParticipants() {
      return snapshot.participants
    },
    getKnocks() {
      return snapshot.knocks
    },
    join(o) {
      return controls ? controls.join(o) : Promise.resolve(false)
    },
    leave() {
      controls?.leave()
    },
    toggleMic() {
      controls?.toggleMic()
    },
    toggleCam() {
      return controls ? controls.toggleCam() : Promise.resolve()
    },
    shareScreen() {
      return controls ? controls.shareScreen() : Promise.resolve(false)
    },
    shareTrack(track) {
      return controls ? controls.shareTrack(track) : Promise.resolve(false)
    },
    stopShare() {
      controls?.stopShare()
    },
    publishAudioTrack(track) {
      controls?.publishAudioTrack(track)
    },
    setName(n) {
      controls?.setName(n)
    },
    setAvatar(a) {
      controls?.setAvatar(a)
    },
    setMeta(m) {
      controls?.setMeta(m)
    },
    sendChat(text, to) {
      controls?.sendChat(text, to)
    },
    getChat() {
      return snapshot.chat
    },
    setLobby(on) {
      controls?.setLobby(on)
    },
    admit(id) {
      controls?.admit(id)
    },
    deny(id) {
      controls?.deny(id)
    },
    remove(id) {
      controls?.remove(id)
    },
    setLocked(on) {
      controls?.setLocked(on)
    },
    resetRoom() {
      controls?.resetRoom()
    },
    knock(name, avatar) {
      controls?.knock(name, avatar)
    },
    signInIdentity(container, method) {
      return controls ? controls.signInIdentity(container, method) : Promise.resolve(false)
    },
    identityNonce() {
      return controls ? controls.identityNonce() : Promise.resolve(null)
    },
    provideIdentityToken(jwt) {
      return controls ? controls.provideIdentityToken(jwt) : Promise.resolve(false)
    },
    provideAgentKey(privateKeyJwk) {
      return controls ? controls.provideAgentKey(privateKeyJwk) : Promise.resolve(false)
    },
    provideAgentCredit(credential) {
      if (controls) controls.provideAgentCredit(credential)
    },
    getCapabilityGrant(id) {
      return controls ? controls.getCapabilityGrant(id) : { perceive: [], act: [] }
    },
    setCapabilityGrant(id, grant) {
      controls?.setCapabilityGrant(id, grant)
    },
    getAgentAudit(id) {
      return controls ? controls.getAgentAudit(id) : []
    },
    on(event: CallEvent, cb: (arg: never) => void) {
      listeners[event].add(cb)
      return () => {
        listeners[event].delete(cb)
      }
    },
  }
}

declare global {
  interface Window {
    Kibitz?: {
      mount: typeof mount
      createAgent: typeof createAgent
      createAgentFromBridge: typeof createAgentFromBridge
      cooldown: typeof cooldown
    }
  }
}

window.Kibitz = { mount, createAgent, createAgentFromBridge, cooldown }

// Auto-mount when the script tag carries data-room.
const tag = document.currentScript as HTMLScriptElement | null
const autoRoom = tag?.dataset.room
if (autoRoom) {
  const go = () => {
    try {
      mount({ room: autoRoom, name: tag?.dataset.name })
    } catch {
      /* invalid room — stay quiet on someone else's page */
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true })
  else go()
}
