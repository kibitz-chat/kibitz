# Kibitz Offline — the LAN hub

Video rooms on a LAN with **no internet, no accounts, and nothing to install** on
the guests' side. Run one tiny program on **one** device on the local network —
the **LAN hub** — and everyone else just opens kibitz.chat in a browser on that
same Wi-Fi, and they're in a call. The audio and video flow phone-to-phone across
the LAN; the hub only helps the browsers find each other.

> **Not the TURN relay.** Kibitz has two unrelated things. The internet **TURN
> relay** forwards an *online* call's encrypted media when a direct connection is
> blocked (see [architecture.md §3](./architecture.md)). The **LAN hub** described
> here (Offline mode) replaces the internet *entirely* for a same-Wi-Fi call. The
> hub ships as the **kibitz-offline** project (a small static Go binary, MIT,
> renamed from "kibitz-relay").

## The idea in one line

A small **always-on relay box** on the LAN replaces the cloud signaling broker.
Every browser connects to it, beacons its presence, and exchanges WebRTC
handshakes through it; once the mesh forms, all content (audio, video, chat,
co-browse) flows **directly between browsers** — the hub never carries it.

## Design

### The hub: a dumb relay

The relay is deliberately **dumb** — it assigns each browser an `id` and routes
`{to, payload}` frames between them, and nothing else (the contract the web client
talks to in `galaxyHub.ts:3-13`, `send`/`broadcast` :128-135). All call semantics
(presence, roster, media signaling) live in the web layer as frame payloads, so the
box itself almost never needs updating. It ships as a single static Go binary (a Pi
appliance, an Android app, or any laptop).

It reaches the browsers through one clever trick — a **permanent identity**: a
fixed UDP port, fixed ICE credentials, and a fixed DTLS certificate it persists
across restarts. That entire half of the WebRTC handshake packs into one short
blob that becomes the `?galaxy=…` in the join link / QR. The web app reconstructs
the hub's side of the handshake *locally* from that blob, so there is **zero
per-session signaling** (`galaxySignal.ts`). Scan once, connect forever.

The blob arrives once via `?galaxy=…` and **persists in localStorage** — open the
relay's link once on its Wi-Fi (or while online), and Kibitz works on that LAN
forever after; `?galaxy=off` clears it (`galaxyHub.ts:15-39`).

### The offline room: self-assembling, no authority

Where the online room elects a migratory coordinator over the broker, the LAN
room needs none — the relay is an always-on box, so peers just self-assemble
(`lanRoom.ts:1-23`). Each browser, on the hub, periodically **broadcasts a
presence beacon** (`present`: name / cam / avatar); every peer builds the roster
locally from those beacons and reaps the silent ones (`BEACON_MS = 2500`,
`REAP_MS = 8000`). A newcomer's `hi` frame prompts everyone to re-announce so it
appears at once; `bye` is a clean leave. Identity = the hub id, stable for the
session — which is all a LAN call needs.

### Media and data (the mesh)

Media is a pairwise WebRTC mesh whose offer/answer/ICE are trickled **over the
hub** (the hub routes handshakes; media itself flows directly between browsers,
LAN-only, `iceServers: []` — `lanMesh.ts:1-17`). It implements the *same*
`VoiceMesh` interface and the same battle-tested no-churn rules as the online mesh
(smaller id initiates each pair; every link carries audio + a placeholder video
lane from the start; camera toggles are `replaceVideoTrack` swaps, never a
re-dial). LAN is the best-case mesh environment — gigabit, ~0 ms RTT, no upload
caps — so 6 tiles run better in one house than online across town.

**Content does not go through the hub.** Chat, co-browse, pay, and ink ride a
peer-to-peer `RTCDataChannel` on the lanMesh connections, exactly like the online
data mesh (`lanRoom.ts:21-22`, `lanMesh.ts`).

### Reused vs new

- **Reused**: the whole call mesh and its no-churn rules; the `RoomLink` interface
  (`lanRoom.ts` is the LAN twin of `room.ts`); the entire call UI
  (Tile / CallSurface / widget panel, chat pane); the QR scanner (BarcodeDetector
  + jsQR fallback, battle-tested on iOS) to read the `?galaxy=…` blob.
