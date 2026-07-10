/**
 * Wire-protocol compatibility gate — peer-driven. Each peer advertises a PROTOCOL_VERSION (an integer) on the
 * roster (META_ENGINE.p). If a peer in the call is on a STRICTLY HIGHER protocol than us, we can't speak its wire
 * format → we're the stale one and must converge (the UI prompts a refresh; we never auto-reload mid-call).
 *
 * Why a protocol version and NOT the build stamp (the previous design): the old gate reloaded whenever ANY peer had
 * a newer BUILD — so every routine deploy kicked live calls (a fresh peer joining force-reloaded everyone older).
 * For real users that's unacceptable. Now a NORMAL deploy keeps the SAME protocol, so it never interrupts a call;
 * ONLY a deliberate protocol bump (a genuinely incompatible wire change) asks older clients to refresh.
 *
 * DISCIPLINE — the whole scheme rests on this:
 *   • BUMP PROTOCOL_VERSION in the SAME change that makes the wire INCOMPATIBLE — a new REQUIRED ctl/content
 *     message shape old clients can't parse, a changed handshake, an incompatible media/format negotiation.
 *   • DON'T bump for backward-compatible changes (new optional fields, UI, new features gated behind capability
 *     flags `META_ENGINE.f`). Same protocol = peers interop = no refresh.
 *   • When in doubt, DON'T bump (fail-open: equal protocol ⇒ compatible). A needless bump refreshes everyone; a
 *     missed bump lets old+new mesh and misbehave — so couple the bump to the breaking commit and add a test.
 *
 * The per-peer "feature" capability list (META_ENGINE.f) handles fine-grained, OPTIONAL negotiation (e.g.
 * xfer.resume) WITHOUT a protocol bump; PROTOCOL_VERSION is only the coarse "can we talk at all" floor.
 */

// The current wire-protocol generation. ⚠️ BUMP ONLY on a breaking wire change (see the DISCIPLINE note above).
// History:
//   1 — baseline (the protocol in production when this gate replaced build-stamp ordering).
export const PROTOCOL_VERSION = 1

// Clients from before this gate existed advertise no protocol — treat a missing/garbage value as the baseline so a
// pre-field peer is considered compatible with a baseline (PROTOCOL_VERSION = 1) client, not "incompatible".
const BASELINE = 1

export interface StaleDecision {
  stale: boolean
  /** The higher peer protocol that triggered it — for logging. */
  newerProtocol?: number
}

const norm = (p: number | undefined | null): number => (Number.isFinite(p as number) ? Number(p) : BASELINE)

/**
 * Pure: are WE stale — is any peer on a STRICTLY HIGHER protocol than us? Equal / lower / unknown ⇒ compatible
 * (fail-open, never reload). Testable with no I/O.
 */
export function decideStale(myProtocol: number, peerProtocols: readonly (number | undefined | null)[]): StaleDecision {
  const me = norm(myProtocol)
  for (const pp of peerProtocols) {
    const p = norm(pp)
    if (p > me) return { stale: true, newerProtocol: p }
  }
  return { stale: false }
}
