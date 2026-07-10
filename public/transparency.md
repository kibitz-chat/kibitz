# Kibitz — Transparency: what's open, what's private, what to trust

> Source: https://kibitz.chat/transparency

Kibitz is a privacy tool, so being precise about what is open, what isn't, and exactly who can see what is itself part of the product. This page lays that out, with a threat model and a public roadmap. For the cryptographic detail of how a call connects, see the [Security page](https://kibitz.chat/security).

## What's open source
The pieces you actually run are public, published under the `kibitz-chat` GitHub organization:

- **The app — full source, [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0).** The complete source of kibitz.chat (engine, widget, headless API), not just a binary — read it, audit the encryption, build it, fork it, host it anywhere (any static host, or content-addressed on IPFS) so a copy can outlive this site: `github.com/kibitz-chat/kibitz`.
- **The offline-mode LAN hub** — the box you run for calls with no internet: `github.com/kibitz-chat/kibitz-offline`.
- **A reference app** — Whist, a full multiplayer game built entirely on Kibitz's headless engine, as a worked example: `github.com/kibitz-chat/whist`.

## Open source vs build artifact vs private
- **Open & auditable:** the **full source** of the app (Apache-2.0) and the LAN hub. Anyone can read, verify, build, fork, and host them — including in closed or commercial products — with no copyleft obligation; nothing about running your own copy depends on us. The license includes an explicit patent grant.
- **Documented, so you can reimplement:** the **protocol** (below) and the embed/SDK API ([docs](https://kibitz.chat/docs)). You don't have to trust a binary — the wire format is described.
- **Not published:** the operator's **deployment configuration** — the specific domains, signaling-worker handle, and TURN credentials behind kibitz.chat. These are operational secrets, not part of what you run; the build points at its own `/api/*` and you can point a copy at your own.

## The protocol, in one screen
- A **room is a link.** The room name maps to a *deterministic* peer id; the first browser to claim it is the **authority**.
- **Content (peer-to-peer):** chat, "pay me" links, shared annotations, and opaque app messages (co-browse, game state) travel **directly between browsers** over DTLS-encrypted data connections — one per pair of participants, alongside the media. **No participant relays anyone else's content;** a directed `sendTo` reaches only its recipient. The emoji safety code verifies the media connection specifically; per-data-channel verification is a planned follow-up.
- **Presence (coordinated by the first participant):** the roster (who's in the call), the knock-to-admit lobby, lock, and reset are coordinated by whoever claimed the room — but that's membership signalling, not message content. Content gating follows the roster: a peer the host hasn't admitted never appears in it, so no one's data mesh connects to it and it never learns anyone's address.
- **Media (mesh, end-to-end encrypted):** audio and video flow **directly between browsers** over WebRTC (DTLS-SRTP). No server decodes, mixes, or records them. This is the part you can verify yourself with the **safety code**.
- **Signaling** only introduces browsers and carries certificate fingerprints; a **TURN relay** (used only when a direct link is impossible) forwards ciphertext it can't read.

## Threat model — who can see what
- **Other participants:** by default the media (it's their call too), the data channel (chat/links/app), and — because WebRTC connects browsers directly — **each other's IP addresses**. Vet who has the link; use the knock-to-admit **lobby** or **lock** the room to control entry. To hide your address, turn on the **relay-only ("hide my IP")** toggle, which routes your media + data through the TURN relay so others see only the relay's IP (fail-closed — the call won't fall back to a direct, IP-revealing path). The **capability layer** narrows the rest per peer: a participant the host scopes down — and an AI agent by default — receives only the data it's granted and **no media** (e.g. a read-only agent gets chat but no audio or screen share), enforced sender-side in the mesh.
- **The room authority (the first participant's browser):** coordinates presence (the roster, lobby, lock) — so it knows *who* is in the room, but it does **not** relay or see chat / links / co-browse, which go peer-to-peer. For media and content it's just a normal peer.
- **The signaling broker:** connection metadata (a temporary peer id, the room name, IP-bearing ICE candidates) — never call content, and it stores none of it. Because key fingerprints are exchanged here, a *compromised* broker is the one party that could attempt to slip into the middle of a **future** call — which is exactly what the safety code is designed to catch. It cannot touch a call already in progress.
- **The TURN relay:** ciphertext, IP addresses, and traffic volume only. It cannot decrypt the media. Most calls never use it.
- **The operator (us):** can be compelled to take the website down, but **not** to silently reach into calls — per-call keys are ephemeral and held only by the two browsers; there's nothing to hand over and no kill-switch.
- **Nothing is stored:** rooms vanish when everyone leaves; chat lives only in the open panels. There is no database to subpoena.

## Reproduce / run your own
The build is redistributable and the protocol is documented, so you don't have to depend on kibitz.chat. Host the build yourself, or point a copy at your own signaling worker and TURN. App developers can test the real engine's presence offline with an in-memory transport — `joinRoom(room, { transport: createLocalBus() })` (see the [docs](https://kibitz.chat/docs)).

## Public roadmap
Shipped: embeddable widget + headless engine, E2EE media, **peer-to-peer data channel** (chat / co-browse / `sendTo` go directly between browsers — no participant relays content), the safety code (per-peer SAS), knock-to-admit lobby, screen-share stage with **pinch-to-zoom/pan** + shared annotation, **pop-out (Picture-in-Picture)** call window, transport-only payment links, a **room host (admin) decoupled from the coordinator** (a *verified* host — not whoever currently coordinates presence — holds moderation, so a coordinator can't seize control and bans survive migration; chosen at creation as none / by-name / by-Google / password-key and committed in the link, with no host → no admin), room moderation (remove + block-rejoin, lock, reset), role labels, a speaker/"deaf" master mute, keyboard shortcuts + push-to-talk, connection diagnostics (direct/relay + RTT/loss), a **relay-only "hide my IP" toggle** (force media + data through TURN so other participants see only the relay's IP, not yours — fail-closed), an in-memory presence test transport, **opt-in verified identity** (cert-bound OIDC — Google, Microsoft, or any standards OIDC issuer — verified peer-to-peer) with **verified-only / gated rooms** (an authority-level door — name list, join code, signed invites, email-mailed code, or an OIDC provider — set at room creation), and a **participant-capability layer** (per-peer perceive/act grants — humans full, AI agents read-only by default — engine-enforced incl. per-peer media gating, with host consent + a local audit feed).

Planned / under consideration: per-data-channel safety-code verification; expiring and one-time invite links; captions/transcripts (local); broader browser coverage (Firefox sidebar, Safari fallback) and a compatibility matrix; an npm package with generated API docs; and app templates beyond Whist. Priorities shift with feedback — tell us what you need.

## Reporting a security issue
Report vulnerabilities privately to security@kibitz.chat rather than disclosing publicly, and allow a reasonable chance to fix.
