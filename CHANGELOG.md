# Changelog

All notable changes to Kibitz are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

Kibitz is **pre-1.0** — the embed/headless API is stable in practice (kibitz.chat and
whist.kibitz.chat run on it) but may still change before 1.0. See the "Versioning, pinning &
integrity" section of [the docs](https://kibitz.chat/docs) for how to pin a build.

## [Unreleased]

### Security
- **Passphrase seal hardened to 600k PBKDF2 iterations (from 210k).** The out-of-band seal that
  protects a verified-room manifest **and** the host private key — both of which ride the public
  link — now derives at the OWASP floor for PBKDF2-HMAC-SHA256 (the old 210k was the figure for
  HMAC-SHA512). Done via a blob **version bump** (`v2`): decrypt dispatches the work factor on the
  embedded version byte, so **already-minted `v1` links keep opening** (at 210k) and only *new*
  seals use the stronger factor. The version byte remains the hook for a future Argon2id upgrade.
- **Safety-code fingerprint requires exactly one remote DTLS cert.** The fingerprint underpinning
  cert-binding and the spoken safety code now fails closed (shows "no code") if a peer presents a
  cert list of any length other than 1, rather than hashing a possibly-non-leaf, peer-ordered cert.
- **Distributed capability grants are honored only from a cryptographic host.** A `caps` map (which
  rewrites every peer's capabilities) is now accepted only when a committed host **key** or **OIDC
  email** governs the room; a soft-name / open room — where the host id is spoofable — enforces
  grants host-locally instead, so a link-holder can't rewrite others' capabilities by claiming a name.
- **Signed moderation commands fail closed on any unreadable connection cert** (previously only a
  strict `null`), and carry a **`jti`** the verifier LRU-dedups to block same-connection replay
  within the freshness window. `jti` is additive (old clients omit it; new ones are replay-guarded).
- **Per-lane media fail-closed warning** — the operator warning that media is being withheld for a
  missing placeholder is no longer silenced for one lane by another lane fail-closing first.

### Host / admin
- **Room host (admin), decoupled from the coordinator.** Discretionary moderation (the waiting
  room, lock, kick, reset) now belongs to a *verified host* rather than to whichever browser
  happens to coordinate presence — so a stranger who becomes coordinator can't seize control, and
  bans survive coordinator migration. A room with **no host committed has no admin at all** (the
  moderation UI is hidden, host actions are inert). The host is chosen at room creation in four
  tiers, committed in the link: **None (open)** · **Host by name** (`ghn`, soft/spoofable — "I'm
  first in, let the agent in, then admit everyone", optionally starting with the waiting room on,
  `gl`) · **Host by Google** (`gho` verified email, un-spoofable + portable) · **Host password**
  (`gh`/`ghk` — an ECDSA key sealed under a host password; admin via cert-bound signed `mod`
  commands the coordinator verifies, works from any seat and survives migration). A committed host
  key disables the weaker tiers. The full detail is in [docs/verification.md](docs/verification.md).

### Identity
- **More sign-in providers — Microsoft, and any OIDC issuer.** Verified rooms previously signed in
  only with Google; now `verifyIdentity.provider` accepts `'microsoft'` (Entra/Azure AD) and
  `'oidc'` (a generic, config-driven flow for Okta, Auth0, Entra, or any standards OIDC issuer).
  All go through the **same cert-bound peer-to-peer verification** as Google — they differ only in
  how the id_token is obtained (a popup, OIDC implicit `id_token` + the cert-binding nonce + an
  anti-CSRF `state`; no backend, no access token, no secret). GitHub/Facebook are intentionally out
  (OAuth without an OIDC id_token — they'd need a backend). Microsoft needs the tenant's `issuer` +
  `discoveryIssuer` (helpers `microsoftIssuer`/`microsoftDiscovery`) and a registered Entra app.

### Privacy
- **Relay-only mode (hide your IP from other people).** A new per-participant toggle ("🛡️ Hide my
  IP from other people" on the room page, or the `relayOnly` mount option) forces your media + data
  through the TURN relay (`iceTransportPolicy:'relay'`), so other participants see only the relay's
  IP, not yours — closing WebRTC's inherent peer-IP exposure in direct mode. Applies to BOTH the
  media and presence connections. Fail-closed: with no reachable TURN the call won't connect rather
  than silently fall back to a direct, IP-revealing path. Honest limit: the relay (and the host)
  still see your IP — but can't read your media/data (still E2EE); it can add a little latency.
- **Verified-room links keep the roster off the host.** The gate descriptor (mode, signed roster
  manifest, client id, per-guest token) and the room description now ride the URL **fragment**
  (`…/#room?g=…`) instead of the query string — and a browser never sends the fragment over the
  network, so invitee emails in a verified-room link no longer reach the web host / CDN / logs.
  Additive: legacy query-form links still resolve (`gateParamsFrom` reads both). One downgrade to
  note — an *old* build reads only the query, so it sees a new fragment-form link as an open room;
  enforcing needs both peers on a fragment-reading build (kibitz.chat self-updates within minutes).
- **Passphrase-locked verified rooms.** A verified room can be sealed with an out-of-band group
  secret: the signed roster is **encrypted** (PBKDF2 + AES-256-GCM) and the link carries only
  ciphertext (`ge`), so neither the host **nor anyone who merely has the link** can read who's
  invited. A member enters the passphrase once to unlock; the decrypted roster is still verified
  (signature + room-binding + expiry) and identity still checked, exactly as before. Set it in
  "Set up your room" → *Lock the roster with a shared secret*; share the secret through another
  channel. Strength tracks the passphrase's — a weak secret is brute-forceable, so pick a strong one.
- Foundation for hashed rosters: `rosterHash` (salted, room-bound member hashing) + a hashed `mh`
  allow-list the manifest can carry (kept as inert defense-in-depth; encryption supersedes it).

### Compatibility & agents (all additive — old peers ignore what they don't know)
- **Feature negotiation**: every peer advertises its `engine` SemVer + a `features` tag list
  (e.g. `caps.v1`, `schema.v1`) on the roster, under a reserved `~kbz` meta key, surfaced as
  `participant.engine` / `participant.features`. A newer build can see what an older one supports
  and down-level instead of guessing. See [COMPATIBILITY.md](COMPATIBILITY.md).
- **Schema discovery**: an app can publish a schema of its `app`/`view` shape
  (`registerSchema(name, version, schema)`, a new `schema` wire kind), re-broadcast to late
  joiners so discovery is order-independent. Agents read it via `getSchemas()` / `onSchema()`
  to interpret an app without out-of-band docs. Publishing is gated like any emission, so a
  read-only agent consumes but doesn't publish.
- **Versioned hosting + min-version kill-switch**: each release is frozen at
  `/v<version>/widget.js` (SRI-pinnable), and every build checks a deployment-controlled
  `/min-version.json` floor at boot and retires itself (fail-open) if it's below it.
- **Conformance fixtures** (`src/core/conformance.test.ts`) freeze the cross-version ABIs
  (wire kinds, `kbz-v1-` room ids, gate-link params, the cert-binding nonce).
- **Declared-agent credit gate (dormant).** A room can require declared agents (`meta.role==='agent'`)
  to hold a short-lived **network-access credit credential**, verified peer-to-peer in the authority's
  browser against the issuer's published JWKS (no shared secret, no callback). **Default OFF** —
  absent ⇒ fully dormant, humans never affected; self-hosters simply don't pass it. Driven via the
  `agentCredits` mount option + the controller's `provideAgentCredit(credential)` (renewed ~per minute).

### Call experience
- **Zoom-style pre-join screen.** A camera/mic preview before you connect, with mic / camera / speaker
  device pickers, a flip-camera control, and a two-part **consent** surface — Kibitz's own generic
  recording warning (worded to the `agentCall` scope) plus the host's specific `notice` — so joining
  is an informed action. The chosen camera side + speaker carry into the call.
- **Pinch-to-zoom + pan a shared screen** (1–4×, double-tap to toggle), with page-zoom locked while in
  a room; shared ink/laser rides the same transform so annotations stay pinned.
- **Pop-out (Picture-in-Picture) call window** that renders the full tab-view layout.
- **Help page** (`#help`) with a copyable LLM support prompt — browser landing only (dropped from the
  installed app).
- **WhatsApp-friendly share links (`/j/room`).** An opt-in path-form invite (a Cloudflare Pages
  Function) that keeps the **raw URL visible** in chat apps: humans (and AI agents driving a real
  browser) get a 302 to the normal `/#room` fragment route; link-preview crawlers and AI scrapers get
  a 204 with nothing to render, so WhatsApp/Slack/etc. don't collapse it into a logo-only card. Supply
  it via `inviteLink`. The fragment link stays the default — the `/j/` form is opt-in because the path
  sends the room code to the server on that one share hop (the live session still rides the fragment).

### Agent calls
- **One-tap agent summon.** A single tap on the summon pill invites the room's agent and opens its
  control panel; the pill shows a progressing **"Summoning…"** label while the agent connects, and a
  first-run nudge points new users at it.
- **Floating, draggable agent-control bubble.** Agent calls get a floating pill/panel (opt-in via
  `brand.agentBubble`) that drags fluidly anywhere over the call and stays above the speaker stage in
  every layout — replacing the legacy inline agent control.
- **Rate the agent from the panel.** The control panel carries a star rating that posts a `rate` frame
  tagged with your **presence-based rater id**, so feedback is attributable without an account.
- **Room-creator credit panel.** The room's creator gets a **live credit balance** with an in-panel
  top-up path.
- **Start-of-call "your mic is off" nudge.** Join an agent call muted and a persistent nudge floats
  above the tiles until you unmute (tap it to unmute) or dismiss it with ✕. **Agent calls only**, so a
  human-to-human call is never nagged.

### Widget UX (embedded corner panel + room window)
- **Resize from every edge and corner.** The embedded corner panel (desktop) can be stretched from all
  four corners *and* all four edges, like a real window — the opposite edge stays pinned. The box is now
  **clamped to the viewport** (it can no longer run off the right or bottom) and is otherwise **uncapped**
  (was limited to 900px wide / `vh−180` tall). The visible corner grip mark is gone — the diagonal/edge
  resize cursor is the cue.
- **Controls and avatars scale with the box.** The control-bar icons (top header *and* bottom bar) and the
  tile **avatar emoji/initial + name** now scale with the panel size via CSS container queries — bigger
  box → bigger controls and avatars — instead of staying a fixed size. The speaker-stage avatar scales
  with the stage tile (it was viewport-based, so it never tracked a box resize).
- **Device-consistent emoji avatars.** A picked emoji avatar renders as a **vendored Twemoji SVG**, so it
  looks identical on Apple/Google/Windows instead of using each device's emoji font — in the tiles AND the
  floating Video-PiP tile (drawn to its canvas, untainted so capture/PiP keeps working). Bundled (no
  runtime CDN) so it works offline; a name-initial stays plain text.
- **Strip view is the embedded widget's alternate layout** (a compact row of tiles), gated to the widget;
  the dedicated room window offers **Car** instead. The strip's control bar now sits **in-flow directly
  below the tile row** (not floating at the foot of an empty box), and the strip tiles scale with the box.
- **View switching, cleaned up.** The **view button is shown everywhere** (corner + big surfaces) whenever
  there are ≥2 views. **Page-dots are touch-only** now (a swipe-position cue — desktop relies on the
  button), and in **mobile landscape** they're pinned **bottom-centre** instead of drifting to the right.
- **Mic/camera/screen-share hiccups show a brief, neutral toast** that auto-dismisses, instead of a
  lingering red banner — the on/off button already conveys the state. The red banner is now reserved for
  fatal problems (couldn't connect, build retired).
- **Ghost mode is see-through where it wasn't.** Another person promoted to the **speaker stage** is now
  see-through (the stage's black backdrop no longer reads as an opaque block over the page), and **your
  own tile stays see-through while you talk** (the active-speaker opacity pop is for spotting who *else*
  is talking — a solo call no longer goes opaque mid-sentence).
- **Invite link matches the surface.** The embedded widget's "Copy invite link" now copies the **page it's
  embedded on** (so recipients get that page *with* the floating widget), while the dedicated room window
  keeps the `/j/<room>` link. The app's **"Open a room"** paste accepts all forms — `/j/<room>`, `#room`,
  a bare code, or an embed `?room=` link.
- **Invite panel at pre-join.** A share surface with **Copy**, **WhatsApp**, and native share plus an
  **opt-in** QR code; it auto-opens for the first person in (the agent's summoner) and closes on join.

## [0.1.0] — 2026-06-12

First tagged release. The engine, the embeddable widget, the headless/composable controller,
the browser extension, the offline LAN relay, and the agent SDK are all in use in production
(kibitz.chat, whist.kibitz.chat).

### Calls & engine
- Account-free, serverless **peer-to-peer** calls: media is a full WebRTC mesh (DTLS-SRTP),
  and **content (chat, co-browse, pay links, annotation) is peer-to-peer** over DTLS data
  channels — no participant (not even the room authority) relays content.
- **Embeddable** in one `<script>` tag, and a **headless/composable controller**
  (`Kibitz.mount({ headless })`) so a host app draws its own UI.
- Room = a link; first arrival becomes the authority; the role **migrates** if it leaves.
- Screen/tab share with a presenter **stage** + shared **laser-pointer/ink** annotation.
- Per-person **mute-for-me** + volume, role labels, keyboard shortcuts + push-to-talk,
  direct-vs-relay + RTT/loss diagnostics, auto-rejoin after reload, transport-only pay links.
- In-memory test transport (`createLocalBus`) drives the real presence engine with no network.

### Identity & admission (opt-in)
- **Safety code (SAS)** from the live DTLS cert fingerprints — detect a machine-in-the-middle.
- **Verified identity**: cert-bound OIDC (Google), verified **peer-to-peer** (no identity server).
- **Email-OTP** verify method: Kibitz acts as its own RS256 OIDC issuer (Worker + JWKS).
- **Verified / gated rooms** set at room creation — an authority-level door (name list, join
  code, signed invites, email code, or Google) that refuses unverified joiners before rostering.

### Agents & capabilities
- **Agent SDK** — an AI agent joins a room as a participant (perceive + act) over the data channel.
- **Participant-capability layer**: per-peer perceive/act grants (humans full, agents read-only by
  default), **engine-enforced** — data acts dropped receiver-side, media withheld sender-side
  (per-peer placeholder track-swap, **fail-closed**) — with host consent, revoke, a local audit
  feed, egress disclosure, and authority-distributed grants. A visible **🤖 AI badge** marks agents.

### Offline
- **Same-Wi-Fi / LAN rooms** with no internet via a tiny self-hosted relay (content stays P2P
  over the LAN; the relay coordinates presence/handshakes only).

### Licensing
- The full source is **[Apache-2.0](LICENSE)** — permissive, with an explicit patent grant.

[Unreleased]: https://github.com/kibitz-chat/kibitz/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kibitz-chat/kibitz/releases/tag/v0.1.0
