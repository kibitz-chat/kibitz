# Data channel as master — media control plane (as built)

> Status: **BUILT + DEPLOYED.** The reliable data channel is the media **signaling bus** and **recovery
> coordinator**; PeerJS is demoted to data + presence + bootstrap. We **own** the media `RTCPeerConnection` and carry
> its offer/answer/ICE over the data channel, so a dead path is re-negotiated (ICE-restart → re-create → relay)
> **without the broker**. This is the as-built reference; §7 (Code map) ties every mechanism to its symbol so the doc
> can be checked against the code.
>
> History: designed `8d6bfad` (L0 heartbeat) → built the owned transport `f67e035` → coordinated recovery `c1b71c1`
> → hard-close trigger `b7cb1e7` → the L3/L4 ladder `8281751`. The early design here drove PeerJS's
> `conn.peerConnection`; the build went further and replaced PeerJS media outright (see §1).

## 0. Why

Two transports, opposite reliability (the recurring root of every failure):
- **Data channel — SCTP/DTLS, reliable** (ACKs, retransmit, ordered). Survives packet loss + brief cellular blips.
- **Media — RTP/SRTP, unreliable, real-time** (no retransmit, firehose). Dies on the same marginal path → the
  half-open (`ice=connected`, ~0 bytes flowing).
- **Presence — rides the broker WebSocket**, whose drop instantly frees the authority id → split-brain.

So: put the things that must be reliable (media re-negotiation, recovery coordination) on the channel that *is*
reliable, and stop depending on the broker once a peer link exists.

**Honest limit:** the data channel rides the same ICE/DTLS as the media — a true IP change (WiFi↔4G) drops it too.
Its powers are (a) surviving loss/blips where RTP can't, and (b) being a reliable **signaling path** to carry an
**ICE-restart / re-create** that re-establishes the path — and itself — without the broker. "Master" works because
of (b). The broker is still needed for the *first* handshake (no data channel exists before connecting).

## 1. The pivot — we OWN the media transport

The design drove PeerJS's `conn.peerConnection`. The build went further: we do **not** use `peer.call` /
`conn.answer` / `peer.on('call')` at all. `createVoiceMesh` creates its **own** `new RTCPeerConnection` per peer
(`createMediaPc`) and carries the signaling over the data channel. PeerJS keeps only:
- **two `DataConnection`s per peer** — a `'sig'` master link (the control bus below: media signaling +
  recovery + the `cap` handshake) and a `'bulk'` link (all `{k}` app content + chunk transfers). See §2.5.
- **presence / the broker** — bootstrap + the roster authority.

**Why own it:** PeerJS's `RTCConfiguration` is **per-`Peer`** (`PeerJSOption`), not per-call/answer — so a **per-pc**
relay (L4) is impossible through PeerJS, and a broker-independent ICE-restart (L3) has nowhere to send its SDP.
Owning the pc gives both: per-pc `iceTransportPolicy` and SDP exchange over the data channel. `callMedia.ts` passes
the OWNED pcs the same `rtcConfig` (TURN/STUN `iceServers`, relay policy, DTLS certificate) the PeerJS `Peer` used to
get — so nothing about the ICE path regresses.

## 2. Control-message envelope

All ride the data channel; all are **intercepted in `mesh.ts`'s `conn.on('data')` and never forwarded to the app**:

```
{ t:'mh',        v, a, ov, oa }          // heartbeat: MY inbound (v/a) AND MY outbound (ov/oa) kbps — the outbound
                                         //   lets the peer tell a half-open from us simply being quiet
{ t:'mh-dead' }                          // "our shared media link is dead — re-dial it (you're the initiator)"
{ t:'m-sdp',     d:{ type, sdp } }       // offer/answer (perfect-negotiation). PLAIN {type,sdp} — PeerJS's serializer
                                         //   cannot encode a native RTCSessionDescription (it arrives empty)
{ t:'m-ice',     c: RTCIceCandidateInit }// a trickled ICE candidate
{ t:'m-recreate', relay?: boolean }      // "I'm rebuilding this link — drop your (dead) pc; relay? → rebuild relay-only too"
```

Dispatch in the data handler: `mh` → record the peer's inbound rate; `mh-dead` → `reDial`; `m-sdp`/`m-ice`/`m-recreate`
→ `onMediaSignal`; `cap` → record + (if we're this pair's initiator) dial `'bulk'` (§2.5); anything else → the app (`onDataCb`).

## 2.5 Two data channels — `sig` vs `bulk` (head-of-line isolation)

> Status: **built + committed, NOT yet deployed** (pending a 2-device media verify).

The control envelope above and the app's bulk content (chat, images, file chunks) once shared a SINGLE
`DataConnection`. A large transfer (e.g. an agent's multi-MB image) then **head-of-line-blocked** the recovery
signaling on that one ordered SCTP stream — a re-dial's `m-sdp`/`m-recreate` couldn't get out past the backlog,
so the link never re-negotiated and the agent's audio stayed frozen (observed: a painter call that went mute
right after a second image).

