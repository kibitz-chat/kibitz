# Room state — a replicated, signed, peer-held ledger

**Status: built (steps 1–4); signing + anti-entropy (steps 5–6) remain design.** The ledger core
(`roomLedger.ts` CRDT — owned LWW + attested OR-set), the sync layer (`roomLedgerSync.ts`, `request`/`state`/`update`
over `~kbz.ledger`), and local persistence (`roomLedgerStore.ts`, `localStorage`) all ship, and the first consumer —
the agent-resumable `agentSeen` attestation (unsigned tier) — is wired in `useAgentPresence.ts` and drives the summon
banner. A general primitive: small, durable-ish **room state** that lives in the
participants' browsers and syncs over the existing P2P mesh — **no server ever sees it.** Its first consumer
is the agent "resumable?" hint (so a re-summon label survives a browser switch without anyone phoning the
agent platform), but it is built as a general layer.

## The concept

A room carries a little **shared ledger** — a small map of keys to values that every participant replicates.
It rides the **E2EE data channel** we already have, each browser **persists it locally**, updates are
**signed** so a peer can't forge them, and a fresh joiner **pulls the current state from whoever still has
it.** No server, no platform contact — the room's own participants are the store.

One line: *room state is replicated peer-to-peer, signed, and held in the participants' browsers; it survives
as long as one participant who has it is still around.*

## Why

