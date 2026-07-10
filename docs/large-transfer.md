# Large file transfer — stream to disk, lift the RAM ceiling

Today a file/image transfer is capped at **50 MB** (`XFER.MAX_BYTES`, `src/core/contentXfer.ts`). That cap
is not a protocol limit — it's a **memory** one: the whole payload buffers in RAM on **both** ends. This doc
removes that ceiling — **stream chunks to disk on receive, slice the source lazily on send** (binary frames
come in Phase 2) — so a transfer is bounded by *storage*, not heap, and can reach GB scale, including on the
iOS PWA. P2P stays end-to-end (no server touches the bytes); only the size budget changes.

**Phase 1 is implemented behind an off-by-default flag — see [§Implementation](#implementation-phase-1--as-built)
for the precise as-built behavior.** The sections below give the design rationale and the full (Phase 1 + 2) shape.

## Implementation (Phase 1 — as built)

Committed (not deployed) in `b307b9c` (foundation) + `9024dd4` (wiring), with the leak-fix tests in `daffc14`.
**Behind an off-by-default flag**; when off, the path is byte-for-byte today's in-RAM behavior.

### The flag
`largeXferOn()` (`src/react/useCall.ts`) — true when `window.__kbzLargeXfer === true` OR
`localStorage['kbz.largeXfer'] === '1'`. Read **fresh at each `xbegin` (receive) and each `sendFile` (send)**,
so it toggles per device + reload, no rebuild. Default **off**. Sender *and* receiver must both have it on — a
flag-off receiver caps at 50 MB and silently rejects a larger `xbegin`.

### When the disk path engages
Both conditions, else the legacy in-RAM `Reassembler` path runs unchanged:
- **Receive:** `largeXferOn()` AND `detectSinkCaps().opfs` AND `begin.kind !== 'text'` AND `begin.size > XFER.MAX_BYTES` (50 MB).
- **Send:** `largeXferOn()` AND `file.size > XFER.MAX_BYTES`.

Text, ≤50 MB image/file, and any peer/browser without OPFS stay in RAM. **FSA is not auto-selected on receive
in Phase 1** (it would pop a save dialog mid-chat); `FsaSink` exists but is dormant.

### Modules
- **`src/core/chunkSink.ts`** (pure, DOM-free, unit-tested):
  - `ChunkSink` — `write(chunk)` / `finish(): Blob` / `abort()` / optional `cleanup()`.
  - `MemSink` — the in-RAM fallback as a `ChunkSink`.
  - `DiskReassembler` — the streamed counterpart to `Reassembler`: a **synchronous** `add(i, chunk, atMs)`
    (drops into the sync receive handler unchanged) that enforces **sequential** order + the size bound and
    **enqueues** each chunk's async `sink.write()` on an internal promise chain. The sink is a
    `Promise<ChunkSink>`, so early chunks queue behind async creation. `assembleBlob()` awaits the chain then
    `sink.finish()`; a gap / over-size / post-failure chunk makes `add` return false (dropped).
  - `SINK_MAX_BYTES` — tiers `fsa` 50 GB / `opfs` 1 GB / `mem` 50 MB; `MAX_XFER_BYTES` = the fsa tier (the
    receive anti-DoS ceiling, a high sanity bound on the free-disk download tier); `WARN_BYTES` = 500 MB.
  - `chooseSinkKind(caps)` (fsa→opfs→mem) and `fitsTransfer(size, kind, est, factor=0.8)` — tier cap AND, for
    disk sinks, `size ≤ (quota − usage) × 0.8`.
- **`src/react/chunkSinkWeb.ts`** (browser, device-tested, not unit-tested):
  - `OpfsSink` — `navigator.storage.getDirectory()` → temp `xfer-<uuid>`, **async `createWritable`** (no
    Worker in Phase 1); `finish()` → `getFile()` (a disk-backed `File`); `abort()`/`cleanup()` → `removeEntry`.
  - `FsaSink` — `showSaveFilePicker` → `createWritable` (dormant; built for Phase 2).
  - `detectSinkCaps()`, `estimateStorage()`, `requestPersist()`, and `createReceiveSink({mime,name,prefer})`,
    which selects fsa→opfs→mem and **falls back to `MemSink` on any OPFS failure**.

### Receive flow (`useCall.ts` content-message handler)
- `xbegin`: `recvKind = canDisk ? 'opfs' : 'mem'`; `validateBegin(c, SINK_MAX_BYTES[recvKind])` (a no-OPFS
  receiver still hard-caps at 50 MB). Disk path → `new DiskReassembler(begin, sinkP, now)`, where `sinkP`
  first `estimateStorage()` + `fitsTransfer()` (reject ⇒ the line fails) then `createReceiveSink({prefer:'opfs'})`.
- `xchunk`: unchanged — `e.r.add(c.i, base64ToBytes(c.data), now)` + progress (works for both reassembler types).
- `xend`: `e.r instanceof DiskReassembler` ⇒ async — `URL.createObjectURL(await assembleBlob())`, register
  `cleanup()` keyed by that URL, mark the attachment `done`; else the unchanged in-RAM path. **The
  agent-perception base64 callback is skipped on the disk path** (re-reading a GB image into RAM would defeat it).
- `xcancel` and the 30 s stall reaper call `void e.r.abort()` for a `DiskReassembler` (frees the partial temp).

### Send flow
- `sendFile`: ≤50 MB or flag-off ⇒ today's `file.arrayBuffer()` → `sendContent` (unchanged). Else, per
  xfer-capable + perceive-granted peer, `sendFileStreamingTo`: `xbegin` then, per chunk,
  `file.slice(off, off+CHUNK).arrayBuffer()` (one chunk in heap) → base64 `xchunk` with `XFER_HIGH_WATER`
  backpressure → `xend`. **Send cap = 1 GB** (the OPFS tier). Local echo references the `File` directly
  (`URL.createObjectURL(file)` — disk-backed, no copy).
- **Channel:** content + chunk frames ride the dedicated `'bulk'` data connection, NOT the media-signaling
  `'sig'` link — so a big transfer can't head-of-line-block media recovery. `dataLinkOpen`/`dataBufferedAmount`
  reflect bulk, and a transfer waits for bulk-open before `xbegin` so its chunks never straddle the two
  channels. See `media-control-plane.md` §2.5.

### Memory-leak fixes that ride along (apply with the flag OFF too)
- `evictedBlobUrls(prev, next)` + a `[chat]` effect — revoke an attachment's blob URL the moment its line
  leaves the 50-line capped buffer (and on unmount); honours `Attachment.url`'s contract, which was never wired.
- `xferCleanupRef` — run an OPFS `cleanup()` right after its URL is revoked, so streamed temps don't pile up in
  origin storage across reloads.

### Caps as built
| Path | Cap |
|---|---|
| Receive, OPFS (flag on) | 1 GB, and ≤ free quota × 0.8 |
| Receive, no OPFS / flag off | 50 MB |
| Send (flag on, >50 MB) | 1 GB |
| `validateBegin` anti-DoS ceiling | the receiver's tier (50 MB or 1 GB) |

### Not in Phase 1 (deferred)
Binary frames (the wire is still **base64**), **resume**, streamed **SHA-256**, the FSA save-picker flow, the
OPFS **Worker + `createSyncAccessHandle`** write path, and raising the desktop cap to 2 GB. See §Phasing.

### Known iOS risk (the make-or-break)
`OpfsSink` uses **async `createWritable`**. If an iOS Safari version has OPFS but not `createWritable` (only
`createSyncAccessHandle` in a Worker), `createReceiveSink` catches it and **falls back to `MemSink` (50 MB)** —
graceful, but the large path won't engage there. The Worker path is the Phase-2 fix; the 2-device test
confirms which iOS does.

## Today — and why 50 MB

The chunking already exists and is sound: `xbegin → xchunk… → xend` over the reliable+ordered data mesh
(`contentXfer.ts`), 48 KB raw per chunk, base64-encoded, with send-side backpressure (`XFER_HIGH_WATER`,
`useCall.ts`). What buffers in RAM:

- **Send** (`sendContent`, `useCall.ts`): takes the whole file as one `Uint8Array` **and** pre-base64s every
  chunk into an array up front → ~2.3× the file size in heap before a byte leaves.
- **Receive** (`xend` handler, `useCall.ts`; `Reassembler`, `contentXfer.ts`): holds every chunk, then
  `assemble()`s one contiguous `Uint8Array`, then wraps it in a Blob → ~2–3× the file size in heap.

50 MB keeps the transient ~150 MB within the budget of the weakest target (iOS Safari, which kills tabs at
modest memory). It's the right number *for an in-RAM design*. Stream to disk and the number can move.

## The shape in one line

**Receiver writes each chunk straight to a disk-backed sink (never holding the whole file); sender reads each
chunk from the source File on demand.** Heap on both ends drops to ~one chunk. (Chunks travel as base64 in
Phase 1; binary frames are a Phase-2 wire change.)

## Storage matrix (receive sink)

Feature-detect, best-first; every tier degrades, never breaks:

| Tier | API | Reach | Bound |
|---|---|---|---|
| **A. Save-to-disk** | File System Access (`showSaveFilePicker` → `createWritable`) | Desktop Chromium | Free disk (effectively unbounded) |
| **A′. Streaming download** | Service-Worker `ReadableStream` → native download (StreamSaver pattern) | Desktop Chrome/Edge/Firefox | Free disk (effectively unbounded) — see [§Desktop unbounded](#desktop-unbounded-tier-the-toffeeshare-equivalent) |
| **B. Sandboxed disk** | OPFS (`navigator.storage.getDirectory()` → sync access handle in a Worker) | Chrome/Edge/Firefox **+ iOS Safari 15.2+** | Origin storage quota (~1 GB+, evictable) |
| **C. In-RAM (legacy)** | the current `Reassembler` | anywhere | 50 MB (unchanged) |

A/A′ are the unbounded **download** tiers (the file lands on the real filesystem, no quota) — they're how a
single-purpose tool like ToffeeShare reaches tens of GB. B is the cross-platform workhorse and the only path
that **renders inline / works on iPhone**. C remains the floor for ancient browsers and tiny payloads. Phase 1
ships **B + C**; A/A′ are Phase 2 (see below).

## Receive side

Replace the in-RAM `Reassembler` with a `ChunkSink` interface so the assembly target is data, not code:

```
interface ChunkSink {
  write(i: number, bytes: Uint8Array): Promise<void>   // append chunk i (channel is ordered → i is sequential)
  finish(): Promise<{ file: File | Blob }>              // a disk-backed File/Blob for render/download
  abort(): Promise<void>                                // discard on cancel/stall
}
```

- `OpfsSink` / `FsaSink` write to disk and never retain bytes; `MemSink` is today's behavior (the fallback).
- The data channel is **reliable + ordered**, so chunks arrive in sequence — the sink appends; no out-of-order
  slot array, no full-file buffer. (Keep a tiny reorder window only if a transport ever loses ordering.)
- On `finish()`, OPFS `getFile()` / FSA returns a **disk-backed** `File` — an object URL renders an image or
  drives a download without re-loading the whole thing into the heap.
- The `Attachment` chat item points at that object URL exactly as today; the revoke-on-eviction effect
  (already in place) frees it.

## Send side

`sendContent` takes a `File`/`Blob` instead of a fully-read `Uint8Array`, and the send loop reads each chunk
on demand:

```
for (let off = 0, i = 0; off < file.size; off += CHUNK_BYTES, i++) {
  const buf = await file.slice(off, off + CHUNK_BYTES).arrayBuffer()   // ~one chunk in heap
  await backpressure(peerId)                                            // existing XFER_HIGH_WATER wait
  mesh.sendBinary(peerId, frame(xid, i, buf))                          // binary, not base64
}
```

Sender heap drops from ~2.3× the file to ~one chunk. Backpressure (`XFER_HIGH_WATER`) is unchanged.

## Wire format

- **Binary chunk frames.** Move `xchunk` payloads from base64 JSON to binary data-channel messages: a small
  fixed header (`xid` + chunk index) + the raw bytes. ~25% fewer bytes, one fewer copy, less CPU each side.
  `xbegin`/`xend`/`xcancel` stay JSON (control). Gate behind a new feature tag (`xfer.v2`) so a peer that only
  speaks `xfer.v1` (base64) still interops via the existing fallback.
- **Integrity.** Add a `hash` (SHA-256, streamed) to `xbegin`; the receiver hashes as it writes and verifies
  on `finish()`. Today the transfer trusts order + size; at GB scale a corruption check is worth the cost.

## Max size policy

Not one constant — **adaptive, tiered, and guarded by real free space.** Headline max **2 GB**.

| Receive tier | Cap |
|---|---|
| A / A′ (FSA or SW-download, **desktop**) | `min(configured ceiling, free disk)` — the [desktop-unbounded tier](#desktop-unbounded-tier-the-toffeeshare-equivalent); Phase-2b, gated on resume |
| B (OPFS, incl. iOS) | 1 GB |
| C (in-RAM fallback) | 50 MB (unchanged — still heap-bound) |

On `xbegin`, **refuse up front** if the declared size won't fit: `navigator.storage.estimate()` →
reject when `size > (quota − usage) × 0.8`, with a clear "not enough space" message (never half-write then
fail). Warn the user above ~500 MB that it'll take minutes and (until resume lands) can't resume.

Why tiered, not one number: the **inline / iOS** path is genuinely bounded — OPFS quota is finite **and
evictable**, so B caps at 1 GB and that's honest about what an iPhone can do. The **desktop download** path
(A/A′) writes to the real filesystem with no quota, so its bound is your free disk — that's the
ToffeeShare-class "tens of GB" number, but it's a *download* (no inline preview) and wants **resume** before a
high ceiling is trustworthy (a dropped 20 GB transfer is hours wasted). Throughput is the real wall regardless:
direct P2P is tens of Mbps (less over TURN), so multi-GB is minutes-to-hours — a big ceiling should always come
with a frank time estimate.

## Resume — same-session (DONE, flag-gated `xferResumeOn()`, committed `3990b49`)

A disk-tier (OPFS/download) transfer that stalls is re-driven from where the receiver left off instead of
restarting. **Receiver-driven, ordered-stream model** (no per-chunk bitmap — the channel is ordered, so
"have" is a single count): the stall reaper, for a resumable incomplete transfer whose peer is still in the
roster, sends `xresume {id, have}` (the receiver's `DiskReassembler.received`) up to 3 times — a `STALL_MS`
window each — instead of failing. The sender **retains the source `File`** (`activeSendRef`, a disk-backed
handle — no RAM copy) until the receiver's `xack`, and answers `xresume` by re-streaming from `have`
(idempotent: `add()` drops any chunk index below the current position). On completion the receiver sends
`xack`, releasing the source.

Negotiated via a new **`xfer.resume`** feature tag (both sides must advertise it; otherwise a drop fails as
before). A **resumed** re-stream **omits the SHA-256** (the sender can't cheaply hash from a mid-offset), so
the receiver simply skips the integrity check when no hash is present; a transfer that never resumes keeps
full integrity. New protocol: `xresume {id, have}`, `xack {id}`; `DiskReassembler.received` getter. OFF by
default (`localStorage['kbz.xferResume']='1'`, both peers).

### What makes resume actually fire: the mesh self-heals the dropped link

Resume only matters if the data link comes BACK — and a transient send failure doesn't just stall a transfer,
it tears the whole link down. PeerJS closes the entire `DataConnection` when a single `dataChannel.send()`
throws ("Failure to send data", which a congested / **TURN-relayed** link raises) or an ICE blip hits. Two
problems followed, both fixed in the comms core (`mesh.ts` + `useCall.ts`) and guarded by `e2e/transfer-multi.mjs`:

1. **The mesh never re-dialled the dropped link.** `planRoster` skips a peer still in `dataDialled`, so a link
   that died mid-session stayed dead while the roster was unchanged → the transfer to that peer could never
   resume. Now, when a link we INITIATED (smaller peer id ⇒ in `dataDialled`) drops while the peer is still
   wanted, the mesh **re-dials** after an 800 ms backoff (`scheduleDataRedial`); the answerer side relies on the
   initiator's re-dial (glare rule). A clean roster-leave removes the peer from `dataDialled` first, so it does
   NOT re-dial. (`meshData.test.ts` covers both.)
2. **The sender's stream loop carried on past the drop.** It kept slicing chunks into the void and — once the
   mesh re-dialled mid-loop — pushed the file's TAIL plus a bogus `xend` over the fresh link; the receiver saw
   the gap and **failed immediately** (long before the 30 s reaper could resume it). Now the loop checks
   `mesh.dataLinkOpen(peerId)` before every chunk and before the `xend`, and **bails without an `xend`** the
   moment its link is down — leaving the receiver resumable so `xresume` recovers it cleanly.

**Fast resume — recover the instant the link returns, not 30 s later.** The mesh emits `onDataLinkOpen(peerId)`
whenever a data link (re)opens; `useCall` reacts by sending an immediate `xresume {have}` for any interrupted
incoming transfer from that peer (`nudgeResumeFrom`). So recovery happens within ~a second of the self-heal
re-dial instead of waiting the `STALL_MS` (30 s) reaper interval. The time-based reaper stays as the backstop
(and keeps the give-up budget); the fast path is idempotent (the sender drops chunks below the receiver's
position) and a no-op on the first connect / for non-resumable transfers.

Net effect for a file shared into a room with >2 people (the mesh fans it out N-1 times): a blip on ONE
recipient's link no longer costs them the file or strands the transfer — that link self-heals and resumes from
its position within ~a second, while the other recipients are unaffected. This was the "sent to only 1
recipient, failed at the end" field report.

## Throughput

Two send-side levers. NOTE on measuring: `e2e/transfer-multi.mjs`'s `2p-throughput` scenario reports receive
MB/s for a 64 MB loopback transfer, but loopback throughput here is **CPU/host-bound and very noisy**
(observed 10–24 MB/s for the *same* build depending on machine load) — useful as a correctness + rough-ceiling
smoke test, NOT for A/B'ing config deltas. The levers below are justified on principle, not a loopback number:

1. **In-flight window — `XFER_HIGH_WATER` (1MB → 4MB).** The backpressure loop pauses while the data channel's
   `bufferedAmount` exceeds this. On a **high-latency / relayed** link (the real-world slow case) a small window
   is itself the throughput cap: throughput ≤ `window / RTT` regardless of bandwidth — 1 MB at 100 ms RTT is
   only 10 MB/s. 4 MB lifts that ceiling 4×. Loopback (RTT≈0) is window-independent, so this can't slow it. Kept
   below PeerJS's 8 MB `MAX_BUFFERED_AMOUNT` so the bytes wait in the readable SCTP send buffer, not PeerJS's
   own unbounded internal queue. Costs up to 4 MB × (N-1 peers) of in-flight buffer.
2. **Slab reads — `XFER_READ_SLAB`.** The streaming path read one 48 KB chunk from the source `File` per wire
   frame (an async `slice().arrayBuffer()` each). It now reads in ~1.5 MB slabs (a whole multiple of
   `CHUNK_BYTES`) and emits the wire frames from the slab — ~32× fewer disk-read awaits, helping CPU/IO-bound
   devices. The wire unit (`CHUNK_BYTES`, the chunk index → disk offset) is unchanged, so the receiver is
   untouched and resume (`startChunk > 0`) still aligns to chunk boundaries.

NOT changed: the backpressure **poll interval** stayed 25 ms (a finer poll only spins the CPU without a clear
win). The loopback ceiling is CPU (PeerJS BinaryPack encode/decode + OPFS writes), not backpressure; lifting it
further (raw data-channel serialization to skip BinaryPack, OPFS `createSyncAccessHandle` in a Worker) is
deeper future work. The mesh also fans a file out N-1 times (no SFU), so per-receiver rate in a >2-person room
is inherently the sender's uplink split across recipients.

## Resume — cross-reload (DONE, same flag, committed `b760a16`)

The RECEIVER's tab reloading/crashing mid-download now continues instead of restarting. The OPFS bytes already
survive a reload; we persist tiny **metadata** to `localStorage` (`core/xferPersist.ts` — `savePartial`/
`loadPartials`/`deletePartial` over an injected `KV`, pure + tested: the sink file name, sender + transfer ids,
begin header), keyed by the (salted) room. On re-entering the room a restore effect (`useCall`) reopens each
OPFS file via `reopenOpfsSink` — which **truncates a half-written trailing chunk** to the last whole-chunk
boundary (`keepExistingData` + `truncate` + `seek`), derives `have = floor(size / CHUNK)`, recreates a
`DiskReassembler` positioned there (new `resume` ctor arg), renders a "resuming" chip, and asks the sender to
re-stream from `have`. The sender matches the retained source by **xid across the receiver's NEW peer id**
(`findSendKeyByXid`, pure + tested) and re-keys it. A file already fully on disk is just finalized. Records are
dropped on complete/fail/cancel/give-up.

**Inherent limit:** this is **receiver-reload, OPFS-tier only.** A browser can't persist a `File`/`Blob`
handle across a reload, so a **sender** that reloads loses the source and can't resume; and the **FSA download
tier**'s user-chosen file can't be reopened to append, so its big (>1 GB) transfers aren't cross-reload
resumable. Needs a **salted room** (a stable per-room persistence scope) + OPFS. Same flag as same-session
resume (`xferResumeOn()`), off by default.

**Still the device-test gate:** the live reload/reconnect behavior (the mesh re-establishing a dropped
`DataConnection`, the sender's `activeSend` surviving the receiver's leave/rejoin, the send loop's backpressure
under a real drop) is only provable on real devices — resume's proof is a real disconnect, not a unit test.

## iOS write() corruption fix + post-write integrity (DONE, committed `7d4ecf7` + `0565087`, LIVE)

Field-found on a real 922 MB iPhone receive: the file arrived **corrupt and 769,447 bytes too large** — every
48 KB chunk had kept its **41-byte `xfer.v2` frame header** on disk (`18767 chunks × 41`). Root cause:
`decodeChunkFrame` hands the payload on as a **sub-array VIEW** past the header (`buf.subarray(1+idLen+4)`), and
**iOS Safari's OPFS `FileSystemWritableFileStream.write(view)` ignores the view's `byteOffset`/`byteLength`** and
persists the whole backing `ArrayBuffer` (header + payload). Desktop Chromium honours the view, so the other
receiver was fine. The streamed SHA-256 **passed** because it hashes the correct in-memory view, not the bytes
written — so the corruption was **silent**.

- **Fix:** funnel every OPFS + FSA `write()` through a pure, tested `tightChunk()` (`core/chunkSink.ts`) that
  returns an offset-0, exact-length array (copying only a sub-view) — the on-disk bytes are then exactly the
  chunk on every platform.
- **Hardening:** on the OPFS path, re-hash the bytes **actually on disk** at `xend` (`sha256HexOfBlob` streams
  the disk-backed `File` through the incremental SHA-256, never holding a GB in RAM) against the sender's hash;
  a mismatch fails the transfer + frees the temp **before** delivery, closing the "in-flight hash matches but
  the sink wrote different bytes" blind spot. (FSA exempt — `finish()` returns an empty Blob; resume omits the
  hash, so it's skipped there.)
- **Device-verified** on a real 1 GB iPhone transfer ("worked very well").

## Cancel (both sides) + live sender progress (DONE, committed `ca03e7e`, flag-gated, NOT yet device-tested)

Two coupled gaps surfaced after the corruption fix shipped:

- **The sender's progress bar never moved.** A streamed send hard-set its echo `Attachment` to `state:'done'`
  the instant it kicked off (fire-and-forget — "we already hold the source File"). Now a streamed/offered send
  is a **live `'active'`** transfer: `sendFileStreamingTo` reports per-slab into a `sendProgRef`
  (`Map<xid, Map<peerId, frac>>`), the bar repaints at the **MIN across peers** (a broadcast tracks the slowest
  receiver, so 100% means *everyone* has it), and it flips to `'done'` only when every tracked peer hits 1.
  Pure helpers `minSendProgress` / `allSendsComplete` (`contentXfer.ts`) are unit-tested.
- **No way to cancel mid-transfer.** `cancelTransfer(xid)` is now **direction-agnostic** — one ✕ button on any
  `'active'` chip works whether this peer is sending or receiving:
  - *Sender:* flags the paced loop(s) to bail (each emits an `xcancel`) and retracts any pending pull-offer.
  - *Receiver:* sends `xcancel` to the sender, `abort()`s the `DiskReassembler` (frees the partial OPFS temp),
    and forgets the cross-reload record.
  - Both sides paint a new distinct **`'cancelled'`** attachment state (a stop, not an error).
  - The `xcancel` handler gained a **send-side branch**: a single receiver's cancel stops **only their** stream
    via a **per-peer cancel key** (`${peerId}/${xid}`, checked alongside the whole-`xid` key in all three send
    loops), so a broadcast keeps streaming to everyone else; if it was the last recipient the send is cancelled.
    Receiver-reload resume re-keys both the cancel flag and the progress entry to the new peer id.

**Device-test gate:** the `sendProgRef` wiring + `cancelTransfer` live across the PeerJS mesh aren't unit-covered
(stateful `useCall`); a 2-device run must confirm: sender bar climbs; sender-cancel stops + frees both ends;
one receiver's cancel in a 2-receiver broadcast leaves the other unaffected.

## Deferred (Phase 2b remaining)

- **Sender-reload** resume (needs FSA source-file re-pick — out of reach without a fresh user gesture).
- **Cross-reload for the FSA download tier** (can't reopen the user's file to append).
- The **OPFS Worker + `createSyncAccessHandle`** write path (iOS robustness).
- **A′ Service-Worker streaming download** (FSA's fallback for non-Chromium desktop).

## Privacy

Unchanged and load-bearing: content rides the **peer-to-peer DTLS data mesh** — no server stores or sees the
bytes (see `docs/threat-model.md`). Streaming to disk is a **local** change on each end; it does not route
content through any relay. The claim to re-verify at GB scale: that a host-relayed/`sendTo` path (if used)
never becomes a content relay for big transfers — keep large transfers on the direct mesh only, and fall back
to "can't send to that peer" rather than relaying, exactly as the legacy-peer path does today.

## iOS specifics

- **OPFS works** (Safari 15.2+) and is the path that makes phones first-class — but the quota is finite
  (~1 GB+, variable) and **the browser can evict it** under storage pressure. Call `navigator.storage.persist()`
  to request durability; treat eviction as a possible mid-transfer failure (Phase 2 resume mitigates).
- **No save-picker.** Handing a *finished* file to the iOS Files app is awkward — offer it via a download/share
  link from the OPFS object URL (the OS may re-materialize it). **Inline render** (image/video via the object
  URL) is the clean path and the common case.
- Sync access handles need a **Web Worker** (no sync FS on the main thread) — the `OpfsSink` runs there.

## Back-compat

- A peer without `xfer.v2` → send base64 `xfer.v1` (today's path), capped at 50 MB to that peer.
- A receiver without OPFS/FSA → `MemSink`, capped at 50 MB.
- So cross-version and old-browser transfers keep working; only a v2↔v2 pair on a disk-capable receiver gets
  the large path.

## Phasing

- **Phase 1 — DONE (committed, not deployed; behind `largeXferOn()`):** `ChunkSink` + `MemSink`/`OpfsSink`
  (+ dormant `FsaSink`) with feature detection; `DiskReassembler` streamed receive; lazy sender slicing; the
  `estimateStorage()` + `fitsTransfer()` guard; tiered caps (OPFS 1 GB receive, 1 GB send, 50 MB in-RAM
  fallback). Base64 stays on the wire. Pure parts unit-tested; **the 2-device + iPhone run is the remaining
  gate before the flag can default on.** See [§Implementation](#implementation-phase-1--as-built).
- **Phase 2a — binary frames: DONE (committed `4f28612`, flag-gated `xferV2On()`).** Chunk payloads go as
  raw binary mesh messages instead of base64 `xchunk`, negotiated via an `xfer.v2` feature tag (a v1-only peer
  still gets base64, both ways). `core/contentXfer.ts`: `encodeChunkFrame`/`decodeChunkFrame`
  (`[idLen:u8][id][i:u32 LE][bytes]`) + `asBytes`, pure + tested; `protocol` `xchunk` now carries
  `data?`(base64) OR `bytes?`(raw). `useCall`: a binary mesh message is normalized by `asBinaryChunk` into a
  synthetic `xchunk` so it runs the **same** roster-gate + capability + handler path (no ungated fast-path);
  `sendXferTo`/`sendFileStreamingTo` emit binary only to peers advertising `xfer.v2` **and** when our flag is
  on. **OFF by default** (`localStorage['kbz.xferV2']='1'`, both peers); a default build advertises only
  `xfer.v1` and is byte-for-byte the base64 path. The one unknown — does PeerJS deliver a sent `Uint8Array`
  back as a binary type — is what the 2-device test confirms before the flag can default on.
- **Phase 2b — SHA-256 integrity: DONE (committed `5e76918`, flag-gated `xferHashOn()`).** The sender puts a
  SHA-256 of the payload in `xend`; a receiver (with the flag) hashes the bytes as they arrive and **fails the
  transfer on mismatch** before delivering (freeing a disk temp), so a corrupt / truncated / disk-errored file
  is never handed over. `core/sha256.ts` is a pure **incremental** SHA-256 (FIPS 180-4) — Web Crypto's
  `digest` is one-shot, so a streamed file can't use it; tested vs the NIST vectors + a Web Crypto cross-check.
  Sender hashes one-shot (in-RAM `sendContent`) or incrementally (lazy `sendFileStreamingTo`); receiver hashes
  accepted chunks in order. **Integrity, NOT sender-auth.** Additive (old peers ignore `xend.hash`), OFF by
  default (`localStorage['kbz.xferHash']='1'`, both peers).
- **Phase 2b (rest) — TODO:** resume (xresume + persisted have-set); the OPFS Worker + `createSyncAccessHandle`
  write path; raise the OPFS/inline caps; and the **desktop-unbounded download tier** (next section).

> The `xfer.v2` / binary-frame back-compat below (and parts of the Storage matrix / Send / Wire-format
> sections) describe the **Phase-2** target. Phase 1 keeps `xfer.v1` base64 and selects OPFS-or-MEM only.

## Desktop unbounded tier (the ToffeeShare equivalent)

**Goal:** lift the desktop receive cap from "OPFS quota" to "**your free disk**" — tens of GB — by streaming a
large transfer **straight into the browser's native download** instead of an OPFS temp. This is exactly how a
single-purpose sender (ToffeeShare, wormhole) reaches 50 GB: nothing buffers, the receiver's act *is* a
download, and the OS writes to the real filesystem with no quota. The data channel was never the limit — only
what each end did with the bytes was. We already have the lazy sender + the `ChunkSink` seam; this adds a
download-backed sink. **Strictly additive: a new tier above OPFS, picked only for big transfers on desktop; the
OPFS/inline path (and iOS) are untouched.**

### Two mechanisms (feature-detected, best-first)
- **A — File System Access (`FsaSink`, already built, dormant).** `showSaveFilePicker()` → `createWritable()`
  → stream each chunk → `close()`. The cleanest path where supported (desktop Chromium). Bound = free disk. The
  only reason it's dormant in Phase 1 is UX: the save dialog must open from a **user gesture**, so it can't fire
  silently mid-chat on `xbegin` (see Integration).
- **A′ — Service-Worker streaming download (`SwDownloadSink`, the StreamSaver pattern), new.** For
  Firefox/older Chromium without a usable FSA save flow. A same-origin Service Worker (Kibitz already ships one
  for the PWA) intercepts a synthetic URL (e.g. `/_dl/<xid>`) and answers with a `Response` whose body is a
  `ReadableStream` we feed chunk-by-chunk via `postMessage`; the page triggers a normal navigation/`<a download>`
  to that URL, so the **browser's own download manager** consumes the stream to disk. Bound = free disk. No
  third-party iframe (classic StreamSaver's MITM hack is unnecessary on our own origin + SW). Requires HTTPS +
  an active SW; falls back to FSA→OPFS if either is missing.

### Integration (where it differs from Phase 1)
- **It's a download, not an inline render.** A→disk / A′→download manager means there's **no object URL to
  preview** — the chat line shows a "Saved to <name>" / "Downloading…" chip, not a thumbnail. So the tier is
  chosen by **kind + size + intent**, not blindly: images stay on the OPFS/inline path; a **file** (or an
  image above a "too big to preview" threshold, e.g. > the OPFS tier) routes to the download tier.
- **User-gesture problem.** FSA's picker (and a clean SW download) want a gesture. Options, simplest first:
  (1) the **receiver** clicks an "Accept large file → choose where to save" button on the incoming `xbegin`
  placeholder (also a nice consent point for a multi-GB transfer); the click opens the picker, then chunks
  stream into the chosen `FsaSink`/`SwDownloadSink`. (2) A pre-armed per-room "auto-save big files to Downloads"
  toggle. Phase 1's silent OPFS path needs no gesture, so this only applies to the new tier.
- **`ChunkSink` already fits.** `FsaSink` is the contract as-is. `SwDownloadSink` is one more `ChunkSink`
  (`write`→`postMessage(chunk)`, `finish`→close the stream, `abort`→error it). `createReceiveSink` gains the
  A′ branch and a `prefer:'download'`/threshold input. **`DiskReassembler`, the wire, send side, integrity,
  resume — all unchanged** (they only know the `ChunkSink` interface).
- **Caps.** With the download tier active, the desktop receive cap becomes `min(configured ceiling, free disk)`
  — set the ceiling high (e.g. 20–50 GB) rather than literally unbounded, so a typo or hostile `xbegin` can't
  ask to write a petabyte. OPFS stays 1 GB; **iOS stays OPFS-only (~1 GB)** — Safari gives a PWA no quota-free
  streamed save, so iOS can't reach this tier (neither can ToffeeShare on an iPhone). Send cap rises to match.

### Honest trade-offs
- **Desktop-only.** This does not help iOS; the iPhone ceiling stays the OPFS quota. Be honest in the UI about
  which device gets what.
- **Download, not preview.** Big files arrive as a saved download, not an inline thumbnail — the right model
  for multi-GB, but a behavior change worth a clear chip/label.
- **No resume yet.** At 20 GB a dropped link is very expensive — this tier wants **resume** (the other Phase-2b
  item) far more than the 1 GB tier does. Recommended order: land resume first, *then* raise the ceiling here.
- **SW plumbing.** A′ adds a Service-Worker message channel + a synthetic download route to the SW (kibitz's SW
  is injectManifest-generated — the route handler lives in our SW source). FSA-only (A) avoids that entirely
  where it's available, so build A first and add A′ only for the browsers that need it.
- **Throughput is the real wall.** Even direct P2P is tens of Mbps; 50 GB is ~hours. The cap can say "yes" long
  before the network makes it pleasant — pair a big ceiling with a frank time estimate.

### Build order (within Phase 2b)
1. Activate **A (FSA)** behind a receiver "choose where to save" gesture on the `xbegin` placeholder; route
   files > the OPFS tier to it; raise the desktop file cap to the configured ceiling. (Small — `FsaSink` exists.)
2. Add **resume** (so a multi-GB download survives a blip) — prerequisite for trusting a high ceiling.
3. Add **A′ (SW streaming download)** for non-FSA desktop browsers. (Largest — SW route + stream plumbing.)

## Testing

- **Unit (pure):** `ChunkSink` contract against a fake (write/finish/abort, byte-exact reassembly); the
  size-vs-quota guard; `validateBegin` at the new caps; the v1/v2 + OPFS/no-OPFS fallback selection.
- **2-device (mandatory, per project discipline):** a ~1 GB file desktop↔desktop (FSA) and desktop↔iPhone
  (OPFS) — byte-identical on arrival (hash), heap stays flat (DevTools memory), progress + cancel work, and a
  mid-transfer disconnect fails cleanly (Phase 1) / resumes (Phase 2).
- **Memory regression:** confirm a 1 GB transfer no longer grows the tab toward a crash on either end.

## Risks

- **iOS OPFS** is the highest-risk surface (quota, eviction, the Files hand-off) — prove it on a real device
  before believing it; this is where these features usually quietly break.
- **No resume in Phase 1** — a dropped large transfer restarts; the 2 GB cap + the >500 MB warning keep the
  cost bounded until Phase 2.
- **Shared engine** — lands on every app built on Kibitz, so the fallbacks must be airtight and the 2-device
  matrix run before shipping.

## Status

**Phase 1 + Phase 2a (binary frames) + Phase 2b SHA-256 integrity implemented + unit-tested, COMMITTED, NOT
deployed** — Phase 1 `b307b9c`/`9024dd4`/`daffc14`, Phase 2a `4f28612`, Phase 2b integrity `5e76918`, docs
`c7c1f86`/`9f73f79`/`87bbe17`. Three independent off-by-default flags: `largeXferOn()` (`kbz.largeXfer`,
stream-to-disk), `xferV2On()` (`kbz.xferV2`, binary frames), `xferHashOn()` (`kbz.xferHash`, integrity); a
default build is byte-for-byte today's in-RAM base64 path. Remaining gates before the flags default on: the
**2-device + iPhone test** — for Phase 1 the iOS `createWritable` question, for Phase 2a whether PeerJS
delivers a sent `Uint8Array` back as binary (integrity has no such unknown — it's pure + NIST-verified). Not
yet in the published `/docs` set (`scripts/render-docs.mjs`). **The desktop-unbounded download tier (FSA pull
handshake) is now BUILT** (committed `129ac11`, flag-gated): `>1GB` files stream to a chosen disk file via an
`xbegin{offer}` → `xaccept` handshake (`xfer.dl` feature tag), raising the desktop cap to a 50 GB sanity
ceiling; iOS stays OPFS (~1 GB). **Same-session resume is now BUILT too** (committed `3990b49`, flag-gated
`xferResumeOn()`): a stalled disk-tier transfer is re-driven from the receiver's position via `xresume`/`xack`
(the `xfer.resume` tag), retaining the source until acked. **Cross-reload resume is also BUILT** (committed
`b760a16`): a reloaded receiver continues an OPFS download (persisted metadata + `reopenOpfsSink` truncate/
append + match-by-xid) — receiver-reload, OPFS-tier, salted-room only. Phase 2b remaining — **sender-reload**
resume, **FSA-tier** cross-reload, the **OPFS Worker** path, and the **A′ Service-Worker streaming download** —
is designed, not built. **The flags were flipped DEFAULT-ON** (`xferFlagOn`, opt-out via `'kbz.<flag>'='0'`)
at the product owner's direction.

**⚠️ Now SHIPPED — the whole stack is LIVE on kibitz.chat + branded siblings** (the product owner pushed
`main`). The **iOS write()-byteOffset corruption fix + post-write disk integrity** (`7d4ecf7`/`0565087`) is
**device-verified** on a real 1 GB iPhone transfer. The newest delta — **cancel (both sides) + live sender
progress** (`ca03e7e`) — is committed and rides the same default-on flags but is **not yet device-tested**; a
failing path is still killed per-device with `localStorage['kbz.<flag>']='0'`, or revert the default in
`xferFlagOn`. The full 2-device + iPhone runbook (`docs/large-transfer-test.md`) plus the cancel/progress
checks above remain the standing gate for any further large-transfer change.
