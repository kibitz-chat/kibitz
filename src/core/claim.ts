// A CLAIMED identity — a self-asserted (UNVERIFIED) email or "Guest" that a joiner picks from an open
// room's invited list. It rides participant `meta` (`meta.claim`) alongside the free nickname, and is
// rendered with a deliberately weaker marker than the verified ✓. The one hard rule (see
// docs/claimed-identity.md): a claim must NEVER look like the verified ✓ — the verified email (the OIDC
// path / identity.ts) stays the only source of trust. M is display + this meta field; admission is unchanged.

export type Claim = { kind: 'email'; email: string } | { kind: 'guest' }

/** Read + validate a claim off a participant's `meta`. Returns null for no / malformed claim. */
export function readClaim(meta: Record<string, unknown> | undefined): Claim | null {
  const c = meta?.claim as { kind?: unknown; email?: unknown } | undefined
  if (!c || typeof c !== 'object') return null
  if (c.kind === 'guest') return { kind: 'guest' }
  if (c.kind === 'email' && typeof c.email === 'string' && c.email.trim()) return { kind: 'email', email: c.email.trim() }
  return null
}

/** The `meta` patch a claim stores (what the pre-join pick passes to setSelf/setMeta). */
export const claimMeta = (claim: Claim | null): Record<string, unknown> => ({ claim: claim ?? undefined })

/** One-line label for a claim — tile tooltip / verify panel. */
export const claimLabel = (claim: Claim): string => (claim.kind === 'guest' ? 'Joined as a guest' : `Claims to be ${claim.email} — not verified`)
