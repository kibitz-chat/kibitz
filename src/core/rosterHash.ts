import { bytesToB64url } from './oidcVerify'

// A room-bound, salted hash of a roster identity (an email), so a VERIFIED-ROOM link can commit
// its allow-list WITHOUT exposing the actual addresses. Two honest properties:
//   • Defense-in-depth, not strong confidentiality. Emails are LOW-ENTROPY, so anyone holding the
//     link can still brute-force common addresses against the (public) room salt. The real
//     confidentiality is the encrypted-roster layer; this stops PASSIVE harvest (the web host /
//     logs / a casual reader see opaque hashes) and pairs with moving the roster into the fragment.
//   • Room-bound. The salt is the room id, so the same email yields a different hash per room —
//     no cross-room correlation, no shared rainbow table.
// Canonicalization MUST match roomManifest.norm (NFKC → trim → lowercase) so the creator's roster
// entry and a joiner's verified email hash identically on both sides.

const enc = new TextEncoder()
const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase()

/** The room-bound hash of a roster identity. base64url(SHA-256(`norm(identity)|roomSalt`)). */
export async function memberHash(identity: string, roomSalt: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${norm(identity)}|${roomSalt}`)))
  return bytesToB64url(digest)
}

/** Is `identity`'s room-bound hash present in `hashes`? Async (WebCrypto). False for no identity. */
export async function matchesMemberHash(
  hashes: readonly string[],
  identity: string | undefined,
  roomSalt: string,
): Promise<boolean> {
  if (!identity) return false
  return hashes.includes(await memberHash(identity, roomSalt))
}
