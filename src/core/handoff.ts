// "Open in app" handoff — close the gap where the browser always launches an installed PWA at
// its start_url (the bare home), discarding whatever room a tab was on.
//
// A browser TAB sitting in a room stashes that room; the installed app — opened by the browser's
// "open in app" affordance, or the user tapping the icon — reads it on launch and resumes straight
// into the room. Same origin + profile ⇒ shared localStorage, so the tab writes and the app reads.
// The one thing this does NOT (and cannot) do is LAUNCH the app: no web API lets a tab start a PWA;
// that stays the user's tap (or the browser's post-install open). This only fixes the destination.
//
// Freshness: the stash carries a timestamp and is honoured only within HANDOFF_TTL, and consumed
// once — so a long-stale room never silently hijacks a normal app launch. The tab refreshes the
// timestamp as it's backgrounded (the moment you switch to the app), so it's fresh at handoff time.

const HANDOFF_KEY = 'kibitz.handoffRoom'
export const HANDOFF_TTL = 5 * 60_000 // ms — older than this is stale; the app lands on home instead

// --- pure core (testable without a DOM) -------------------------------------------------------

/** Serialize a room href + capture time into the stash payload. */
export function serializeHandoff(href: string, t: number): string {
  return JSON.stringify({ href, t })
}

/** Parse a stash payload, returning the room href only if it's well-formed and ≤ TTL old. */
export function readHandoff(raw: string | null, now: number): string | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as { href?: unknown; t?: unknown }
    if (!o || typeof o.t !== 'number' || now - o.t > HANDOFF_TTL) return null
    return typeof o.href === 'string' && o.href ? o.href : null
  } catch {
    return null // malformed JSON — treat as no handoff
  }
}

// --- localStorage wrappers (the app's I/O edge) -----------------------------------------------

/** Remember the room URL a browser tab is viewing, so the app can resume into it on next open. */
export function stashHandoffRoom(href: string): void {
  try {
    localStorage.setItem(HANDOFF_KEY, serializeHandoff(href, Date.now()))
  } catch {
    /* storage blocked */
  }
}

/** Forget any stashed room (the tab left the room / went home — nothing to hand off). */
export function clearHandoffRoom(): void {
  try {
    localStorage.removeItem(HANDOFF_KEY)
  } catch {
    /* storage blocked */
  }
}

/** The fresh stashed room URL, if any (≤ TTL old). One-shot: clears it so the app resumes once. */
export function consumeHandoffRoom(): string | null {
  try {
    const raw = localStorage.getItem(HANDOFF_KEY)
    localStorage.removeItem(HANDOFF_KEY)
    return readHandoff(raw, Date.now())
  } catch {
    return null
  }
}
