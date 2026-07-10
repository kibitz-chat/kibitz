// Join-gate: how a room decides WHO may enter. The room authority enforces it through
// the generic gate seam in room.ts (`verify(credential, remoteFp) → ok/deny`), so every
// mode here works peer-to-peer with no server — EXCEPT `email`, which needs a backend to
// mail + verify the code (the authority can't send mail). This module is the pure core:
// the mode/config shapes plus the serverless verifiers. UI + link/storage live in the app.

/** How a room is gated. `open` = anyone with the link (the account-free default).
 *  `invite` = per-guest signed token (the "link is everything" default). */
export type JoinGateMode = 'open' | 'names' | 'code' | 'email' | 'google' | 'invite'

/** One person on a code-gated guest list: a label (who they are) + the secret code they
 *  type to get in. The code is NOT put in the invite link — it stays in the host's browser
 *  and is shared with each person out-of-band. */
export interface CodeEntry {
  name: string
  code: string
}

/** The full gate config a creator sets. Only `mode` (+ non-secret `names`/`clientId`) is
 *  safe to carry in a link; `entries`/`emails` are the guest list and stay with the host. */
export interface JoinGateConfig {
  mode: JoinGateMode
  /** `names` mode — the pickable allow-list. */
  names?: string[]
  /** `code` mode — assigned name→code pairs. */
  entries?: CodeEntry[]
  /** `email` / `google` modes — the allowed addresses (a per-person guest list). */
  emails?: string[]
  /** `google` mode — the OAuth client id used to verify Google sign-in. */
  clientId?: string
  /** `google` mode — also require domain membership (union with `emails`). */
  domains?: string[]
}

/** Length-independent equality so comparing a secret code can't leak it by timing. */
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

/**
 * `names` mode: the joiner picks a name; admit iff it's on the allow-list
 * (trimmed, case-insensitive). No proof — anyone with the link can pick any allowed name,
 * so this is presence/organization, not security. Blank lists/picks never match.
 */
export function nameAllowed(picked: string, allowed: readonly string[]): boolean {
  const p = picked.trim().toLowerCase()
  if (!p) return false
  return allowed.map((a) => a.trim().toLowerCase()).filter(Boolean).includes(p)
}

/**
 * `code` mode: admit iff the submitted code matches an assigned one (constant-time,
 * trimmed). Returns the matched entry (so the host learns WHO joined) or null. Every entry
 * is compared even after a match, so timing doesn't reveal which code hit. Blank never matches.
 */
export function codeMatch(submitted: string, entries: readonly CodeEntry[]): CodeEntry | null {
  const s = submitted.trim()
  if (!s) return null
  let found: CodeEntry | null = null
  for (const e of entries) {
    const code = e.code.trim()
    if (code && constantTimeEqual(s, code)) found = e
  }
  return found
}

/** Add a name→code row to a code list, immutably. Ignored if the name or code is blank,
 *  or the name already exists (case-insensitive). Trims both. */
export function addCodeEntry(list: readonly CodeEntry[], name: string, code: string): CodeEntry[] {
  const n = name.trim()
  const c = code.trim()
  if (!n || !c || list.some((e) => e.name.trim().toLowerCase() === n.toLowerCase())) return [...list]
  return [...list, { name: n, code: c }]
}

/** A short, unambiguous random join code (no 0/O/1/I/etc.), e.g. "K7P-Q2M". For the host
 *  to hand out. Caller passes crypto-random bytes so this stays pure/testable. */
export function formatCode(bytes: Uint8Array, groups = 2, perGroup = 3): string {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no I/O/0/1/L
  const out: string[] = []
  let i = 0
  for (let g = 0; g < groups; g++) {
    let s = ''
    for (let k = 0; k < perGroup; k++) s += ALPHABET[(bytes[i++] ?? 0) % ALPHABET.length]
    out.push(s)
  }
  return out.join('-')
}