- **New (in the box)**: the Go relay binary, its persisted identity (fixed UDP
  port + ICE creds + DTLS cert), and the `?galaxy=…` blob codec.

## Setup (what users need)

1. **Run the hub** on one device on the LAN — a Pi appliance, an Android phone, or
   any laptop. It binds one UDP port and answers WebRTC handshakes; that's the
   whole job. It prints a join link / QR carrying the `?galaxy=…` blob.
2. **The app, available offline** for the guests: open / install kibitz.chat as a
   PWA while online once (the service worker caches it; a secure origin is retained
   offline, satisfying `getUserMedia`'s HTTPS requirement). Then scan the hub's QR.
3. **A common IP network**: shared Wi-Fi — or, with no internet at all, the hub's
   own device provides the network (a Pi/Android hotspot, a LAN made from nothing).
4. **Permissions**: camera + mic, granted in the flow (the camera doubles as the
   QR scanner).

## Shipped relay traits

- **Advertises its `.local` hostname** so a Pi without a static IP is still
  reachable by name (`--advertise` overrides the advertised LAN address).
- **Keep relaying after reboot** — a Pi is a set-and-forget systemd appliance, and
  the Android build can keep the hub running across reboots (a spare phone becomes
  the box). The join code never changes because the identity is persisted.
- **Permanent identity** persisted to disk (`--state`), so the same QR works
  across restarts.

## Privacy & threat notes

These survive from the original design and still hold:

- **The hub can't see or hear your audio/video.** Voice and video are a P2P WebRTC
  mesh, encrypted end-to-end (DTLS-SRTP), flowing browser-to-browser. The hub never
  carries, decrypts, records, or joins the media.
- **It sees *who's* in the call, not *what* you say.** As the coordination point
  the hub carries presence/roster beacons (who's connected, their names) and the
  WebRTC handshakes — that metadata it does see. But **content (chat, app messages)
  goes peer-to-peer over the LAN, not through the hub**, so it can't read that
  either. And because it's a box *you* run on *your own* Wi-Fi, even the presence
  metadata never leaves your network — there's no operator but you.
- **Signaling-server caveat.** Like any signaling server, the hub *could* try to
  interfere with how the browsers pair up. The in-call **safety code** (the SAS
  emoji derived from the real DTLS fingerprints — see
  [architecture.md §5](./architecture.md)) is what catches that.
- **Open source, no phone-home.** Everything that runs is in the kibitz-offline
  repo; the binary makes no network calls home and carries no telemetry.

## Limits (honest)

- Mesh ceiling ~6 people (best-case environment though).
- No ringing / notifications (nothing to ring through on a closed LAN).
- The binaries are flagged **preview** on some OSes (Windows / macOS / Pi
  unverified at v0.1.0) until field-tested.

## Reconnection

- **Blips**: ICE's own recovery heals `disconnected` states in seconds with no
  signaling — covers most real-world drops for free. Because the hub is always on,
  a peer can also just re-handshake through it (unlike a broker-less scheme).
- **Hub down**: the LAN call can't form new links until the box is back, but
  existing media is pairwise and continues; the hub's persisted identity means the
  same QR/blob works again the moment it returns.

---

## Appendix — alternative considered: the broker-less "phone kiss"

An earlier design (2026-06-07, **not built**) replaced the hub with QR codes
exchanged directly between phones — no relay box at all. Each pair did a mutual QR
"kiss" (two QRs carrying the ~100-byte variable part of each side's SDP), the first
device acted as a founder that relayed joiner↔joiner signaling over data channels,
and the mesh assembled from `N−1` kisses. It was dropped in favor of the LAN hub
above: the hub needs no per-pair ceremony, no minimal-SDP template codec (which
drifts across browser versions), and supports auto-reconnect — at the cost of one
small always-on box. The privacy properties are the same (a content-blind
coordination point caught by the safety code). Kept here only as design history.
