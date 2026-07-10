// Durable, email-keyed bans (opt-in identity only). When the host removes a peer who
// has a VERIFIED identity, we remember their email; the host then auto-kicks anyone
// whose verified email is on the list — so a ban survives a fresh tab/connection, not
// just the ephemeral token. Host-local + persisted per room in localStorage. It only
// bites people who sign in; an un-signed-in guest has no email and falls back to the
// normal token kick. (Enforced by whoever currently holds the host role.)

const CAP = 200 // bound the stored set; emails are tiny but don't grow it unbounded

/** The localStorage key for a room's ban list (room already normalised). */
export function banKey(room: string): string {
  return `kibitz.bans.${room}`
}

/** Parse a stored ban list (tolerant: bad data → empty set; emails lowercased). */
export function parseBans(raw: string | null): Set<string> {
  if (!raw) return new Set()
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr)
      ? new Set(arr.filter((x): x is string => typeof x === 'string').map((e) => e.toLowerCase()))
      : new Set()
  } catch {
    return new Set()
  }
}

/** Serialize the ban set, keeping the most-recent `cap` entries. */
export function serializeBans(set: ReadonlySet<string>, cap = CAP): string {
  return JSON.stringify(Array.from(set).slice(-cap))
}

export function loadBans(room: string): Set<string> {
  try {
    return parseBans(localStorage.getItem(banKey(room)))
  } catch {
    return new Set()
  }
}

export function saveBans(room: string, set: ReadonlySet<string>): void {
  try {
    localStorage.setItem(banKey(room), serializeBans(set))
  } catch {
    /* storage blocked — bans just won't persist across the host's reloads */
  }
}
