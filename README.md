# Kibitz

An **account-free, serverless, peer-to-peer** call + collaboration engine that hangs over
whatever you're doing — drop a floating, end-to-end-encrypted call onto any site with one
`<script>` tag, drive it **headless** to build your own UI, share your screen, or let an
**AI agent** join a room as a participant. Live at
[kibitz.chat](https://kibitz.chat).

> **kibitzer** *(n., from Yiddish)* — the person at the card table who isn't playing, just
> hanging over the game, watching and chatting. This engine grew out of a production in-game
> call system, where the kibitzers are real.

Media and data flow **browser-to-browser** (WebRTC, DTLS-SRTP / DTLS), end-to-end encrypted.
There is **no media server** and **no participant relays anyone else's content** — nothing to
pay for per-minute, nothing that *could* record you. The only infrastructure is stateless,
content-blind edge helpers: a self-hosted signaling broker and an optional TURN relay.

Every battle-tested rule below was paid for with a real multi-device bug hunt in a production
call system.

## Try it

```bash
npm install
npm run dev
```

Open the printed URL in two tabs (or two devices) — the room name lives in the link, so
sharing the link shares the room. Build the embeddable widget with `npm run build`
(`dist-widget/widget.js`).

## What it is

- **Embed:** `<script src="https://kibitz.chat/widget.js" data-room="my-room">` — a floating
  call in a shadow root, one line.
- **Headless / composable:** `Kibitz.mount({ room, headless: true })` returns a controller
  (`MountedWidget`); a host app draws its own surface from the rooms, media, and data. Powers
  [whist.kibitz.chat](https://whist.kibitz.chat) (a full card game on the headless engine).
- **Agents:** the [Agent SDK](docs/agent-platform.md) lets an AI join a room as a read-only
  (by default) participant over the same data channel humans use.

## Architecture

```
src/core/          framework-free engine
  protocol.ts      the entire wire protocol
  transport.ts     room presence star over PeerJS: claim-or-join, flap-proof reconnect
  room.ts          authority roster + migration + the admission/identity gate
  mesh.ts          the media + data mesh (glare-free, replaceTrack-only, per-peer media gate)
  callMedia.ts     media backends (online PeerJS / offline LAN / preview)
  capabilities.ts  the participant-capability model (perceive/act grants)
  identity*/oidc*  opt-in cert-bound OIDC verification (no identity server)
  rosterGate.ts    verified-roster mutual pre-share + the join gate
  lanRoom/galaxy*  the offline-mode LAN hub (same-Wi-Fi, no internet)
src/react/         useCall() — the engine hook (presence, mesh, content, enforcement)
src/widget/        the floating Widget (one consumer of the controller) + the mount API
src/agent/         the Agent SDK
functions/         Cloudflare Pages functions (/api/turn, /api/signal, /api/email/*)
docs/              the deep-dive docs (rendered to /docs on the site)
```

- **Room = claim-or-join.** A room lives at a deterministic peer id. The first arrival claims
  it and becomes the roster *authority*; everyone else connects to it. If the authority
  vanishes, the survivors race to reclaim the freed id (the broker arbitrates) and the roster
  self-heals (members re-announce whenever a roster arrives without them).
- **Content never depends on the authority.** Media *and* data are a full peer-to-peer mesh —
  the authority coordinates presence only; it never relays chat, co-browse, or media.
- **Three layers of control:** the [join gate](docs/verification.md) (who's admitted, set at
  room creation), opt-in [verified identity](docs/verification.md) (cert-bound OIDC, checked
  peer-to-peer), and the [capability layer](docs/architecture.md#6-participant-capabilities)
  (what each participant may perceive/act — humans full, agents read-only — engine-enforced).
- **Room host (admin), decoupled from the coordinator.** Moderation (waiting room, lock, kick,
  reset) belongs to a *verified host*, not to whichever browser currently coordinates presence —
  so a stranger who becomes coordinator can't seize control, and bans survive migration. Chosen at
  creation in four tiers (no admin / host by name / host by Google / host password) and committed
  in the link; an open room has no admin at all. See [verification](docs/verification.md).

## Battle-tested rules (do not "simplify" these away)

1. **Never re-dial on camera toggles.** Connection churn crashes iOS WebKit *natively* (the
   process dies — no JS error). Every call negotiates a two-way video lane up-front (a 2×2
   black placeholder track is sent while the camera is off) and toggles — including per-peer
   media-capability gating — are `RTCRtpSender.replaceTrack` swaps on live connections.
2. **Always offer both media sections** (`offerToReceiveAudio/Video`). A voice-only caller's
   offer otherwise has no video m-line, and a WebRTC answer can never add one — the answerer's
   camera would be silently dropped forever.
3. **Tiles gate video-vs-avatar on the roster `cam` flag**, not track presence — the video
   lane always exists; only the frames change.
4. **A withheld media lane gets a flowing placeholder, never `replaceTrack(null)`.** iOS treats
   a sample-less lane as dead and kills the whole connection.
5. **Stop keep-alives *before* `peer.destroy()`.** PeerJS emits `'disconnected'` before setting
   `destroyed`; an un-stopped keep-alive re-registers the id mid-teardown and leaves the room
   id held by a zombie.
6. **Local `close()` emits `'close'` on your own handler.** Reconnect logic must stale-guard
   per-connection handlers and cancel pending retries on a successful open, or one blip becomes
   a self-sustaining ~3s flap loop.
7. **Bind streams to media elements with callback refs**, not stream-keyed effects — camera
   toggles mutate the stream in place, so its reference never changes and an effect never
   re-fires for the freshly-mounted `<video>`.
8. **Join muted + camera off.** Always. People forgive a quiet entrance.

## Docs

Full deep-dives in [`docs/`](docs/) (and rendered at [kibitz.chat/docs](https://kibitz.chat/docs)):
[architecture](docs/architecture.md), [threat-model](docs/threat-model.md),
[verification](docs/verification.md) (who gets in), [cert-binding](docs/cert-binding.md),
[agent-platform](docs/agent-platform.md) / [agent-protocol](docs/agent-protocol.md),
[offline-mode](docs/offline-mode.md), [wake-seam](docs/wake-seam.md) (dev preview). The
embed/SDK reference is [kibitz.chat/docs](https://kibitz.chat/docs).

## License

**[Apache-2.0](LICENSE).** Kibitz is free software: you can use, study, share, modify, and
build on it — including in closed or commercial products — with no copyleft obligation. The
license includes an explicit patent grant, which matters for a WebRTC + crypto codebase. The
compiled build is likewise redistributable; host a copy anywhere (the public source snapshot is
`github.com/kibitz-chat/kibitz`).
