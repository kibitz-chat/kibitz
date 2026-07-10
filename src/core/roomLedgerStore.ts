// Room-state ledger — local PERSISTENCE (docs/room-state-ledger.md, build step 3).
//
// Hold a room's ledger across reloads so a participant who refreshes/rejoins keeps it (and can re-seed peers).
// The ledger is small metadata, so we use localStorage behind a pluggable async `LedgerKV` — matching kibitz's
// other small-state stores (rejoinIntent / relayPref / license) and adding no dependency. The async interface
// means an IndexedDB backend can drop in unchanged if room state ever outgrows localStorage (spec's IDB
// default; localStorage is the pragmatic v1). TTL is per-entry (`expireAt`); we GC on every load AND save so
// expired facts never linger at rest.

import { type LedgerState, RoomLedger, gcLedger } from './roomLedger'

export interface LedgerKV {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

/** localStorage-backed KV. Best-effort: quota / private-mode failures are swallowed (persistence is a nicety,
 *  never load-bearing — the peer sync re-seeds anyway). `storage` is injectable for tests. */
export function localStorageKV(storage?: Storage): LedgerKV {
  const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  return {
    async get(key) {
      try {
        return s?.getItem(key) ?? null
      } catch {
        return null
      }
    },
    async set(key, value) {
      try {
        s?.setItem(key, value)
      } catch {
        /* quota / private mode — drop it */
      }
    },
  }
}

/** In-memory KV (tests / SSR / no-storage environments). */
export function memoryKV(): LedgerKV {
  const m = new Map<string, string>()
  return {
    async get(k) {
      return m.get(k) ?? null
    },
    async set(k, v) {
      m.set(k, v)
    },
  }
}

/** Persist ONE room's ledger, keyed by room id. GCs expired entries on both read and write. */
export class LedgerStore {
  constructor(
    private readonly kv: LedgerKV,
    private readonly roomId: string,
  ) {}

  private key(): string {
    return `kbz.ledger.${this.roomId}`
  }

  /** Read the persisted state, expired entries dropped. {} on empty / corrupt (fail-soft → start clean). */
  async load(now: number): Promise<LedgerState> {
    const raw = await this.kv.get(this.key())
    if (!raw) return {}
    try {
      return gcLedger(JSON.parse(raw) as LedgerState, now)
    } catch {
      return {}
    }
  }

  /** Write the state (expired entries dropped first). */
  async save(state: LedgerState, now: number): Promise<void> {
    await this.kv.set(this.key(), JSON.stringify(gcLedger(state, now)))
  }
}

/** Seed a ledger from its store on start, then debounced-save on every change. Returns `ready` (the initial
 *  load merged in), `flush` (force a save now), and `stop`. The sync layer and the store coexist: a peer merge
 *  or a local write both schedule a save. */
export function persistLedger(
  ledger: RoomLedger,
  store: LedgerStore,
  opts?: { now?: () => number; debounceMs?: number },
): { ready: Promise<void>; flush: () => Promise<void>; stop: () => void } {
  const now = opts?.now ?? (() => Date.now())
  const debounceMs = opts?.debounceMs ?? 800
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  const save = () => store.save(ledger.snapshot(), now())
  const ready = (async () => {
    const persisted = await store.load(now())
    if (!stopped) ledger.merge(persisted) // seeds the ledger; a resulting change schedules the first save
  })()
  const off = ledger.on(() => {
    if (stopped) return
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      void save()
    }, debounceMs)
  })
  return {
    ready,
    async flush() {
      clearTimer()
      await save()
    },
    stop() {
      stopped = true
      off()
      clearTimer()
    },
  }
}