- **Server-less + private.** It syncs over the data channel that already carries chat / co-browse — the
  platform (and any agent platform such as a brand's control plane) is never contacted to read or write it.
  This is the property that let us drop the "every participant POSTs `resumable?` to the platform on join"
  design, which would have pulled every participant into a connection they never asked for.
- **Self-healing across reloads and device switches.** A participant who reloads or switches browsers loses
  their local copy, rejoins, and **re-syncs from any peer that still has it.** So state survives a browser
  switch as long as **≥1 participant retained it and is online to re-share.** (It is enough that *one*
  participant didn't switch.)
- **General.** The agent-resumable hint is one key; the presence of co-created artifacts, a shared scratch
  value, "who is the declared host", a poll result, etc. can all ride the same layer.

## The inherent limit (state it plainly)

It is **peer-held**, so a **fully cold room** — everyone gone or all switched at once, with nobody present who
has the ledger — has **no one to seed from**, and that state is lost. This is the price of staying off a
server, and we accept it: the only cure is a server copy, which is exactly what we are keeping out of the
participants' path. (An agent's *real* memory may still live on the brand's server for the cold case, but it
is fetched only on the creator's explicit summon tap — never automatically, never by other participants.)

## Data model

A map `key → entry`, where an `entry` is `{ value, author, seq | ts, expireAt, sig }`. Merge is a **CRDT** so
concurrent writers converge without coordination. Two entry classes cover what we need:

- **Owned key (single writer):** written only by a designated author (e.g. the room **host key**).
  Last-writer-wins by the author's monotonic **seq** — *not* wall-clock, because clock skew or a forged
  future timestamp would otherwise let a peer "win". Only the author's signature is accepted. Use for
  authoritative room config / state.
- **Attested key (many writers):** an **OR-set** of signed attestations — *"author A asserts fact F, expires
  at T."* Consumers decide how many / which authors they trust. Use for facts any participant can contribute.
  **The resumable hint lives here:** any participant who *saw* the agent attests `agentSeen[agentId]`.

Values are **small metadata only** — flags, ids, short strings, counters. Never media or bulk data (those stay
on the existing transfer / server paths). The ledger is size-capped.

Each key also declares a **consistency model** — *monotonic / OR-set* (multiplicity is normal: many peers
asserting the same/compatible value, like `agentSeen`) or *single-valued / owned* (any divergence is a
contradiction). The contradiction detector below acts only on single-valued/owned keys.

## Certified

Every entry is **signed**, so a relaying peer cannot forge or alter another's entry without breaking the
signature.

- **Signing keys (both already in kibitz):** the **room host key** (committed in the link, used today for the
  authority gate — see `docs/cert-binding.md`) signs owned keys; a **verified-identity** participant signs
  their attestations with the same cert-bound / OIDC-bound key the room already verifies
  (`docs/verification.md`).
- **Verification:** a consumer checks each entry's signature against the claimed author's public key — the
  host pubkey from the link, a participant's pubkey from their verified identity on the roster.
- **Unsigned tier:** explicitly low-stakes keys (the resumable hint qualifies — worst case a forged
  `resumable:true` makes the user tap summon and the agent simply starts fresh) may be accepted unsigned, and
  are flagged as such. Anything that drives a security / trust decision must be signed.
- **What signing does and doesn't stop:** a peer **cannot fabricate or tamper** (the sig breaks). A peer
  **can withhold** (omission) or **replay** an old signed entry — both bounded by syncing from multiple peers
  and by the seq / TTL merge ignoring stale entries.

## Sync protocol (over the data channel)

Rides the reserved `~kbz.ledger` app-message namespace (the same seam as feature negotiation / schema
discovery), so it never collides with app traffic. The built ops (`roomLedgerSync.ts`) are `request` / `state`
/ `update`:

1. **On join:** broadcast `request` — a "who has the ledger?" ping. (The compact **digest** / version-vector
   of what you hold is the unbuilt anti-entropy optimization below, not the built request.)
2. **Peers reply** with `state` — a **full snapshot** of the ledger (the built path sends the whole state, not
   a computed delta).
3. **On any local change:** broadcast `update` — the single changed key; peers merge and re-persist. (The
   holder also re-pushes a full `state` snapshot on each roster change, `useCall.ts`.)
4. **Anti-entropy (optional hardening — step 6, unbuilt):** periodic digest exchange to heal updates missed
   during a netsplit.

The roster / authority already tells everyone who is present, so the join handshake has peers to ask.

## Persist + GC

- Each browser stores the ledger in **localStorage**, keyed by room id (behind a pluggable async KV, so an
  IndexedDB backend can drop in unchanged if room state ever outgrows it — `roomLedgerStore.ts`); per-entry
  **`expireAt`** (the N-day idea, client-side). On load, drop expired entries.
- **End / delete** writes a signed **tombstone** (for an OR-set, into the remove-set) so the deletion
  propagates rather than resurrecting from a peer.
- The whole room ledger is dropped once its newest entry is past TTL. Size-bounded.

## Worked example — the agent "resumable?" hint

1. While an agent peer is in the call, each witness writes an attestation `agentSeen[agentId] = true` into the
   **attested** namespace, `expireAt = now + N days` (signed by their verified identity, or unsigned
   low-trust).
2. The summon banner reads the ledger: `agentSeen` present → **"bring it back"** (re-summon, resumes); absent
   → **"Summon"** (fresh).
3. A participant who **switched browsers** rejoins → `state-request` → a peer re-seeds the ledger → they see
   `agentSeen` → correct label, **with no platform contact.**
4. **"End the agent"** writes a tombstone → all peers drop it → the label reverts to "Summon".

This replaces the per-device `localStorage` flag (which works only on your own device) with a peer-shared one
(works for anyone who was there) — and it stays entirely off the brand's server, unlike the rejected
`resumable?` endpoint.

## Reuse / building blocks (mostly exist)

The **E2EE data channel** + the reserved `~kbz` app-message namespace · the **roster / authority broadcast**
(who to sync from) · the **host key** (signing owned keys — `docs/cert-binding.md`) · **verified identity**
(signing attestations — `docs/verification.md`) · app-message **schema discovery** (typing the ledger ops).

## API sketch

```
room.state.get(key)                     // current merged value
room.state.set(key, value, { sign })    // write an owned key (host)
room.state.attest(key, fact, { ttl })   // contribute an attestation
room.state.end(key)                     // signed tombstone
room.state.on('change', (key) => …)     // subscribe
useRoomState(key)                       // React hook over the above
```

## Build order

1. **Ledger core** — data model + merge (LWW-register for owned keys, OR-set for attested), in-memory, with
   tests. No network.
2. **Sync** — `request` / `state` / `update` over the `~kbz.ledger` channel + the join handshake.
3. **Persistence** — `localStorage` store, `expireAt`, GC on load.
4. **First consumer** — the `agentSeen` attestation + wire the summon banner to read the ledger (replaces the
   v1 `localStorage` flag). Ship; it is independently useful.
5. **Certified** — signing / verification (host key + verified identity); start the resumable hint unsigned,
   add signatures as the trust tiers land.
6. **Anti-entropy** — digest reconciliation (hardening).

## Open decisions

- **CRDT:** hand-rolled LWW-register + OR-set (light, covers flags / sets) vs adopting **Yjs / Automerge**
  (richer, heavier bundle) if room state grows beyond metadata.
- **Default trust:** unsigned for low-stakes keys vs always-signed.
- **Owned-key replay defense:** monotonic **seq** per author (vs trusting timestamps).
- **TTL default (N)** and whether it is per-key.
- **Eclipse posture:** a lone present peer can hand a fresh joiner a stale / partial (but un-forgeable) view;
  do we require ≥k corroborating peers for attested keys before trusting, when available?
- **Size bound** + what is allowed in the ledger (metadata only — enforce).

## Security / threat notes

- **Forge / tamper:** prevented by per-entry signatures (for the signed tiers).
- **Omission / eclipse:** a malicious relay / peer can withhold; mitigated by syncing from multiple peers +
  anti-entropy. A *sole* present peer is a trusted-ish seed for un-forgeable entries (it can drop but not
  fabricate).
- **Replay:** bounded by seq (owned) / TTL + OR-set semantics (attested).
- **Privacy:** room-scoped, E2EE in flight, local at rest; no server. Do not place secrets / PII beyond what
  the room already shares. See `docs/threat-model.md`.
