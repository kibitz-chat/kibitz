// Auto-rejoin after a reload. A refresh, an iOS tab-kill, or a crash drops the call
// and would otherwise dump the user back at the Join screen. We stamp a small,
// per-room "I'm in this call" intent in localStorage, keep it fresh while in the
// call, and clear it on an explicit Leave/removal. On the next mount, a FRESH intent
// for the SAME room means "bring me back" — see the Widget. The TTL is the safety
// valve: only a reload that lands moments after we were last in the call rejoins, so
// a tab reopened much later doesn't surprise-join.

const KEY = 'kibitz.rejoin'

/** A reload lands within seconds; only auto-rejoin if we were in the call that
 *  recently (re-stamped on a heartbeat while in-call, so a long call still qualifies). */
export const REJOIN_TTL_MS = 90_000

export interface RejoinIntent {
  /** The room we were in — a rejoin only fires for the SAME room. */
  room: string
  /** When it was last stamped (epoch ms), for the freshness check. */
  at: number
}

/** Narrow stored JSON to a valid intent, or null. Never throws. */
export function parseIntent(raw: string | null): RejoinIntent | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const { room, at } = v as { room?: unknown; at?: unknown }
      if (typeof room === 'string' && room && typeof at === 'number' && Number.isFinite(at)) {
        return { room, at }
      }
    }
  } catch {
    /* not JSON — ignore */
  }
  return null
}

/** True if `intent` is a same-room rejoin stamped within `ttl` of `now` (and not in
 *  the future — a guard against a clock that jumped back). Pure. */
export function isFresh(intent: RejoinIntent | null, room: string, now: number, ttl = REJOIN_TTL_MS): boolean {
  if (!intent || intent.room !== room) return false
  const age = now - intent.at
  return age >= 0 && age <= ttl
}

// --- localStorage IO (guarded; a no-op when storage is unavailable) ---------------

/** Record that we're in `room` right now (call on join + on a heartbeat). */
export function markInCall(room: string, now: number): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ room, at: now } satisfies RejoinIntent))
  } catch {
    /* storage blocked / full — auto-rejoin just won't fire, which is safe */
  }
}

/** Forget the in-call intent (call on an explicit Leave / removal). */
export function clearInCall(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

/** Should we auto-rejoin `room` now? (Fresh, same-room intent in storage.) */
export function shouldRejoin(room: string, now: number, ttl = REJOIN_TTL_MS): boolean {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return false
  }
  return isFresh(parseIntent(raw), room, now, ttl)
}
