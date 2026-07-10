# Unified room sync — one mechanism for "catch a peer up"

**Status: built behind the `ROOM_SYNC_V2` flag; currently parked default-off** (2026-07-02, after device
trouble — a Samsung renderer OOM from the in-RAM blob store + double-transfer/reconstruct races; the code stays
intact and inert, re-enable by flipping `ROOM_SYNC_V2_DEFAULT_ON`, or per-device `localStorage['kbz.roomSyncV2']='1'`).
The build (`blobStore.ts`, `blobSync.ts`, the `chatLedger` adapter, the `blob`/`chatledger` mesh lanes) collapses
the three overlapping "bring a peer to the room's current content" paths into **one convergence mechanism**, built
on the `roomLedger` substrate that already exists.

## The problem (why this doc)

Today there are **three separate code paths** doing the same conceptual job — *make a peer hold what the room
holds* — each with its own rules, so content passes one and fails another:

| Path | Code | Carries | Bounds that drop content |
|---|---|---|---|
| Live late-joiner | `useChatSync` / `useMediaSync` / `useWidgetSync` (re-broadcast on roster change) | text / media / widgets | `useMediaSync`: **30 MB** replay budget, needs a live blob `url`, **no chip fallback** |
| Durable (cross-session) | `exportLedger` / `importLedger` → agent seals to S3 | text / image / widget / attachment | attachment bytes capped at **8 MB**; else metadata chip |
| Metadata state | `roomLedger` + `LedgerSync` (`~kbz.ledger`) + `LedgerStore` | small facts (the resumable hint) | small-metadata only, by design |

**Symptom that exposed it:** upload a video, a second device joins → the video isn't in its chat. It's a
large file, so `useMediaSync` skips it (`over-byte-budget`), silently. The durable ledger would keep only an
8 MB-capped chip. Two mechanisms, two caps, one dropped video — and a fix to one path (the attachment ledger)
doesn't fix the other.

## The end state

**One ledger is the room's union; every peer — present, late-joining, or resuming — converges to it. Bytes
are content-addressed and fetched on demand, never bounded by a replay budget.**

Concretely, two layers with a clean split (the split the `roomLedger` doc already draws: *the ledger is small
metadata; media stays on the transfer path*):

1. **The ledger = the ordered union of chat entries**, each a *small* record:
   - text → `{ text, author, ts }`
   - media/file → a **content ref** `{ hash, mime, size, name, author, ts }` — **no bytes**
   - widget → `{ kind, data, author, ts }`
   Rides the **existing `roomLedger` CRDT + `LedgerSync`** (`~kbz.ledger` digest→delta) + `LedgerStore`
   (local persistence). Late-join, rejoin, and agent-resume all become the *same* thing: **sync the ledger.**
   A chat message is an **owned key** (`key = mid`, author-signed, immutable → no merge conflict); the union
   is just the ledger's keyspace ordered by `ts`. `CHAT_KEEP` entries of small records stay well within the
   "small metadata" envelope — no bytes ever live here.

2. **Bytes = a content-addressed store + fetch-by-hash**, over the existing `chunkSink` (fsa/opfs/mem) +
   `sha256` primitives:
   - On upload, bytes are stored under their **content hash**; the ledger entry references that hash.
   - A peer that needs a ref it doesn't have **fetches by hash**: a new `~kbz.blob` request → any peer
     advertising that hash streams it via the current chunked xfer (resumable, dedup'd). Lazy (fetch on
     render/scroll), so joining a room with 200 images doesn't blast 200 transfers.
   - **No 30 MB / 8 MB cliffs.** Bound by disk/quota + a per-fetch policy, not a replay budget. A big video is
     a ref that renders as a placeholder immediately and streams its bytes when the viewer wants it.
   - **Durable (Layer 3):** the agent (or a managed store) persists the ledger (small — it already does via
     `getLedger`/`putLedger`) and optionally the **blobs** (S3, keyed by hash) so a *fully-cold* room can still
     serve bytes. Warm rooms serve peer-to-peer; the blob store is the cold-room backstop.

Then `useChatSync` / `useMediaSync` / `useWidgetSync` and `exportLedger`/`importLedger` **collapse into**:
"publish/merge ledger entries + serve/fetch bytes by hash." One path. The video reaches the late joiner
because it's a ref in the union it syncs, and its bytes stream on demand.

## What we reuse (most of the hard part is done)

