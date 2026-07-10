// Recent rooms — a LOCAL-ONLY list of rooms you've opened, so you can re-enter one after leaving (a room code
// otherwise lives only in its link). Newest first, deduped by code, capped. Stores the room's full link
// FRAGMENT (`hash`) so re-entry is identical to the original visit — for a summoner that includes the control
// secrets their own link already carried (it caches their bookmark, on their own device, same exposure as the
// browser history). Never synced; forget-one + clear-all wipe it.
export type RecentRoom = { code: string; name: string; hash: string; at: number }

const KEY = 'kbz.recent'
const CAP = 6

function store(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null // storage disabled (private mode / blocked)
  }
}
function read(): RecentRoom[] {
  try {
    const raw = store()?.getItem(KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((r) => r && typeof r.code === 'string' && typeof r.hash === 'string') : []
  } catch {
    return []
  }
}
function write(list: RecentRoom[]): void {
  try {
    store()?.setItem(KEY, JSON.stringify(list.slice(0, CAP)))
  } catch {
    /* quota / blocked — non-fatal */
  }
}

/** The recent rooms, newest first. */
export function getRecentRooms(): RecentRoom[] {
  return read().sort((a, b) => b.at - a.at)
}

/** Record (or refresh) a room visit: dedup by code, move to the front, cap. `at` is stamped by the caller
 *  (so this module stays pure/testable). Empty code or hash is ignored. */
export function recordRecentRoom(entry: { code: string; name?: string; hash: string; at: number }): void {
  const code = (entry.code || '').trim()
  if (!code || !entry.hash) return
  const rest = read().filter((r) => r.code !== code)
  const name = (entry.name || code).trim() || code
  write([{ code, name, hash: entry.hash, at: entry.at }, ...rest])
}

/** Forget a single room (the per-row ✕). */
export function forgetRecentRoom(code: string): void {
  write(read().filter((r) => r.code !== code))
}

/** Clear the whole list. */
export function clearRecentRooms(): void {
  try {
    store()?.removeItem(KEY)
  } catch {
    /* blocked */
  }
}