Fix: **a second `DataConnection` per peer, labelled `'bulk'`.**
- `'sig'` (the primary) carries the `{t:…}` control envelope (§2) ONLY — tiny messages, never backs up.
- `'bulk'` carries **all `{k:…}` content + binary chunk frames**. A separate SCTP association → no HOL.

`mesh.ts` holds `bulkLinks` alongside `dataLinks` with the same glare rule + self-heal re-dial. The content
surface is repointed: `broadcastData`/`sendData` prefer the bulk link (falling back to sig — see below);
`dataBufferedAmount`/`dataLinkOpen` reflect **bulk**, so a transfer gates + resumes on bulk-open and its chunks
never straddle the two channels.

**Cross-version handshake.** A peer on an OLD build can't tell `sig` from `bulk`, so we must not open a second
connection to it. On `sig`-open each side sends `{t:'cap',bulk:1}`; only on RECEIVING it does the pair's
initiator dial `'bulk'`. An old peer never advertises → never gets a bulk dial → stays **sig-only**: single
messages fall back to the sig link, and a transfer to it waits for bulk (times out → the public-chat
reconciliation re-delivers once it reloads onto the new build). Covered by `meshData.test.ts` (content-on-bulk /
signaling-on-sig isolation + the old-peer fallback).

## 3. Connection setup (owned, perfect-negotiation)

- **Initiator** = `shouldInitiate(selfId, peerId)` (deterministic glare-winner). Calls `startMedia` once the peer's
  **DATA channel is open** (the first offer rides it) → `createMediaPc(initiatedByUs=true)` → `onnegotiationneeded`
  → `m-sdp` offer.
- **Answerer** builds its pc reactively on the first `m-sdp` → `createMediaPc(false)`.
- **Perfect-negotiation (MDN):** `polite = !shouldInitiate`. On a colliding offer the **impolite** peer ignores it
  (its own offer wins); the **polite** peer rolls back and accepts. ICE that arrives before the remote description is
  buffered (`pendingIce`) and flushed once `remoteSet`.
