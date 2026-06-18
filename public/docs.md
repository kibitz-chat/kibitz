# The Kibitz Engine — embed, headless & AI agents

> Source: https://kibitz.chat/docs

One small, open, peer-to-peer engine — three ways to use it: drop a floating end-to-end-encrypted call onto any site with one script tag; drive it **headless** to build your own UI on its rooms, media and data; or let an **AI agent** join a room as a participant. It's the same `widget.js` that powers kibitz.chat and whist.kibitz.chat (a full card game built on the headless engine, open source as a reference design).

## How AI fits in
A room is just a link, and an agent joins it the same way a person does — over the same peer-to-peer, end-to-end-encrypted channel, seeing what the room sees and acting right beside everyone. The engine is headless-first, so an agent is simply a participant your code drives: it reads the room's shared state and browser view and acts back through the same data channel (`broadcast`/`sendTo`). Open protocol, open source, so any agent can be invited into any room. Live proof: the [kibitzer](https://github.com/kibitz-chat/whist/tree/main/tools/kibitzer) pulls up a chair at a game of Whist, reads a hand, and calls the plays as they happen. See **§6 headless mode** for the controller an agent drives.

## 1. The one-liner
```html
<script src="https://kibitz.chat/widget.js" data-room="my-room"></script>
```
The widget renders inside a shadow root, so the host page's styles can't break it and its styles can't leak out.

## 2. Mount it yourself
```html
<script src="https://kibitz.chat/widget.js"></script>
<script>Kibitz.mount({ room: 'my-room' })</script>
```

`Kibitz.mount(options)` returns a `MountedWidget` controller. Options:

