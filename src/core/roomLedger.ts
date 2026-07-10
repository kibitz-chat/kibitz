// Room-state ledger — the in-memory CRDT core (docs/room-state-ledger.md, build step 1).
//
// A small replicated map of `key → entry` that every participant holds. Two entry classes, both conflict-free
// so peers converge regardless of the order they see updates (the merge is commutative, associative, and
// idempotent — see roomLedger.test.ts):
//
//   • OWNED  — a single-writer last-writer-wins register. Written only by one author (e.g. the room host
//              key); the higher monotonic `seq` wins (NOT wall-clock — clock skew / a forged future time must
//              not let a peer win), ties broken by author id so the result is deterministic.
//   • ATTESTED — an OR-set: many participants each ASSERT a fact ("author A saw the agent"), each tagged with
//              a unique id; a retract drops observed ids. The merged value is the set of LIVE attestations
//              (id present, not retracted, not expired) — e.g. "any live attestation" → the resumable hint.
//
// This file is PURE (no network, no signing, no persistence) so the convergence laws can be unit-tested in
// isolation. Signing/verification (cert-binding / verified identity), the sync protocol over the `~kbz`
// channel, and IndexedDB persistence wrap this core in later steps.

export type OwnedEntry = { kind: 'owned'; value: unknown; author: string; seq: number; expireAt: number }
/** One participant's assertion of a fact under an attested key. `id` is globally unique (so two peers' adds
 *  never collide and a retract can target an exact add). */
export type Attestation = { id: string; author: string; value: unknown; expireAt: number }
export type AttestedEntry = { kind: 'attested'; adds: Attestation[]; removes: string[] /* retracted add ids */ }
export type Entry = OwnedEntry | AttestedEntry
export type LedgerState = Record<string, Entry>

const byId = (xs: Attestation[]): Attestation[] => {
  const m = new Map<string, Attestation>()
  for (const a of xs) m.set(a.id, a) // same id → identical content by construction; last wins harmlessly
  return [...m.values()]
}
const uniq = (xs: string[]): string[] => [...new Set(xs)]

/** Merge two OWNED registers: higher seq wins; tie → higher author id (deterministic, so it's commutative). */
export function mergeOwned(a: OwnedEntry, b: OwnedEntry): OwnedEntry {
  if (a.seq !== b.seq) return a.seq > b.seq ? a : b
  return a.author >= b.author ? a : b
}

/** Merge two ATTESTED OR-sets: union the adds (by id) and the retracted ids. */
export function mergeAttested(a: AttestedEntry, b: AttestedEntry): AttestedEntry {
  return { kind: 'attested', adds: byId([...a.adds, ...b.adds]), removes: uniq([...a.removes, ...b.removes]) }
}

/** Merge one key's entry from two replicas. A kind mismatch (shouldn't happen for a consistently-typed key)
 *  resolves to OWNED deterministically, keeping the merge commutative. */
export function mergeEntry(a: Entry | undefined, b: Entry | undefined): Entry | undefined {
  if (!a) return b
  if (!b) return a
  if (a.kind === 'owned' && b.kind === 'owned') return mergeOwned(a, b)
  if (a.kind === 'attested' && b.kind === 'attested') return mergeAttested(a, b)
  return a.kind === 'owned' ? a : b
}

/** Merge two whole ledgers, key by key. */
export function mergeLedger(a: LedgerState, b: LedgerState): LedgerState {
  const out: LedgerState = { ...a }
  for (const k of Object.keys(b)) out[k] = mergeEntry(out[k], b[k]) as Entry
  return out
}

/** The live attestations under an attested key: present id, not retracted, not expired. */
export function liveAttestations(e: AttestedEntry, now: number): Attestation[] {
  const removed = new Set(e.removes)
  return e.adds.filter((a) => !removed.has(a.id) && a.expireAt > now)
}

/** Drop expired adds, then drop retract-tombstones whose add is gone (nothing to suppress → no resurrection),
 *  and drop owned registers whose value has expired. Returns null when the whole entry is empty/expired. */