- **Track order:** local tracks are added in the stream's order (mic, camera, share, share-audio) so transceiver
  order matches the per-lane media gate + `remoteShare*` mapping; `addTransceiver` fills any missing audio/video so a
  muted / camera-off peer can still **receive** (what `peer.call`'s `offerToReceive*` did).

## 4. Recovery ladder (the single recovery path)

**Detection — two triggers feed `recover(id)`:**
- **Heartbeat** (`HEARTBEAT_MS = 2000`): per pc, measure INBOUND **and** OUTBOUND kbps (`getStats` `inbound-rtp` /
  `outbound-rtp` byte-deltas) and report both over `mh` (`v/a` inbound, `ov/oa` outbound). Sustained inbound
  `< MIN_FLOW_KBPS` for `RECOVER_AFTER_MS = 9000` → consider `recover` — but **only for a real half-open**: the peer
  reports it IS sending (`peerTx > 0`) yet we receive ~0. A peer that is simply **quiet** (a mic-less voice agent, or
  a muted human → `peerTx ~0`) is alive-but-silent and is **not** re-dialed — re-dialing it just churns the link
  (it did: a silent agent's media got re-dialed every few seconds and its replies stopped arriving). The decision is
  the pure `mediaRecover.ts` `shouldRecoverMedia` (unit-tested); `peerTx` unknown (older peer) → historical behavior.
  This is why the agent no longer needs a constant outgoing keep-alive dither (removed) — the data channel + the
  peer's reported outbound prove liveness, so silence is not mistaken for death.
- **`pc.onconnectionstatechange === 'failed'`** → `recover` immediately (a hard ICE death, no need to wait out the
  no-flow window).

**`recover(id)`** sets a `lastFlow` cooldown (the attempt gets `RECOVER_AFTER_MS` to land) then: the **initiator**
`reDial`s; the **non-initiator** nudges `{ t:'mh-dead' }` (`reDial` is a no-op off-initiator, so a stray nudge can't
cause a glare).

**`reDial(id)`** — bounded by `MAX_RECOVER = 3`, gentlest → heaviest:
- **n=0 — L3 in-place ICE-restart:** `pc.restartIce()` → `onnegotiationneeded` → `m-sdp` offer with fresh ICE over
  the data channel. Keeps the senders, no re-create, no broker. Fixes the common case (a network change orphaned the
  candidates).
- **n=1 — full re-create (cycling policy):** `m-recreate` handshake → **both** sides close the dead pc and rebuild
  with fresh senders + a fresh path.
- **n≥2 — L4 re-create RELAY-ONLY:** `m-recreate{ relay:true }` → both pcs rebuild with `iceTransportPolicy:'relay'`
  → the pair meets on TURN (the CGNAT/4G fix PeerJS's per-`Peer` config blocked). **Per-pc** — only this link
  relays; every other link keeps cycling.

**The both-directions invariant:** `recoverCount` resets (link declared healthy) **only when BOTH** our inbound AND
the peer's reported inbound flow (`rxV+rxA` and `peerV+peerA` ≥ `MIN_FLOW_KBPS`). A one-way half-open (our outbound
dead, our inbound fine) must **not** reset on our healthy inbound — else the initiator loops forever on the gentle
ICE-restart and never escalates to a re-create / relay.

## 5. Removals — clean replacement, no competing recovery paths

**Deleted** (superseded by the single heartbeat-driven path):
- `armMediaWatchdog` (re-dial a never-connected pc) + `armDropWatch` (re-dial a connected-then-dropped pc) + their
  state (`mediaWatchdogs`, `dropTimers`, `mediaRedialCount`, `MEDIA_STALL_MS`, …).
- `hasFlowingMedia` (a half-open track reads `'live'` while carrying 0 bytes — byte-rate is the only truth),
  `pendingIn`, the `closeRecover` teardown hack, the media `dialled` set.
- **PeerJS media itself** — `peer.call` / `conn.answer` / `peer.on('call')` → replaced by `createMediaPc`.

**Kept (distinct, still needed):**
- `scheduleDataRedial` — keeps the master **DATA** link alive (separate from media recovery).
- `DROP_GRACE_MS = 7000` — a transient roster gap (broker reconnect) must not tear down live P2P/TURN media.
- `FORCE_RELAY_DEFAULT` (`callMedia.ts`, default **true**; read at connect via `forceRelay()`) — the **global**
  relay-only override (shared with the presence peer in `Widget.tsx`). L4 relay is **per-pc**, NOT this; the global
  now defaults **on** (the reliable relay-for-everyone baseline until connected-but-media-dead detection is
  device-proven), with a per-device `?relay=0` / `kbz.forceRelay='0'` to opt into direct-first.

## 6. Designed but NOT built

- **L2 keyframe (`mh-pli`):** video-only-dead (audio flows, decoder stuck) → ask the sender for a keyframe instead of
  a re-dial. Not implemented — the n=1 re-create covers a stuck decoder, just less cheaply. No `mh-pli` exists in code.
- **L5b gossip/CRDT roster:** deferred. The single migrating authority + `onGone` re-join (`bb07a15`) +
  `DROP_GRACE_MS` keep the roster alive across a broker blip; a consensus rewrite isn't justified yet.

## 7. Code map (doc ↔ code — verify here)

| Mechanism | `src/core/…` · symbol |
|---|---|
| Owned media pc | `mesh.ts` · `createMediaPc`, `interface Link` |
| Signaling over the data channel | `mesh.ts` · `onMediaSignal` + the `conn.on('data')` interceptor (`mh`/`mh-dead`/`m-*`) |
| Perfect-negotiation | `mesh.ts` · `Link.polite`/`makingOffer`, `onMediaSignal` collision + `'rollback'` |
| Initiator election (glare-free) | `mesh.ts` · `shouldInitiate`, `startMedia` |
| Heartbeat detection + overlay | `mesh.ts` · `heartbeat` (`HEARTBEAT_MS`), `mediaHealth`, `window.__kbzMediaHealth` |
| Recovery triggers | `mesh.ts` · `recover` ← heartbeat no-flow + `pc.onconnectionstatechange === 'failed'` |
| Recovery ladder | `mesh.ts` · `reDial` (`restartIce` → `m-recreate` → `m-recreate{relay}`) |
| Both-directions invariant | `mesh.ts` · `heartbeat` (`recoverCount.delete` only when `peerV+peerA` flow too) |
| Per-pc relay (L4) | `mesh.ts` · `rtcFor(relay)`, `pendingRelay`; `createMediaPc(…, relay)` |
| rtcConfig (TURN/STUN, relay, cert) | `callMedia.ts` · `createVoiceMesh({ rtcConfig })` |
| Global relay override (on) | `callMedia.ts` · `FORCE_RELAY_DEFAULT = true` (runtime `forceRelay()`) |

**Tunables** (`mesh.ts`): `RECOVER_AFTER_MS = 9000`, `MIN_FLOW_KBPS = 1`, `MAX_RECOVER = 3`, `HEARTBEAT_MS = 2000`,
`REDIAL_DELAY_MS = 800`, `DROP_GRACE_MS = 7000`.

## 8. Verification (Chromium e2e, no device loop)

BASE-aware (local `vite` of the working tree, or a deployed `BASE`):
- `e2e/media-recover.mjs` — half-open → recovered.
- `e2e/media-pc-killed.mjs` — a hard `pc.close()` → recovered (the `'failed'` trigger; `B_sum` climbs from 0).
- `e2e/reconnect-churn.mjs` — repeated churn empties cleanly (no orphan links / connection storm).
- `e2e/media-relay.mjs` — L4 relay escalation; needs a **deployed** `BASE` (local has no TURN).

Assert with **`inboundSum` + a growing-rate** check, never a single max — a recovered link is a **fresh pc counting
from 0**, so a peak from before recovery would mask a dead re-dial. Plus the roster guards
(`src/core/localBus`/`room`/`joinGateRuntime`). Live observability: the conn-debug overlay reads
`window.__kbzMediaHealth` (per-pc `rxV/rxA/peerV/peerA`).
