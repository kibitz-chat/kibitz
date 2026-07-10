/**
 * A crypto-random base-36 room code of length `n`.
 *
 * Unbiased: a byte is 0–255, but 256 isn't a multiple of 36, so a plain `b % 36`
 * would favour the first four glyphs. We reject bytes ≥ 252 (= 7×36) so every
 * glyph is equally likely.
 *
 * Un-guessable: 10 chars is ~52 bits / ~3.6×10¹⁵ keyspace, so an active room
 * can't be found by enumerating short codes. Used for freshly-minted rooms;
 * deterministic page-derived rooms (see pageRoom.ts) deliberately stay guessable
 * so two people on the same URL meet with zero coordination.
 *
 * NOTE: mirrored as an inline helper in public/embed.html (a static page that
 * can't import this module) — keep the two in sync.
 */
export function randomCode(n: number): string {
  let s = ''
  while (s.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n))) {
      if (b < 252) s += (b % 36).toString(36)
      if (s.length === n) break
    }
  }
  return s
}
