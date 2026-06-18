import { randomCode } from '../core/roomCode'
import { normalizeRoom } from '../core/transport'

// A friendly word in front of the crypto suffix keeps a fresh room sayable.
const WORDS = ['amber', 'birch', 'coral', 'dusk', 'ember', 'fjord', 'grove', 'lunar', 'opal', 'tidal'] as const

/** A friendly random room id, e.g. "ember-a3f9k2mq7p". The word stays sayable; the
 *  10-char crypto suffix makes an active room un-guessable (~52 bits), so nobody can
 *  fish for live calls by enumerating short codes. Already in normalized form. */
export function freshRoom(): string {
  return `${WORDS[Math.floor(Math.random() * WORDS.length)]}-${randomCode(10)}`
}

/** Turn a creator's typed room name into the id we'll route to: the name, normalized
 *  the same way every room id is (lowercased, runs of non-alphanumerics → "-", capped).
 *  An empty/blank/symbols-only name falls back to a fresh un-guessable room, so "Start"
 *  always lands somewhere. The result is safe to use verbatim as the URL hash. */
export function roomFromInput(raw: string | undefined): string {
  const named = raw ? normalizeRoom(raw) : ''
  return named || freshRoom()
}
