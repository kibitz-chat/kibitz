import { normalizeRoom } from './transport'
import { splitRoomHash } from './joinGateLink'

// Hash routes that are NOT rooms (reserved app routes / static pages). A pasted link or
// code resolving to one of these isn't a room to join. Kept in sync with App.tsx's
// CREATE_ROUTE / HASH_REDIRECTS and the static pages under public/.
const RESERVED = new Set(['new', 'install', 'uninstall', 'privacy', 'terms', 'security', 'relay', 'setup', 'docs', 'extension', 'help', 'wake'])

const looksLikeUrl = (s: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('//') || s.startsWith('#') || s.startsWith('/')

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s // malformed %-escape — leave as-is; normalizeRoom strips the stray chars
  }
}

/**
 * Turn a pasted Kibitz **link** or bare **room code** into a same-origin URL to navigate to —
 * so an installed Home-Screen PWA (no address bar) can JOIN a room someone sent. Returns the
 * target URL, or `null` if the input names no room.
 *
 * Why re-home onto our own `origin`: iOS keeps you in the standalone app only while navigation
 * stays in-scope (same origin). We therefore keep the pasted link's **room + admission info**
 * (the hash, and any gate/credential/grant query params) but graft them onto THIS origin — so a
 * link copied from kibitz.chat (or a localhost test build, or any deploy) opens the room right
 * here in the installed app instead of bouncing to Safari. The room id always lives in the hash
 * (see App.tsx hashRoom); gate params ride the fragment (new) or the query (legacy) — both kept.
 *
 * The caller does a FULL-document navigation to the result (`location.assign`), so the module-load
 * gate/grant parsing in App.tsx re-runs for the joined room.
 */
export function parseRoomTarget(input: string, origin: string): string | null {
  const raw = (input ?? '').trim()
  if (!raw) return null

  if (looksLikeUrl(raw)) {
    let url: URL
    try {
      url = new URL(raw, origin) // relative #frag / /path forms resolve against our origin
    } catch {
      return null // malformed URL — not a crash, just "no room"
    }
    // Only carry a link's QUERY params (gate descriptor / credential / TURN grant / ?idclient / ?galaxy)
    // when they came from OUR OWN origin. A pasted CROSS-ORIGIN link's `?query` must never be grafted
    // onto our origin: a crafted `https://evil.example/?idclient=…#room` would otherwise re-home to
    // `<origin>/?idclient=…#room`, and App.tsx reads such params from location.search. The room id
    // itself (in the hash/path) is safe to re-home — that's the whole point.
    const search = url.origin === origin ? url.search : ''
    // The WhatsApp-friendly share form puts the room in the PATH: /j/<room> (see functions/j). Pull
    // the room out and re-home to the fragment route, keeping any same-origin query params.
    const jMatch = url.pathname.match(/^\/j\/([^/]+)\/?$/)
    if (jMatch) {
      const jRoom = normalizeRoom(safeDecode(jMatch[1]))
      if (!jRoom || RESERVED.has(jRoom)) return null
      return `${origin}/${search}#${jRoom}`
    }
    const room = normalizeRoom(safeDecode(splitRoomHash(url.hash).room))
    if (room) {
      if (RESERVED.has(room)) return null
      // Keep the (same-origin) query + the fragment; the app normalizes the room id on read.
      return `${origin}/${search}${url.hash}`
    }
    // The embed demo pages carry the room in a `?room=` QUERY param (kibitz.chat/embed*.html?room=…) —
    // the form copied from a floating widget. Pull it out and re-home to the fragment route (where the
    // app reads the room), keeping any OTHER same-origin params. The room id itself is safe to re-home
    // from any origin (like the /j/ and #hash forms); only the rest of a cross-origin query is dropped.
    const qRoom = normalizeRoom(safeDecode(new URLSearchParams(url.search).get('room') ?? ''))
    if (qRoom) {
      if (RESERVED.has(qRoom)) return null
      const rest = new URLSearchParams(search) // same-origin query only (search is '' cross-origin)
      rest.delete('room')
      const qs = rest.toString()
      return `${origin}/${qs ? `?${qs}` : ''}#${qRoom}`
    }
    return null
  }

  // A bare room code (e.g. `tidal-3pu4s1ghy1`, or a human typing a label).
  const room = normalizeRoom(raw)
  if (!room || RESERVED.has(room)) return null
  return `${origin}/#${room}`
}