export function gcEntry(e: Entry, now: number): Entry | null {
  if (e.kind === 'owned') return e.expireAt > now ? e : null
  const adds = e.adds.filter((a) => a.expireAt > now)
  if (adds.length === 0) return null
  const liveIds = new Set(adds.map((a) => a.id))
  return { kind: 'attested', adds, removes: e.removes.filter((id) => liveIds.has(id)) }
}

/** GC a whole ledger; drops keys that became empty. */
export function gcLedger(s: LedgerState, now: number): LedgerState {
  const out: LedgerState = {}
  for (const k of Object.keys(s)) {
    const e = gcEntry(s[k], now)
    if (e) out[k] = e
  }
  return out
}

let idCounter = 0
/** A process-unique attestation id (author-scoped + counter + random so it never collides across peers). */
const newId = (author: string): string => {
  let rnd = ''
  try {
    rnd = (globalThis.crypto as Crypto | undefined)?.randomUUID?.() ?? ''
  } catch {
    /* no webcrypto */
  }
  if (!rnd) rnd = Math.random().toString(36).slice(2)
  return `${author}:${++idCounter}:${rnd}`
}

/** A thin stateful wrapper over the pure core: write owned/attested entries, read live values, merge incoming
 *  deltas, GC, and subscribe to changes. The sync + persistence layers drive merge()/snapshot(). */
export class RoomLedger {
  private state: LedgerState = {}
  private listeners = new Set<(key: string) => void>()

  /** Write an OWNED key (caller is the single authorized author; `seq` must increase per author). */
  setOwned(key: string, value: unknown, opts: { author: string; seq: number; expireAt: number }): void {
    this.apply(key, { kind: 'owned', value, author: opts.author, seq: opts.seq, expireAt: opts.expireAt })
  }

  /** Contribute an ATTESTATION under a key (an OR-set add). Returns the new attestation id (to retract later). */
  attest(key: string, value: unknown, opts: { author: string; expireAt: number; id?: string }): string {
    const id = opts.id ?? newId(opts.author)
    const add: Attestation = { id, author: opts.author, value, expireAt: opts.expireAt }
    const prev = this.state[key]
    const base: AttestedEntry = prev && prev.kind === 'attested' ? prev : { kind: 'attested', adds: [], removes: [] }
    this.apply(key, mergeAttested(base, { kind: 'attested', adds: [add], removes: [] }))
    return id
  }

  /** Retract attestation ids under a key (an OR-set remove → a tombstone). Use to "end" a fact you observed. */
  retract(key: string, ids: string[]): void {
    const prev = this.state[key]
    if (!prev || prev.kind !== 'attested') return
    this.apply(key, mergeAttested(prev, { kind: 'attested', adds: [], removes: ids }))
  }

  /** Merge an incoming partial ledger (a sync delta). Returns the keys that actually changed. */
  merge(incoming: LedgerState): string[] {
    const changed: string[] = []
    for (const k of Object.keys(incoming)) if (this.apply(k, incoming[k])) changed.push(k)
    return changed
  }

  /** The owned value (or undefined / expired) under a key. */
  getOwned(key: string, now: number): unknown {
    const e = this.state[key]
    return e && e.kind === 'owned' && e.expireAt > now ? e.value : undefined
  }

  /** The live attestations under an attested key. */
  attestations(key: string, now: number): Attestation[] {
    const e = this.state[key]
    return e && e.kind === 'attested' ? liveAttestations(e, now) : []
  }

  /** Is there any live value/attestation under a key? (The boolean reduction — e.g. the resumable hint.) */
  has(key: string, now: number): boolean {
    return this.getOwned(key, now) !== undefined || this.attestations(key, now).length > 0
  }

  /** A copy of the full state, for a sync snapshot/delta. */
  snapshot(): LedgerState {
    return structuredCloneish(this.state)
  }

  /** Drop expired entries. */
  gc(now: number): void {
    this.state = gcLedger(this.state, now)
  }

  /** Subscribe to per-key changes. Returns an unsubscribe. */
  on(cb: (key: string) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  // Merge one entry in; emit + return true only if it changed the stored value.
  private apply(key: string, entry: Entry): boolean {
    const merged = mergeEntry(this.state[key], entry) as Entry
    if (this.state[key] && eq(this.state[key], merged)) return false
    this.state[key] = merged
    for (const cb of this.listeners) cb(key)
    return true
  }
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const structuredCloneish = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
