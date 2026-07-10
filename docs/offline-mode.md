# Kibitz Offline — the LAN hub

Video rooms on a LAN with **no internet, no accounts, and nothing to install** on
the guests' side. Run one tiny program on **one** device on the local network —
the **LAN hub** — and everyone else just opens kibitz.chat in a browser on that
same Wi-Fi, and they're in a call. The hub is the rendezvous; on a phone Wi-Fi it
also **relays the (encrypted) media** so the call works where browser-to-browser
fails (see [Media](#media-and-data--through-the-hubs-turn-still-encrypted)).

> **Not the internet TURN relay.** Kibitz has two unrelated things. The internet
> **TURN relay** forwards an *online* call's encrypted media when a direct
> connection is blocked (see [architecture.md §3](./architecture.md)). The **LAN
> hub** described here (Offline mode) replaces the internet *entirely* for a
> same-Wi-Fi call — and it runs its *own* small LAN TURN. The hub ships as the
> **kibitz-offline** project (a static Go binary, MIT) — see its
> [ARCHITECTURE.md](https://github.com/kibitz-chat/kibitz-offline/blob/main/docs/ARCHITECTURE.md).

## How a call happens: start one, share the link

An offline call is a **normal room with an un-guessable id**, hosted on a hub, and
**joined by a link** — exactly like an online call, except the link also carries the
hub itself.

- **Start a call.** Tap **"Start a call on this Wi-Fi."** The app gets a hub — *your
  own device* if it's the hub (the Android app is its own relay), otherwise it
  **discovers** one on the LAN — mints a fresh un-guessable room id, and drops you
  into the (empty) room. The room's **Share** button hands out the link:
  `…/?galaxy=<blob>#<roomid>` — `<blob>` is the hub (its fixed identity + LAN
  address + TURN), `<roomid>` is the room.
- **Join.** Open that link. The app reads the hub from the `?galaxy=` blob and
  connects **straight to it — no discovery, no scan** — then joins the room id. Same
  one tap as any online call.

**Where discovery fits — and where it doesn't.** Discovery exists for *exactly one*
moment: a **creator** reaching a hub that **isn't their own device** (a dedicated or
headless relay — no screen to scan a QR off). Everyone you *invite* uses the link,
which already names the hub, so they never discover. And there is deliberately **no
"browse and join a nearby call"** — a room is reached only by its link, so a random
person on the Wi-Fi can't wander into your call. (With the fixed identity, a link is
really just *discovery plus an IP hint*; discovery is the link minus the IP.)

## Design

### The hub: a dumb relay

The relay is deliberately **dumb** — it assigns each browser an `id` and routes
`{to, payload}` frames between them, and nothing else (the contract the web client
talks to in `galaxyHub.ts`, `send`/`broadcast`). All call semantics (presence,
roster, media signaling) live in the web layer as frame payloads, so the box itself
almost never needs updating. It ships as a single static Go binary (a Pi appliance,
an Android app, or any laptop).

### Multi-room: one relay, many calls

The relay scopes routing by **room**, so a single hub carries several independent
calls at once. A client declares its room with a `join` frame; the hub then returns
only same-room peers from `peers`, and a `to` only reaches a same-room peer
(`relaycore` `idsInRoom` / `dstInRoom`). The room is the join link's URL `#hash` —
`…/?galaxy=…#ember-a3f9k2mq7p` and `…#opal-77x…` are isolated calls on the same box.
This is exactly how the **start-a-call** model above stays private: every call gets a
fresh un-guessable room id (`freshRoom`), and the id is the capability — reaching the
(open) hub is not the same as being in a room. (A client that never sends `join` — an
older build, or kibitz — stays in the default shared room `""`, the back-compat path.)

### The handshake trick: a permanent identity → the blob → discovery

A browser can dial WebRTC on its own but needs to exchange setup info ("signaling")
first — normally a server's job. The hub sidesteps that with a **permanent identity**:
a fixed UDP port, fixed ICE credentials, and a fixed DTLS certificate. That whole half
of the handshake packs into one short **blob**, which becomes the `?galaxy=…` in a
link / QR. The web app reconstructs the hub's side of the handshake *locally* from the
blob — so there is **zero per-session signaling** (`galaxySignal.ts`).

The identity comes in two flavors:

- **Per-relay, persisted** (the default for a relay with `--fixed-id=false`): a unique
  identity saved to disk, so a printed QR keeps working across restarts. Reachable only
  via its own link/QR.
- **Fixed & well-known** (`relaycore/fixedid.go`; **default on** for the desktop/Pi
  binaries, always on in the Android app): *every* hub shares the same identity, and the
  web bakes in the same constants (`hubDiscover.ts`). That's what makes **discovery**
  possible — the app can probe the LAN for the well-known identity with no prior info
  (used only at create-time; see above). WebRTC isn't subject to mixed-content rules, so
  this works from the HTTPS PWA where an HTTP probe couldn't.

The blob also persists in `localStorage` for the connection (`galaxyHub.ts`), but
**routing** keys on the blob in *this URL's* `?galaxy=` (`urlGalaxyBlob`), never the
cache — so a blob cached from an earlier offline call can't hijack a normal online room.

### Media and data — through the hub's TURN, still encrypted

The hub runs a small **LAN TURN** server. On a phone Wi-Fi, browser-to-browser media
often can't form a direct link — iOS (and others) hide each device's host candidate
behind an mDNS `.local` name the *other* phone can't resolve — so the media mesh dials
**relay-only** (`iceTransportPolicy: 'relay'`) and audio, video, **and the data
channel** (chat, co-browse, ink) all route **through the hub's TURN**
(`lanMesh.ts:88-94`). That single change is what makes offline media actually work on
iPhone↔Android.

But the hub only ever sees **ciphertext.** Every link is **DTLS-encrypted end-to-end**
between the two browsers; the TURN relays the encrypted packets without the keys to
read them. So the hub *carries* your traffic but can never decrypt, record, or join it.
The mesh is otherwise the same battle-tested code and no-churn rules as the online mesh
(smaller id initiates each pair; audio + a placeholder video lane from the start; camera
toggles are `replaceVideoTrack` swaps, never a re-dial). LAN is a best-case environment —
gigabit, ~0 ms RTT — so a handful of tiles run great.

> A `g1` relay with no TURN falls back to **direct** browser-to-browser media
> (`iceServers: []`) — fine on a forgiving LAN, but it's why phone LANs needed the TURN.

### The offline room: self-assembling, no authority

Where an online room elects a migratory coordinator over the broker, the LAN room needs
none — the relay is an always-on box, so peers just self-assemble (`lanRoom.ts`). Each
browser periodically **broadcasts a presence beacon** (`present`: name / cam / avatar);
every peer builds the roster locally and reaps the silent ones (`BEACON_MS = 2500`,
`REAP_MS = 8000`). A newcomer's `hi` prompts everyone to re-announce; `bye` is a clean
leave. Identity = the hub id, stable for the session — all a LAN call needs.

### Reused vs new

- **Reused**: the whole call mesh and its no-churn rules; the `RoomLink` interface
  (`lanRoom.ts` is the LAN twin of `room.ts`); the entire call UI (Tile / CallSurface /
  widget panel, chat); the room's **invite panel** (QR + copy) — for an offline room
  `buildInvite` just returns the current `?galaxy=<blob>#<roomid>` URL, so Share works
  unchanged.
- **New (in the box)**: the Go relay binary, its identity (fixed UDP port + ICE creds +
  DTLS cert), its LAN TURN, and the `?galaxy=…` blob codec (`buildGalaxyBlob` /
  `parseGalaxyBlob`).

## Setup (what users need)

1. **A hub on the LAN** — a Pi appliance, an Android phone (the app *is* a hub), or any
   laptop running the `kibitz-offline` binary. It binds one UDP port, answers WebRTC
   handshakes, and runs a LAN TURN; that's the whole job.
2. **The app, available offline** for guests: open / install kibitz.chat as a PWA while
   online once (the service worker caches it; one online load is enough — `clients.claim()`).
   The **Android app bundles the web client**, so the host cold-starts with no internet at
   all. (The link carries the *connection*, not the *app* — a guest still needs the app
   loaded once.)
3. **A common IP network**: shared Wi-Fi — or, with no internet at all, the hub's own
   device provides it (a Pi/Android hotspot, a LAN made from nothing).
4. **Permissions**: camera + mic, granted in the flow.

## Shipped relay traits

- **Discoverable by default** (`--fixed-id`, default on): a downloaded/double-clicked hub
  is found by the app with no QR. `--fixed-id=false` → a unique per-relay identity,
  reachable only via its own link/QR.
- **Advertises its `.local` hostname** so a Pi without a static IP is reachable by name.
- **Keep relaying after reboot** — a Pi is a set-and-forget systemd appliance; the Android
  build can keep the hub running across reboots (a spare phone becomes the box).
- **Permanent identity** (fixed, or per-relay persisted to `--state`) so the same link
  works across restarts.

## Privacy & threat notes

- **The hub can't see or hear you.** All media + data is **DTLS-encrypted end-to-end**,
  browser-to-browser. Even when the hub **relays** that traffic through its TURN (the
  default on a phone LAN), it only ever forwards **ciphertext** — it never carries
  plaintext, can't decrypt, record, or join. And because it's a box *you* run on *your
  own* Wi-Fi, even the relayed packets never leave your network.
- **It sees *who's* connected, not *what* you say.** As the coordination point the hub
  carries presence beacons (who's connected, their names) and the WebRTC handshakes — that
  metadata it does see; the content it carries is encrypted.
- **Open on the LAN, gated by the room id.** With the fixed identity, *anyone on the Wi-Fi*
  can reach the hub (DTLS encrypts but no longer authenticates the hub) — the accepted
  trade-off for a trusted network. Reaching the hub is **not** joining a call, though: a
  call is behind an un-guessable room id only people with the link have. There is no
  browse-and-join.
- **Signaling-server caveat.** Like any signaling server the hub *could* try to interfere
  with how browsers pair up. The in-call **safety code** (the SAS emoji from the real DTLS
  fingerprints — [architecture.md §5](./architecture.md)) is what catches that.
- **Open source, no phone-home.** Everything that runs is in the `kibitz-offline` repo; the
  binary makes no network calls home and carries no telemetry.

## Limits (honest)

- Mesh ceiling ~6 people (best-case environment though).
- No ringing / notifications (nothing to ring through on a closed LAN).
- A guest must load the app **once** (online, or from the Android bundle) before they can
  join offline — the link carries the hub, not the app.
- Binaries are flagged **preview** on some OSes (Windows / macOS / Pi unverified) until
  field-tested.

## Reconnection

- **Blips**: ICE's own recovery heals `disconnected` states in seconds with no signaling.
  Because the hub is always on, a peer can also just re-handshake through it.
- **Hub down**: the LAN call can't form new links until the box is back, but existing media
  is pairwise and continues; the hub's persisted/fixed identity means the same link works
  again the moment it returns.

---

## Appendix — alternative considered: the broker-less "phone kiss"

An earlier design (2026-06-07, **not built**) replaced the hub with QR codes exchanged
directly between phones — no relay box at all. Each pair did a mutual QR "kiss" (two QRs
carrying the ~100-byte variable part of each side's SDP), the first device acted as a
founder that relayed joiner↔joiner signaling over data channels, and the mesh assembled
from `N−1` kisses. It was dropped in favor of the LAN hub: the hub needs no per-pair
ceremony, no minimal-SDP template codec (which drifts across browser versions), and
supports auto-reconnect — at the cost of one small always-on box. The privacy properties
are the same (a content-blind coordination point caught by the safety code). Kept here
only as design history.