- `room` (string, required) — the room id. It's **canonicalized** the same way everywhere — lowercased, runs of non-alphanumerics collapsed to `-`, capped at 40 chars — so `Team Standup` and `team-standup` resolve to the **same** room everywhere. That forgiveness is deliberate for human-typed names, but it means a room name is **not** a high-entropy secret: names that differ only in case/punctuation (or share the first 40 normalized chars) collide. For a **private** room, use the **auto-generated unguessable** name (the default kibitz.chat hands out) rather than a short word — the link is the only key, so it needs to be unguessable.
- `name` (string) — pre-fill the visitor's display name (they can still edit it).
- `startOpen` (boolean) — start expanded (a deliberate room visit) instead of the collapsed pill. Required if you drive the call via the returned controller (the data link connects on open).
- `preview` (boolean) — landing demo: render the real panel but never dial (local self-view only).
- `headless` (boolean) — render NO panel; you draw the call yourself from the controller. The engine still runs and remote audio plays via hidden sinks. Connects immediately.
- `identity` (string) — a stable per-user/seat/session id; makes reconnect dedupe and resume deterministic (otherwise a random per-tab token is used).
- `meta` (object) — initial opaque per-participant metadata (e.g. seat, userId) attached to you and carried in the roster; update later with `setMeta()`.
- `signalHost` (string) — force the signaling host, bypassing the `/api/signal` probe (useful for an embedder on a non-kibitz.chat origin, where the same-origin probe wouldn't reach the broker).
- `turnHost` (string) — point TURN + entitlement at an independent provider instead of this build's own `/api/turn` (lets a third party provide/charge for TURN while the client stays free).
- `licenseKey` (string) — a premium license key (an opaque bearer token) sent as `Authorization: Bearer` to `/api/turn`, so a gated endpoint grants TURN. Stored locally; the caller stays anonymous.
- `grant` (string) — a room-grant token (the "opener pays" capability) presented to `/api/turn` as `X-Kibitz-Grant`, so the room opener's license sponsors this peer's TURN. Usually carried in the invite link as `?grant=`.
- `verifyIdentity` (object, **opt-in**) — turn on **verified identity** (see §2a). Omit (default) and Kibitz stays fully account-free.
- `joinGate` (object) — a **who-can-join gate** decoded from the room link (set at room creation), independent of `verifyIdentity`. `{ mode: 'open' | 'names' | 'code' | 'email' | 'google' | 'invite', names?, pubKey?, manifest?, encManifest?, clientId?, hostPubKey?, hostKeySealed?, hostName?, hostEmail?, lobbyOnStart? }` — the last five carry the optional **room host (admin)**, valid in any mode (see §2b). See §2b.
- `joinCredential` (string) — this peer's own signed invite token, for an `invite`-mode gate.
- `apiBase` (string) — absolute base URL of the Kibitz email-code backend (issuer + `/api/email/jwks`), for the `email` verify method. An embedder on a different origin sets this to `https://kibitz.chat` (where the backend lives).
- `relayOnly` (boolean) — **hide your IP**: force media + data through the TURN relay (`iceTransportPolicy:'relay'`), so other participants see only the relay's IP, not yours. **Fail-closed** — with no reachable TURN the call won't connect (it never silently falls back to a direct, IP-revealing path). You trust the relay with your IP; it still can't decrypt your media/data (DTLS). Surfaced in the UI as "🛡️ Hide my IP".
- `agentCredits` (object, **opt-in**) — require **declared agents** to hold a valid network-access credit credential (verified against the issuer's JWKS, peer-to-peer). Default off/dormant — humans unaffected. See `AgentCreditConfig`.
- `agentCall` (`'audio' | 'audiovideo'`) — mark this as an AI-assisted call and say what the agent perceives (`'audio'` = hears audio + chat; `'audiovideo'` = also sees video / shared screen). Kibitz shows its own standard pre-join consent warning, worded to the scope (what's said/sent — and, for `'audiovideo'`, your video — may be recorded and passed to third-party services; joining = consent).
- `notice` (string) — an optional **specific** disclosure shown on the pre-join screen below Kibitz's generic warning (e.g. which agent / which third parties). Host-supplied text, rendered verbatim; joining = agreeing to it.
- `roomDesc` (string) — a friendly room description shown as the pre-join title instead of the raw room code.
- `inviteLink` (function) — supply the URL the "Copy invite link" button copies (e.g. a WhatsApp-friendly `/j/room` link, optionally with a freshly-minted TURN grant). Returns a string or a promise. Omit → copies the current page URL.
- `mutePlayback` (boolean) — a **deaf** spectator: still receive everyone's streams (the controller exposes them) but don't play their audio through the speakers. For a second engine in the same page (e.g. an in-page AI kibitzer) that would otherwise echo the local mic.
- `fill` (boolean) — dedicated room-window mode (the kibitz.chat room page, not a third-party embed): the widget **fills the window**, is opaque (no see-through "ghost"), and on desktop resizes by dragging its edges. Embedders omit it and keep the floating, ghostable panel.
- `onExit` (function) — `fill` mode only: called when the user leaves via the header's ← Home button (kibitz.chat wires it to navigate back to the landing — the way out of a full-window room in an installed PWA).

## 2a. Verified identity (opt-in, peer-to-peer)
By default Kibitz is account-free: names are self-asserted. Pass `verifyIdentity` to let participants **prove** who they are with an OIDC provider — verified **directly between browsers, with no server vouching**:

```js
Kibitz.mount({ room: 'standup', verifyIdentity: { provider: 'google', clientId: 'XXXX.apps.googleusercontent.com' } })
```

A "Continue with Google" button appears in the lobby. A signed-in peer gets a **✓ verified as &lt;email&gt;** badge that other peers compute themselves — they check Google's signature against Google's public keys (JWKS) **and** that the token is cryptographically bound to the very DTLS certificate they handshook with. So the badge can't be spoofed and can't be replayed over someone else's connection. It composes with the 🛡️ safety code into one guarantee: *this is really them, on a private line.*

Options: `provider` is `'google' | 'microsoft' | 'oidc'` (the same cert-bound peer-to-peer check for all three — they differ only in how the id_token is fetched in the browser), `clientId` (your OAuth client_id — for Google, register a "Web application" client in Google Cloud Console and add your origin to the Authorized JavaScript origins). `microsoft` (Entra/Azure AD) and `oidc` (any standards issuer — Okta, Auth0, …) additionally need `issuer` + `discoveryIssuer` to verify the token (helpers `microsoftIssuer(tenant)` / `microsoftDiscovery(tenant)`); `oidc` also takes `authorizeEndpoint`. The verifier defaults cover Google only.

**Verified-only rooms.** Add `require: true` to make a room **verified-only**. This is an **authority-level door**, not just a UI nudge: the room authority verifies a joiner's cert-bound token **over the presence connection before admitting them to the roster**, so an unverified or off-domain peer is **never added** — it can't flash on screen and no one's data/media mesh ever dials it. The flow is an automatic, identity-driven lobby: a joiner is held (`waiting`) until they sign in; a token that fails signature / cert-binding / domain checks is told `unverified` and refused. Add `allowedDomains: ['acme.com']` to restrict to specific email domains (matches the address or the Google Workspace `hd` claim), and/or `allowedEmails: ['alice@acme.com', 'bob@example.com']` for an **exact per-person guest list** — only those verified addresses get in. The two lists combine as a union (allow anyone in either); both empty → any verified identity. The host can also flip "🪪 Verified people only" live from the panel; it survives **host migration** (a new authority re-verifies new joiners, while members it inherited mid-call are trusted). The old in-lobby Join-block + auto-remove stays as a backstop (e.g. for a token that expires mid-call). **Fail-closed:** if the authority can't reach the provider's keys (an offline LAN call) it can't verify, so it **denies** — `require` rooms are online-only by design.

**Honest limits:** it's **opt-in and off by default** (turning it on means collecting real identities — mind your privacy policy); it needs the **internet** (the provider's keys can't be fetched on an offline LAN call, so no badge there); it's **point-in-time** (proves "Google authenticated them ≤1h ago," not live employment); and it repurposes the OIDC `nonce` to bind to the WebRTC cert — a composition Kibitz builds, not a turnkey standard. A misbehaving peer can still type any display name; the badge is the only trustworthy identity signal.

## 2b. The join gate — who can enter (set at room creation)
Admission is decided **when you create the room**, not toggled mid-call, and the rule rides the link (the secrets stay in the creator's browser; the link carries only the mode). The "Set up your room → Who can join?" flow builds a link whose `joinGate` is one of:

- **`open`** — anyone with the link (the default).
- **`google`** — a verified Google identity, optionally restricted to a domain / email list (this is the §2a `verifyIdentity.require` path).
- **`email`** — a code mailed to each listed address. Kibitz acts as its own OIDC issuer: a small backend mails a one-time code, mints a **cert-bound RS256 token** on entry, and peers verify it against the backend's JWKS — same peer-to-peer check as Google, no third-party IdP. Needs `apiBase` (the backend origin). The host signs in via `signInIdentity(container, 'email')`.
- **`names`** — a fixed guest list; each joiner picks **which listed name they are** (a lightweight, non-cryptographic gate).
- **`invite`** — per-person **signed invite tokens** (ECDSA); each guest's link carries its own `joinCredential`. Revoking = revoking that invite.
- **`code`** — a shared/per-person code (a high-entropy commitment under the strict "link is everything" rule; short say-aloud codes use the rate-limited creator-held variant).

The gate is verified by the **room authority before rostering** (and, for the cert-bound `google`/`email`/`invite` paths, re-checked peer-to-peer so even a malicious authority can't admit an off-roster peer). See the [verification deep-dive](https://kibitz.chat/docs/verification) for the full threat model.

### Room host (admin) — who can moderate
Moderation (the waiting room, lock, kick, reset) is **decoupled from the coordinator**. The *coordinator* is migratory plumbing — it holds the roster and relays signaling, but has **no discretionary powers**; the *host* is a **verified** participant who can moderate. So a stranger who happens to become coordinator can't seize control, and bans survive coordinator migration. **A room with no host committed has no admin at all** (open room → the moderation UI is hidden and host actions are inert). The host is chosen at room creation ("Room admin (host)" chooser) in four tiers, committed in the link (fragment) as gate params:

- **None (open)** — no host, no admin (the default).
- **Host by name** (`ghn`, optional `gl=1` to start with the waiting room on) — whoever joins under that display name is treated as host. No crypto → spoofable by any link-holder; moderation is coordinator-scoped. Good for "I'm first in, let the agent in, then admit everyone."
- **Host by Google** (`gho` = verified email, with `gc` = the OAuth client id) — the host signs in (OIDC) to prove the email; every peer verifies it cert-bound peer-to-peer, so the authority marks them host. Un-spoofable and portable (sign in on any device); the room stays open — only admin is gated.
- **Host password** (`gh` = ECDSA P-256 public key, `ghk` = the private key **sealed under a host password**) — claiming admin means entering the password to unseal the key and sign cert-bound `mod` commands the coordinator verifies. Un-spoofable and works from any seat / survives migration (each command is individually signed). Honest limit: the sealed key rides the public link, so a weak password is offline-brute-forceable — the create UI nudges a strong passphrase. A committed host key disables the name + email tiers (the strong tier wins).

See the [verification deep-dive](https://kibitz.chat/docs/verification) for the host-command signing and enforcement detail.

## 2c. Shareable links (`#room` vs `/j/room`)
The **default** invite is a fragment link — `kibitz.chat/#room` — and the room code rides the `#fragment`, which **never reaches the server** (private by design). The downside: a fragment link can't carry a link preview, so chat apps like WhatsApp collapse it into a logo-only card and **hide the raw URL**.

For sharing, there's an **opt-in** path form — `kibitz.chat/j/room` — served by a Cloudflare Pages Function (`functions/j/[roomId].ts`) that answers differently per requester:
- **Humans** (and an AI agent that genuinely joins by driving a real browser → normal browser user-agent) → **302** redirect to the fragment route `/#room`, joining the room exactly as the default link does. Any query string (e.g. a `?k=` TURN grant) is forwarded.
- **Link-preview crawlers** (WhatsApp, `facebookexternalhit`, Slack, Telegram, …) **and AI content scrapers** (GPTBot, ClaudeBot, PerplexityBot, …) → **204 No Content** — nothing to render or scrape, so the chat app leaves the **raw URL visible as plain text**.

**Trade-off:** unlike the fragment default, the path form sends the room code to the server / logs / CDN on that one share hop (the live session still rides the fragment). So it's opt-in: supply it via the `inviteLink` option (above) for the "Copy invite link" button. Self-hosters get the same Function as part of the deploy.

## 3. Shared state (co-browse / follow-me)
The controller exposes an opaque app-message channel that rides the call's data channel — the seam for shared state like co-browse ("everyone follows when one person changes page"):
- `broadcast(data)` — send a structured-clone-able message to everyone ELSE on the call (never echoed to you). A no-op until the data link is connected.
- `sendTo(participantId, data)` — deliver a message to ONE participant by id (e.g. a game's per-player hidden state). Sent **directly peer-to-peer** to that participant over a DTLS-encrypted data connection — no other participant (not even the room host) relays or sees it.
- `onMessage(cb)` — subscribe to messages others send; the callback also receives the sender's id: `onMessage((data, from) => …)`. Additive (each call adds a listener) and returns an unsubscribe function. Kibitz never inspects `data`.

`data` is opaque and structured-clone-able — its shape is entirely yours. As a DoS backstop the engine drops an app payload larger than **256 KB** (serialized) on receive (and won't send one), so a peer can't flood you with a huge message; **rate-limiting, schema validation, and backpressure are your app's responsibility** (Kibitz is the transport, not a message broker).

## 4. Single-page vs multi-page sites
On a multi-page site, mount on each page with the same `room`; use a stable `identity` so a navigation reconnects as the same person rather than appearing as a new participant.

## 5. Versioning, pinning & integrity (SRI)
Kibitz is **pre-1.0**: the embed/headless API is stable in practice (it runs kibitz.chat and whist.kibitz.chat) but may change before 1.0 — track the [CHANGELOG](https://github.com/kibitz-chat/kibitz/blob/main/CHANGELOG.md). The full compatibility policy is [COMPATIBILITY.md](https://github.com/kibitz-chat/kibitz/blob/main/COMPATIBILITY.md).

There are two URLs, for two different needs:

- **`https://kibitz.chat/widget.js` — the rolling latest.** Always the newest build (so security fixes reach you immediately). It changes on every deploy, so you **can't** put a fixed [Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity) hash on it. Best for a casual drop-in.
- **`https://kibitz.chat/v<version>/widget.js` — frozen & pinnable.** Each release is also published at an **immutable** versioned path that never changes, so you can pin it with an `integrity=` hash and get exactly the build you tested:
  ```html
  <script src="https://kibitz.chat/v0.1.0/widget.js"
          integrity="sha384-Rc+YDfE0MV7LhtpKYz3fUCKFepIqnVPCyRJw7mJwmPw2+ZsjDPLZ9gFbYt1LMuqo"
          crossorigin="anonymous"
          data-room="my-room"></script>
  ```
  (Verify any pinned build's hash yourself: `curl -s https://kibitz.chat/v0.1.0/widget.js | openssl dgst -sha384 -binary | openssl base64 -A`.) A pinned version is frozen, so it won't receive fixes — track the [CHANGELOG](https://github.com/kibitz-chat/kibitz/blob/main/CHANGELOG.md) and bump deliberately.

The build is also redistributable (Apache-2.0), so you can **self-host** a copy and point `/api/signal` + `/api/turn` at your own infrastructure (see §7) — nothing about running your own copy depends on kibitz.chat.

## 6. Headless / composable mode (build your own UI)
With `headless: true`, the engine runs but draws no panel — you render tiles from the controller (attach each participant's `stream` to a muted `<video>`; Kibitz plays the audio, so camera-off peers are still heard). The full `MountedWidget` controller:

- `getState()` → `{ inCall, micOn, camOn, sharing, self, isHost, lobbyOn, locked, lobbyStatus }`, plus the verified-identity/roster fields when `verifyIdentity` is set: `identityEnabled`, `selfEmail`, `rosterActive`, `rosterCanShare`, `rosterCompromised`.
- `getParticipants()` → everyone on the call; each `{ id, isSelf, name, avatar, camOn, speaking, stream, meta, mirror?, sharing?, role }` (`role` is `'host'` for the room authority, else `'guest'`).
- `join({ mic?, cam? })` (promise) · `leave()`.
- `toggleMic()` · `toggleCam()` (camera returns a promise).
- `shareScreen()` (browser picker) · `shareTrack(track)` (publish an arbitrary `MediaStreamTrack`, e.g. a tab capture) · `stopShare()`.
- `publishAudioTrack(track | null)` — publish a custom outgoing audio track (a synthesized song, TTS speech…); `null` restores silence. Lets a headless agent **speak** into the call, not just listen.
- **Built-in room chat** (the chat humans see, distinct from the opaque app channel in §3): `sendChat(text, to?)` posts a line to the room chat — with `to` (a participant id) it's a private message to just that peer — and `getChat()` returns the ephemeral scrollback (capped buffer, newest last). Honest peers drop chat from a read-only agent (`meta.role==='agent'`) unless the host grants `send-chat`.
- **Schema discovery** (so an agent can read your `broadcast`/`sendTo` shape without out-of-band docs): `registerSchema(name, version, schema)` publishes a schema (re-broadcast to late joiners, so discovery is order-independent), `getSchemas()` returns every schema known (yours + each peer's, attributed by publisher), `onSchema(cb)` subscribes as peers publish. Publishing is gated like any emission — a read-only agent consumes but doesn't publish.
- **Agent admission** (mount *as* an agent): `provideAgentKey(privateKeyJwk)` adopts the agent's own signing key so it presents a cert-bound key assertion the authority checks against the room's allow-list (an agent enters by its own key, no human); `provideAgentCredit(credential)` forwards a short-lived network-access credit credential a credit-gated authority verifies (call ~every minute with a freshly-renewed one).
- `setName(n)` · `setAvatar(a)` · `setMeta(m)` — update your roster fields; changes propagate to everyone.
- Lobby + moderation (host only): `getKnocks()` → `{ id, name, avatar }[]` · `setLobby(on)` (require approval to join) · `admit(id)` · `deny(id)` · `remove(id)` (remove a member + block their identity from rejoining) · `setLocked(on)` (seal the room to new members; existing ones may still reconnect) · `resetRoom()` (clear everyone's chat) · `knock(name, avatar)` (introduce yourself to a gated room before joining).
- Verified identity (host/self; inert unless `verifyIdentity` is set): `signInIdentity(container, 'google' | 'email')` (renders the provider's sign-in into your element; on success the cert-bound token is broadcast), `identityNonce()` (the cert-bound nonce an out-of-page sign-in surface must echo), `provideIdentityToken(jwt)` (adopt a token minted out-of-page — e.g. a sign-in popup on another origin).
- Participant capabilities (host consent; see §6b): `getCapabilityGrant(id)` → a participant's effective `Grant`, `setCapabilityGrant(id, grant | null)` (widen/revoke; `null` clears the override), `getAgentAudit(id)` → recent local audit events (blocked acts + grant changes).
- `on(event, cb)` → returns an unsubscribe function. Events: `participants`, `join`, `leave`, `speaking`, `state` (`inCall`/`micOn`/`camOn`/`sharing`/`isHost`/`lobbyOn`/`locked`/`lobbyStatus` + the identity/roster fields above), `knocks` (the host's waiting list changed), `lobby` (your own `waiting`/`denied`/`locked`/admitted status), `chat` (a new built-in-chat line arrived from another participant — pair with `getChat()`).

This headless surface is what lets an AI agent act in a human's place over the data channel, or a host site render a fully custom call experience.

## 6b. Participant capabilities (humans & agents)
Every participant carries a **`Grant`** of what it may **perceive** (content that flows to it) and **act** (what it emits): `{ perceive: ('see-screen'|'hear-audio'|'read-chat'|'read-roster'|'receive-directed')[], act: ('send-chat'|'speak'|'act')[], backend?, egress?, expiresAt? }`. **Humans default to full; agents (`meta.role==='agent'`) default to read-only** — they perceive chat/roster/directed data, but receive **no media** and can **act nothing**.

The **engine enforces** it per-peer (there's no server to police it): perceive = the sender withholds — data is never delivered to a peer that can't see it, and a withheld screen-share/audio lane is swapped for a placeholder on that peer's connection (and **fails closed** — the lane is sent *nothing* if a placeholder can't be made, never the real media); act = every honest peer drops content from a peer whose grant lacks `send-chat`. The host can widen or revoke any grant live (`setCapabilityGrant`) — surfaced in a per-agent **consent panel** with a local-only **audit feed** — and the room authority distributes the grant map so the policy holds uniformly across everyone. An agent can disclose its model `backend`/`egress` ("what it sees leaves the room") for the host to consent with eyes open. Full model: the [agent platform deep-dive](https://kibitz.chat/docs/agent-platform).

## 6a. Testing your app (no network)
Content (chat / `broadcast` / `sendTo`) is peer-to-peer over the media data channel, so test your message handlers as plain functions. For the **presence** engine — roster, the knock-to-admit lobby, lock — Kibitz ships an in-memory transport so you can drive the real engine with no broker or media:

```js
import { joinRoom } from 'kibitz/core/room'
import { createLocalBus } from 'kibitz/core/localBus'

const bus = createLocalBus()
const host = joinRoom('demo', { transport: bus })   // first joiner = authority
const guest = joinRoom('demo', { transport: bus })  // connects as a participant
// drive host/guest's link.setSelf(...) and assert the roster each sees (and that a
// locked room turns a third joiner away) — deterministic, synchronous.
```

## 7. TURN, relays & who pays
- The build mints short-lived TURN credentials at `/api/turn`. The free tier is STUN / open relay; a relay is only used when a direct peer connection is impossible.
- `turnHost` points TURN and the entitlement check at an independent provider, so a third party (or a separate billing entity) can provide and charge for TURN while this client stays free and pseudonymous.
- "Opener pays" — a signed, short-lived, room-scoped grant baked into the invite link (`?grant=`) lets a licensed room opener sponsor TURN for whoever joins, without an open relay and without the opener's key leaving their browser.
- A premium license key (an opaque bearer token) travels with the user (stored locally) and unlocks premium TURN via `Authorization: Bearer` to `/api/turn` — monetization without accounts.

## 8. Offline / same-Wi-Fi rooms (no internet)
The same embedded engine runs a room over a local network with **no internet at all** — a plane, a cabin, an event with dead cell, an air-gapped office. One device on the Wi-Fi runs a tiny open-source **LAN hub**; everyone opens the link once and the call rides that LAN instead of the internet broker, so **a site that embeds Kibitz keeps working offline** (same `widget.js`, same rooms, no accounts, no cloud). The LAN hub is selected by a `?galaxy=…` link it hands out; the widget adopts and persists it (`?galaxy=off` clears it). For an embedded site, both your page and `widget.js` must be reachable on the LAN — serve them from the LAN-hub device, or rely on PWA caching (open the site once on real internet first). Not to be confused with the TURN relay above: TURN relays an *internet* call when NAT blocks a direct path; the LAN hub replaces the internet entirely. Setup + downloads: the [Offline mode](https://kibitz.chat/relay) page (beta).

## 9. Recipes
Concrete ways people use Kibitz:
- **Pair programming / studying together:** drop the one-tag snippet on your editor or notes page, and share your screen to look at docs side by side. Use **push-to-talk** (hold Space) so typing stays quiet.
- **Embed on your SaaS app:** `Kibitz.mount({ room, identity: userId, meta: { seat } })` so reconnects dedupe and your app can map a participant to its own user via `meta`. Turn on the **lobby** if the room link is shared widely, or **lock** it once your team is in.
- **Build a multiplayer app with hidden state:** drive the headless controller; `broadcast(data)` for shared state, `sendTo(participantId, data)` for one player's private view (e.g. a hand of cards — delivered peer-to-peer to just that player). Whist is a full worked example.
- **Talk with an AI agent in the room:** an agent joins headless as a participant, watches the roster/stream/chat, and speaks or types back over the same channels — the same surface a human uses.
- **Run a session offline (event, classroom, plane):** one device runs the LAN hub; everyone scans a QR once and calls over Wi-Fi with no internet (see the [Offline mode](https://kibitz.chat/relay) page).
