// Mutual, pre-share verification for the "verified roster, no privileged host" mode
// (docs/verification.md §7). PURE decision logic only: given the committed roster, my own
// proven identity, and what every present peer has proven so far, decide whether content
// may flow. The invariant: no peer is "in" until it has verified — and been verified by —
// every other peer (the host included) against the manifest, before any content flows.
//
// Credential verification itself happens elsewhere (cert-bound OIDC in useCall.getIdentity,
// etc.); this module is fed the RESULT — a cryptographically-verified identity string, or
// null while still pending — and only reasons about roster membership + the share gate. So
// the gate is method-agnostic and trivially testable. Inert unless a roster is supplied:
// when there's no manifest the whole feature is off and everything is shareable.

// NFKC first (match roomManifest.norm) so a roster entry and a peer's verified identity
// canonicalize identically even across compatibility-equivalent Unicode, then case-fold.
const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase()

export type PeerVerifyState = 'pending' | 'verified' | 'rejected'

export interface PeerRosterStatus {
  id: string
  state: PeerVerifyState
  /** The verified member identity, present when `state === 'verified'` (or carried on a
   *  `rejected` peer for display — the off-roster identity it proved). */
  identity?: string
}

export interface RosterGateInput {
  /** Exact allowed identities (emails). null/undefined/empty AND no `domains` ⇒ mode inactive. */
  members?: readonly string[] | null
  /** Allowed email domains — a verified address at one of these counts as a member (OIDC slots). */
  domains?: readonly string[] | null
  /** My own cryptographically-verified identity, or null until I've proven one. */
  self?: string | null
  /** Each present peer (excluding me) with the identity it has proven so far: a string
   *  once its credential verified, null while still pending (no token yet / mid-verify). */
  peers?: ReadonlyArray<{ id: string; identity?: string | null }>
}

export interface RosterGateView {
  /** A committed roster governs this room (the mode is active). */
  active: boolean
  /** I have proven myself to be a listed member (self-gate / honest-host bootstrap). */
  selfVerified: boolean
  /** Per present-peer membership status. */
  peers: PeerRosterStatus[]
  /** May content flow? Inactive ⇒ always true. Active ⇒ I'm verified AND every present
   *  peer is verified (vacuously true when alone). */
  canShare: boolean
  /** A present peer proved an identity that is NOT on the roster — an intruder slipped past
   *  admission. Refuse to share and alarm; the room's authority can't be trusted. */
  compromised: boolean
  /** Still waiting to verify ≥1 present peer (transient — hold, but not yet compromised). */
  pending: boolean
}

/** Is `identity` on the committed roster — by exact email (`members`) OR by allowed domain
 *  (`domains`, an OIDC slot)? Normalized (trimmed + lowercased), so case/whitespace-insensitive. */
export function memberOf(
  members: readonly string[],
  identity: string | null | undefined,
  domains: readonly string[] = [],
): boolean {
  if (!identity) return false
  const id = norm(identity)
  if (members.some((m) => norm(m) === id)) return true
  const at = id.lastIndexOf('@')
  if (at < 0) return false
  const dom = id.slice(at + 1)
  return domains.some((d) => norm(d).replace(/^@/, '') === dom)
}

/**
 * Decide the share gate from the committed roster + who has proven what. Pure. When no
 * roster is supplied the gate is inert (active:false, canShare:true) so non-verified-roster
 * rooms are entirely unaffected.
 */
export function evaluateRosterGate(input: RosterGateInput): RosterGateView {
  const members = input.members ?? []
  const domains = input.domains ?? []
  if (members.length === 0 && domains.length === 0) {
    return { active: false, selfVerified: true, peers: [], canShare: true, compromised: false, pending: false }
  }
  const selfVerified = memberOf(members, input.self, domains)
  const peers: PeerRosterStatus[] = (input.peers ?? []).map((p) => {
    if (p.identity == null) return { id: p.id, state: 'pending' }
    if (memberOf(members, p.identity, domains)) return { id: p.id, state: 'verified', identity: p.identity }
    return { id: p.id, state: 'rejected', identity: p.identity }
  })
  const compromised = peers.some((p) => p.state === 'rejected')
  const pending = peers.some((p) => p.state === 'pending')
  const allPeersVerified = peers.every((p) => p.state === 'verified')
  // canShare requires BOTH directions are satisfiable: I'm a listed member (others will be
  // able to verify me) AND every peer present has proven a listed identity to me.
  const canShare = selfVerified && allPeersVerified
  return { active: true, selfVerified, peers, canShare, compromised, pending }
}

/** Receive-side filter: is this specific peer cleared to exchange content with me? Only a
 *  present, verified member is — an unknown/pending/rejected peer is not. Inactive ⇒ all. */
export function peerCleared(view: RosterGateView, id: string): boolean {
  if (!view.active) return true
  const p = view.peers.find((x) => x.id === id)
  return !!p && p.state === 'verified'
}
