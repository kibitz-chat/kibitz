# Chat Ledger (design)

> Status: **proposal — partly built but parked.** The model below is implemented behind the now-PARKED
> `ROOM_SYNC_V2` flag (`src/react/chatLedger.ts`, `src/react/ledgerSnapshot.ts`, `src/core/blobStore.ts` all
> exist; default OFF — `ROOM_SYNC_V2_DEFAULT_ON = false`). See [unified-room-sync.md](./unified-room-sync.md)
> for the live status; the proposal body below is unchanged. It captures the model we're moving to and why, and
> touches the most battle-tested part of the engine (the reconciliation seam + the agent's persistence), so we
> locked the shape here before code.
>
> See also: [architecture.md](./architecture.md), [agent-platform.md](./agent-platform.md). The Kibitz agent
> side (memory, rehydration, perception) lives in `~/kibitz/agent`.

## 1. The problem it fixes

Today there is **no authoritative chat object**. The "chat" exists only as each participant's ephemeral,
in-memory buffer. To make it survive everyone leaving a room, we bolted durability onto the **agent's**
memory (`sessionStore` → sealed S3), and on resume the agent **re-seeds** its recovered memory back into the
chat. That memory also holds the agent's **canvas** (the image bytes it needs to `edit_image`). So two things
that should be orthogonal — *the shared conversation* and *the agent's private working images* — live in one
bag.

The concrete bug that falls out of this (confirmed from a real staging memory): the agent's produced painting
and a user's "uploaded" image had **byte-identical** content. The media-sync re-transferred the agent's own
painting back to it, the agent **re-perceived its own image as a new shared upload**, and that clobbered the
real upload. Perception (an image arriving to act on) and ledger sync (converging the shared union) were the
same code path.

The fix is architectural, not a patch: **make the chat a first-class object, and keep paint out of it.**

## 2. The model

**The chat ledger is the best-effort convergent UNION of every participant's held chat — the agent included —
which feeds back to every participant.** It is not a server object and not strongly consistent. It is exactly
the CRDT-ish union the sync family already computes, now named and made first-class.

- **Items** are append-only records: `{ id, ts, author, kind, ... }`, `kind ∈ { text, image-ref, file-ref,
  widget }`. `id` is the stable merge key (today's `mid` / widget id); `ts` is the order key; `author` is the
  original poster (display-only, unverified — a verified ✓ is bound to a live cert, never to a ledger entry).
- **Convergence** is by `id` (dedup) + `ts` (order) — today's `mergeChat`. Appending is commutative and
  idempotent; re-delivering a known `id` is a no-op.
- **Feedback loop:** each participant holds its view of the union; on every roster change each re-broadcasts
  the *whole held union* (not just its own lines), and each peer merges. Content therefore survives its
  author leaving as long as *someone* still holds it. This is `useChatSync` (text) + `useMediaSync` (media) +
  `useWidgetSync` (widgets) over the `onRosterChange` seam — unchanged in spirit.
- **The agent is just another participant.** It contributes its lines to the union and converges toward it
  like anyone else. It has no privileged "chat memory."

**Best-effort is a feature, not a gap.** No global lock, no authority, no ordering guarantee beyond `ts`. A
partition heals when peers reconnect and re-broadcast. We never block a call on ledger consistency.

## 3. Paint is NOT the ledger (the key separation)

Images and files in the ledger are **references**, never bytes:

```
image-ref:  { id, ts, author, kind:'image-ref', hash, mime, w, h, name?, thumb? }
```

- `hash` is the content address (sha-256 of the bytes). `thumb` is an optional tiny inline preview.
- **Bytes travel separately** over the existing media xfer, and live in a **content-addressed cache** keyed by
  `hash`. Receiving the bytes populates the cache; it does **not** create or mutate a ledger item.
- **The agent's canvas is a private editing cache**, keyed by the same `hash`. "I hold these bytes so I can
  `edit_image`" is a cache concern — it has nothing to do with the chat's identity. The agent never
  re-injects its canvas as chat history.

Why this kills the bug **by construction**: a produced painting is *one* ledger entry (`image-ref`,
author=agent, `hash=H`). When the media-sync feeds those bytes back to the agent, the agent just re-warms its
cache for `H` — there is no second ledger item (dedup by `id`), and there is no "perception" (see §4). One
picture, one entry, one author, forever.

## 4. Perception ≠ ledger sync (the discipline that fixes it)

The agent does two unrelated things with an incoming image; today they're the same handler:

- **Ledger sync:** the union feeds the agent images it already knows (including its own, fed back). This must
  only warm the byte-cache for `hash` and converge the ledger by `id`. It is **never** a new perception.
- **Perception:** a *genuinely new* image a human posts, that the agent may be asked to act on. This is a new
  ledger `image-ref` (new `id`, new `hash` the agent hasn't seen) authored by a human.

Rule: **the agent perceives an image only on a ledger append it hasn't seen (`id` new AND `hash` new),
authored by someone else.** A fed-back image (`id` or `hash` already held, or authored by self) warms the
cache and stops. That single distinction removes the self-perception loop.

## 5. Durability (best-effort)

The union lives in the RAM of present participants. When the room empties it's gone — unless someone
**persists a snapshot** and re-contributes it on return. Persistence is **best-effort and optional**, and it
comes in **three layers** — you get whichever the room qualifies for, and it degrades gracefully:

- **Layer 1 — base P2P (no durable member).** Held only by present peers; when everyone leaves, history is
  lost. Acceptable and honest — a pure serverless room keeps nothing after it empties.
- **Layer 2 — agent rooms (the agent persists). ← we build this first.** The agent is the natural writer: it
  has S3 and is the long-lived member. It persists *the ledger snapshot* (not its canvas) on change/leave, and
  on (re)join it loads the snapshot and **contributes it into the union like any other held view** — no
  bespoke "re-seed." Covers the common Kibitz case: leave → return → the agent brings the conversation back.
- **Layer 3 — witz.chat managed accounts (a managed blob store).** A managed account already implies a server
  relationship, so here the control-plane offers an **operator-blind, `hash`/`room`-addressed sealed blob
  store** any member may write. This survives even **human-only** and **cross-device** cases (no agent
  required), because the durable member is the (blind) service. Later work.

All layers seal the snapshot with the room key `mk` (today's `envelope.mjs`) and store it **room-scoped**
(`ledger/<room>.json`), not agent-scoped. Refs + text + thumbs are tiny; **bytes are NOT in the snapshot** —
they re-flow via xfer / cache on demand (a returning peer pulls bytes for the refs it wants to render, from
whoever holds them, or from the Layer-3 blob store when present).

This replaces `sessionStore`'s agent-memory rehydration: the durable thing is *the ledger*, contributed
through the *same* union path everyone uses. The agent's `events`/`canvas` memory stays only for what it's
actually for — the brain's continuity and the editing cache.

## 6. What we reuse vs. change

**Reuse (≈80% exists):** `mergeChat` (ordered union, dedup by id), the `onRosterChange` re-broadcast seam,
`useChatSync` / `useMediaSync` / `useWidgetSync`, the sealed `envelope`, the chunked media xfer.

**Change:**
- Promote the in-memory buffer to a named **ledger** with an explicit item schema; images/files become
  **refs**, bytes move to a **`hash`-keyed cache** (the byte side of `useMediaSync` becomes "fetch/serve bytes
  for a ref", decoupled from the ledger item).
- **Snapshot persistence** (sealed, room-scoped, best-effort), contributed back through the union path.
- **Delete the agent's chat rehydration-seed** (`seedChatHistory` re-injection from canvas). The returning
  agent/peer just reconciles the union + loads the snapshot.
- **Split perception from ledger sync** in the agent (§4): warm-cache-only for known/own images; perceive only
  new-from-others.

## 7. Open decisions

1. ~~Who persists when the room empties~~ — **RESOLVED (§5): layered.** Agent rooms → the agent (Layer 2, build
   first); witz.chat managed accounts → an operator-blind managed blob store (Layer 3, later); pure P2P keeps
   nothing (Layer 1).
2. **Byte availability after everyone left** — refs in a restored snapshot point at bytes no present peer
   holds. Options: a content-addressed blob store (sealed, `hash`-keyed), agent-held cache, or "thumb-only
   until someone re-posts." Best-effort means degrading to the thumb is allowed.
3. **Ref schema + cache eviction** — thumb size, cache bounds (mirror `MEDIA_REPLAY_MAX_*`), GC by `hash`.
4. **Snapshot cadence** — on-leave only, debounced-on-change, or periodic; and the size cap (mirror
   `CHAT_KEEP`).

## 8. Migration sketch

1. Introduce the ledger item schema + the `hash`-keyed byte cache behind the existing buffer (no behavior
   change): images gain a `hash`; bytes cache by `hash`.
2. Split perception from ledger sync in the agent (§4) — this alone fixes the reported bug.
3. Add sealed room-scoped snapshot persistence (best-effort), contributed via the union path.
4. Remove the agent-memory chat rehydration-seed; keep the agent's canvas as a pure editing cache.
5. Validate with the existing local e2e (`~/kibitz/e2e/resume-rehydrate.mjs`) extended to assert: a produced
   image is never re-perceived, and a real upload survives a resume with its own bytes + author.