- **`roomLedger.ts`** — signed CRDT (owned LWW + attested OR-set), commutative/associative/idempotent merge,
  GC/TTL. Chat entries are owned keys; no new CRDT kind needed.
- **`roomLedgerSync.ts`** — `request` / `state` / `update` over `~kbz.ledger`, echo-safe (merges never
  re-broadcast; join handshake heals misses). This IS the convergence protocol.
- **`roomLedgerStore.ts`** — local persistence (localStorage now, async KV → IndexedDB later).
- **`chunkSink.ts`** (fsa/opfs/mem tiers, anti-DoS ceilings) + `sha256HexOfBlob` + the chunked xfer +
  resumable partials — the byte plumbing for the content store already exists.

## What's new

- **A chat-ledger schema on `roomLedger`** — entries keyed by `mid` (owned, author-signed), value = text /
  content-ref / widget. A thin adapter maps `ChatItem[] ↔ LedgerState` (the pure `serializeLedger` /
  `deserializeLedger` become this adapter, now emitting refs instead of inline image/attachment bytes).
- **A content-addressed blob store** — `hash → bytes` over `chunkSink`, with `put(bytes)→hash`, `has(hash)`,
  `get(hash)→bytes|stream`, quota-GC.
- **A `~kbz.blob` fetch protocol** — `have(hash)` advertise / `want(hash)` request / stream reply, riding the
  existing xfer for the actual bytes; dedup by hash; lazy on first render.
- **Ledger sizing for chat** — `roomLedger` is size-capped for metadata; chat needs `CHAT_KEEP`-order entries.
  Confirm/raise the cap for the chat keyspace (still bytes-free, so bounded and safe), plus per-key GC by `ts`.

## Build order (each phase ships + is testable; the old paths stay until the new one is proven)

0. **Content-addressed blob store** (`blobStore.ts`, pure + OPFS-backed) + unit tests. No wire yet. Upload
   stores by hash; `Attachment`/image get a `hash`. (Supersedes the 8 MB inline cap — the byte-lightening
   slice, now with a purpose.)
1. **`~kbz.blob` fetch-by-hash** protocol (`blobSync.ts`, transport-injected like `LedgerSync`) + in-memory-bus
   tests, then the engine adapter. A ref with no local bytes fetches them from a holder; render shows a
   placeholder→bytes.
2. **Chat-on-roomLedger adapter** — `ChatItem[] ↔ LedgerState` (text/ref/widget as owned keys). Behind a flag
   (`ROOM_SYNC_V2`), run the chat union through `LedgerSync` **alongside** the current paths (dedup by mid, so
   coexistence is safe). Unit + the in-memory-bus convergence tests.
3. **Cut over the seams** — late-join/rejoin/resume all call the ledger sync; retire `useMediaSync`'s replay
   budget + `useChatSync`/`useWidgetSync`'s per-item re-broadcast once V2 is proven. Keep `onRosterChange` as
   the trigger.
4. **Durable Layer 3** — agent persists the ledger (already does) + blobs to S3 by hash; cold-room byte fetch
   falls back to the store. Reaper/TTL for blobs.
5. **Remove the old paths + caps** once 2-device + agent-resume are validated live.

## Verification

- **Unit / in-memory bus:** the CRDT convergence (exists) + the blob fetch protocol + the chat↔ledger adapter
  round-trip. Deterministic, no network.
- **Chromium e2e:** extend `ledger-attachment.mjs` — a large "video" ref syncs to a fresh peer and its bytes
  fetch by hash (headless can drive the ledger + blob channels even where the media/bulk lane is flaky).
- **2-device (mandatory, user-run):** the reported case — upload a video, second device joins → it appears
  (placeholder then plays); leave/rejoin; agent resume. This is the delicate comms core → live-validate before
  removing the old paths (Phase 5), same discipline as the P2P wave.

## Risks

- **Most delicate code in the app.** Mitigated by: reusing the proven `roomLedger` substrate (not new sync
  logic), shipping behind `ROOM_SYNC_V2` with the old paths live and dedup-safe coexistence, and cutting over
  only after 2-device validation.
- **Ledger size** — chat is more/larger entries than the resumable hint. Kept bytes-free (refs only) + capped +
  GC'd; measure before Phase 3.
- **Byte availability** — a ref whose only holder left and which isn't in the blob store is unfetchable. Same
  inherent peer-held limit the `roomLedger` doc already states; Layer 3 (blob store) is the cold-room cure.
- **Signing** — chat entries are author-signed like other owned keys; unsigned tier only for low-stakes.
```
