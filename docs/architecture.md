# Kibitz Architecture

Kibitz is an **account-free, serverless, peer-to-peer** call + collaboration engine — an
embeddable widget *and* a headless controller. This is the system overview the other docs
slot into.

> See also: [verification.md](./verification.md) (who gets in),
> [agent-platform.md](./agent-platform.md) (agents in a room),
> [threat-model.md](./threat-model.md) (what's protected).

---

## 1. The shape

- **No accounts.** Identity is opt-in and proven peer-to-peer (never an account on our side).
- **No backend for calls.** Media and data go **directly between browsers**, end-to-end
  encrypted. The only servers are stateless edge helpers (signaling, TURN) that can't see
  content — and even those drop away in [offline mode](./offline-mode.md), where a user-run
  LAN hub replaces the cloud entirely.
- **A room is a link.** Open the link, you're together. There's no room database; if everyone
  leaves, the room stops existing.
- **Embeddable + headless.** The same engine renders a floating panel (the Widget) or runs
  with **no UI** (the composable controller), so a host app draws its own surface.

## 2. The room model

A room id (normalized from the link) maps to a **deterministic signaling id**. The **first
peer to claim it becomes the coordinator**; later peers join as participants. The coordinator
is **positional, migratory plumbing** — it keeps the roster, runs presence ping/reap, relays
signaling (including the lobby/lock/host-command channel), and applies the
[verification gate](./verification.md). It has **no discretionary moderation power of its own**
and is **just a participant's browser**; if it leaves, the role **migrates** to another peer
(heartbeat + reclaim — `room.ts` `becomeAuthority`), and the new coordinator rebuilds the
roster and inherited settings from what it took over.

**Admin is a separate role.** The waiting room (admit/deny knocks), lock/unlock, kick, and
reset belong to a **verified host**, *decoupled* from the coordinator. This fixes the "coup"
(a stranger who became coordinator could otherwise seize moderation) and "bans vanish on
migration". The link can commit a host identity at one of **four tiers**:

- **None (open)** — the default. **No host ⇒ no admin at all**: the moderation UI is hidden
  and host actions are inert (`room.ts:264-265` — absent host key ⇒ the room has no admin).
- **Soft name** — a committed display name; whoever joins under it is treated as host. No
  crypto, so it's spoofable by any link-holder, and moderation is coordinator-scoped
  (`room.ts` `matchHostByName` :370-375).
- **OIDC email** — a committed email the host proves via sign-in; every peer verifies the
  cert-bound ID token peer-to-peer, so the coordinator declares the matching member host
  locally (`room.ts` `declareHost` :745). The room stays open — only admin is gated.
- **Password key** — a committed ECDSA public key (the private key rides the link sealed
  under a host password). Admin commands are then **cert-bound and signed**, verified against
  the committed key by whatever coordinator currently holds the room (`room.ts` `handleMod` /
  `enactMod` / `verifyHostCommand` :489-545), so they work from any seat and survive migration.

The host role does **not** migrate with the coordinator: on migration (and on the host's own
disconnect) the host slot resets to empty until someone re-proves it (`room.ts:360-364`,
`verifiedHostId = ''` :647). A committed key disables the weaker name/email tiers. See
[verification.md](./verification.md).

Presence runs as a **star** to the coordinator (each participant ↔ coordinator); **content
does not** (next section).

## 3. Three transport planes

| Plane | Carries | Topology | Encryption | Helper |
|-------|---------|----------|-----------|--------|
| **Signaling / presence** | room join, roster, lobby/lock/kick, gate announces | star → coordinator (PeerJS) | WSS/TLS to the broker | self-hosted broker `signal.kibitz.chat`, with automatic fallback to the public PeerJS broker |
| **Media** | audio / video / screen | full WebRTC **mesh** | **DTLS-SRTP, E2E** | Cloudflare TURN when direct fails |
| **Data** | chat, co-browse, directed messages, agent envelopes | full DTLS data **mesh** | **DTLS, E2E** | own DTLS DataConnections, reconciled over the same roster |

Each participant actually runs on **two separate PeerJS peers**: a presence connection to the
coordinator, and a **dedicated media peer** whose id is the participant's `voiceId` carried on
the roster (`callMedia.ts` `peerJsMedia`; `room.ts:34-38`). The **data mesh is its own set of
DataConnections**, dialled in parallel to the media `MediaConnection`s and surviving media
re-dials — it is *not* the same connection set (`mesh.ts` `createVoiceMesh`, `dataDialled`
:209-255). Which signaling broker the call uses is chosen dynamically but consistently across
participants: `/api/signal` reports the self-hosted worker when healthy, else the public
PeerJS broker, so two peers always meet on the same broker (`signalConfig.ts`).

The crucial property: **media and data are a peer-to-peer mesh, end-to-end encrypted — no
participant (not even the coordinator) relays content, and there is no media server that
*could* decode or record it.** The broker sees only presence metadata; TURN forwards
encrypted packets it can't read. (See [threat-model.md](./threat-model.md).)

A **TURN relay** (Cloudflare Realtime) is used only when two networks can't connect directly;
it forwards the still-encrypted call. A per-browser **"hide my IP"** toggle routes your media
and data through TURN only (`relayOnly` ⇒ `iceTransportPolicy:'relay'`, fail-closed — no
reachable TURN means no connect, never a silent direct fallback), so peers see the relay's IP,
not yours (`relayPref.ts`, `callMedia.ts:28-32`).

Note that `relayOnly` uses *only* relay candidates, so it relays **even when the two peers are on
the same LAN** — a direct local connection would hand the other peer your LAN IP, which is exactly
what the toggle exists to prevent. (`'relay'` is all-or-nothing; WebRTC has no "direct-on-LAN-only"
policy.) Without the toggle, same-LAN peers connect **directly** over host candidates — having TURN
configured never forces its use, it's only a fallback when no direct path forms. For a call that
should stay **local and direct** with no relay at all, use the offline / same-Wi-Fi hub
(`iceServers: []`, below).

### Resilience

- **Auto-rejoin.** A reload, an iOS tab-kill, or a crash would otherwise dump the user at the
  Join screen; a small per-room intent (90 s TTL, re-stamped on a heartbeat, cleared on an
  explicit Leave) brings them back into the same room on the next mount (`rejoinIntent.ts`).
- **Pagehide proactive-leave.** A clean exit announces departure on `pagehide`, so a peer
  drops in ~0.2 s instead of waiting out the reap timeout (`transport.ts:287-301`).

## 4. The composable engine

`mount(opts)` boots the engine and returns a **controller** (`MountedWidget`):

- **Panel mode** — renders the floating, shadow-DOM Widget (an embedder drops in one line).
- **Headless mode** (`headless: true`) — renders **no UI**; the host app reads/drives the
  call via the controller: `getParticipants()` / `on('participants'|'join'|'leave'|…)`,
  `join/leave/toggleMic/shareScreen`, `broadcast/sendTo/onMessage`, host ops
  (`setLobby/admit/deny/remove/setLocked`), and the capability controls
  (`getCapabilityGrant/setCapabilityGrant/getAgentAudit` — see §6).

The Widget UI is just **one consumer** of this controller. The same controller powers the
[Whist reference game](https://whist.kibitz.chat) (headless, draws its own table) and the
[Agent SDK](./agent-platform.md). An in-memory transport (`createLocalBus`) runs the real
presence engine with no network, for deterministic tests.

## 5. Identity & verification

Two independent, composable layers, both peer-to-peer:

- **Connection authenticity — the safety code (SAS).** Each pair derives a short emoji code
  from the **actual DTLS certificate fingerprints** they handshook; matching it out-of-band
  proves there's no machine-in-the-middle. A changed key raises an alarm.
- **Real-world identity — opt-in OIDC**, cryptographically **bound to that same cert** so it
  can't be replayed over another connection. See [verification.md §4.1](./verification.md).

Who may *enter* a room is [the verification gate](./verification.md): the link carries a
verifier, the coordinator checks credentials before rostering.

## 6. Participant capabilities

Once in, **what each participant may do is itself scoped** — a general per-participant
permission model (humans *and* agents), not an agent-only bolt-on. Each participant carries a
**`Grant`** of what it may **perceive** (content that flows *to* it) and **act** (what it may
emit):

- **Perceive:** `see-screen`, `hear-audio`, `read-chat`, `read-roster`, `receive-directed`.
- **Act:** `send-chat`, `speak`, `act`.

Defaults are by **kind** (`meta.role`): a **human is full**; an **agent is read-only** —
`read-chat`/`read-roster`/`receive-directed`, no act, no media. The host can widen or revoke
any grant live, with a per-agent consent panel + a local-only **audit feed** (blocked acts +
grant changes). The model is pure and serializable (`core/capabilities.ts`).

**The engine enforces it per-peer** (not the app — there's no server to police it):

- **Perceive = sender-side withholding.** A peer never *delivers* data a recipient can't see
  (`broadcastContent`), and a withheld **media** lane is swapped for a flowing placeholder on
  just that peer's connection (`mesh.ts` `gatedTrack`/`setMediaGate`) — so a read-only agent
  receives **no audio and no screen share**, not even one frame.
- **Act = receiver-side dropping.** Every honest peer ignores content from a peer whose grant
  lacks `send-chat`, so a tampered client still can't post.
- **Coordinator-distributed.** The coordinator broadcasts the whole grant map (a `caps`
  control message, accepted only from the host id) so **every** peer enforces the same policy —
  uniform even in 3+-human rooms, and re-synced to new joiners + across migration.

Disclosure: an agent may declare its model **`backend`** and whether what it perceives
**`egress`**es the E2EE room — shown to the host, never a privilege it grants itself. See
[agent-platform.md](./agent-platform.md).

## 7. Edge infrastructure

All stateless and content-blind, on Cloudflare:

- **Pages** — static hosting of the app/widget bundle.
- **Signaling Worker** (`signal.kibitz.chat`) — a PeerJS-compatible broker; sees presence
  metadata, not content. Selected via `/api/signal` with automatic fallback to the public
  PeerJS broker when it's unhealthy (`signalConfig.ts`).
- **TURN** (Cloudflare Realtime) — relays encrypted media when direct fails. The TURN +
  entitlement endpoint can be an **independent provider** on another origin (the `turnHost`
  mount option; CORS-open `/api/turn`), so "who ships the client" and "who bills TURN" can
  differ (`turnConfig.ts`, `iceConfig.ts`).
- **Grants / TURN auth Worker** — "opener pays" capability tokens for sponsored TURN.

Optionally, a room can require a per-minute **agent network-access credit** — a signed,
short-lived credential an agent re-presents ~every minute; the coordinator verifies it and
reaps an agent whose credit lapses (`room.ts:122-134`, `requireAgentCredits` :203). See
[agent-platform.md](./agent-platform.md).

**Offline / LAN hub** (separate, user-run, optional): a tiny Go relay published as the
**kibitz-offline** project routes WebRTC handshakes on one Wi-Fi so a call needs no internet
at all. Content-blind like the cloud helpers — see [offline-mode.md](./offline-mode.md).

The project is operated **pseudonymously**; nothing requires an account or holds call content.

## 8. Surfaces an integrator uses

- **Embed:** `<script src=".../widget.js">` or `Kibitz.mount({ room })`.
- **Headless control:** `mount({ room, headless: true })` → the controller.
- **Agents:** the [Agent SDK](./agent-platform.md) over the controller.
- **Verification:** opt-in via the mount options + the link (`verifyIdentity`, `joinGate`).

## 9. Non-goals

- Not an SFU/MCU — it's a mesh, best for small groups (≈2–6).
- No server-side recording, transcripts, or content storage — there is nothing to subpoena.
- The coordinator is trusted to coordinate presence (not to moderate — that's the verified
  host); Kibitz does not defend against a *malicious* coordinator (an inherent P2P assumption
  — see the threat model).
