// Participant capabilities — a GENERAL per-participant permission model (humans AND agents), not an
// agent-only bolt-on. A participant's `Grant` is what it may PERCEIVE (content that flows TO it) and
// ACT (what it may emit). The authority decides each grant at admission; the engine enforces it
// per-peer — perceive = sender-side withholding (a peer never delivers what you can't see), act =
// receiver-side dropping (everyone ignores what you're not allowed to emit). An AGENT is just a
// participant with LEAST-PRIVILEGE defaults + a data-egress disclosure: its model backend sees what
// it forwards — a fact a human participant doesn't carry, and one the system can DISCLOSE (not
// enforce). Pure + serializable so a grant rides the roster and is trivially testable; no engine /
// DOM here. Companion to the verified-roster ([[rosterGate]]) and the agent docs.

// PERCEIVE: `read-chat`/`read-roster`/`receive-directed` gate DATA (mesh content, useCall); the two
// MEDIA perceives `see-screen`/`hear-audio` gate TRACKS — withheld per-peer in the mesh by swapping a
// flowing placeholder onto that peer's connection (mesh.ts `gatedTrack`/`setMediaGate`). Camera video
// has no perceive — it's the always-on presence lane — so it isn't capability-gated.
export type Perceive = 'see-screen' | 'hear-audio' | 'read-chat' | 'read-roster' | 'receive-directed'
export type Act = 'send-chat' | 'speak' | 'act'
export type Capability = Perceive | Act
export type ParticipantKind = 'human' | 'agent'

export const ALL_PERCEIVE: readonly Perceive[] = ['see-screen', 'hear-audio', 'read-chat', 'read-roster', 'receive-directed']
export const ALL_ACT: readonly Act[] = ['send-chat', 'speak', 'act']

export interface Grant {
  /** What content flows TO this participant (enforced sender-side). */
  perceive: Perceive[]
  /** What this participant may emit (enforced receiver-side). */
  act: Act[]
  /** Disclosure (agents): the model/backend it routes to — SHOWN to humans, never enforced. */
  backend?: string
  /** Disclosure (agents): does what it perceives LEAVE the E2EE room (to that backend)? */
  egress?: boolean
  /** Auto-revoke at this epoch-seconds time; absent/0 ⇒ no limit. */
  expiresAt?: number
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)]
const PERCEIVE_SET = new Set<string>(ALL_PERCEIVE)
const ACT_SET = new Set<string>(ALL_ACT)

/** Everything (the human default). */
export const fullGrant = (): Grant => ({ perceive: [...ALL_PERCEIVE], act: [...ALL_ACT] })
/** Nothing (expired / revoked / denied). */
export const emptyGrant = (): Grant => ({ perceive: [], act: [] })

/** The starting grant for a participant KIND. Humans: full. Agents: read-only — they PERCEIVE the
 *  room conversation (read-chat), the roster, and data directed at them (receive-directed, e.g. a
 *  Whist kibitzer's hand), but ACT nothing and get no media. Acting (send-chat/speak/act) and media
 *  (see-screen/hear-audio) are granted only by explicit host consent. Perception is disclosed, not
 *  withheld, by default (an agent is invited to watch); the dangerous part — acting — is opt-in. */
export function defaultGrant(kind: ParticipantKind): Grant {
  return kind === 'agent' ? { perceive: ['read-chat', 'read-roster', 'receive-directed'], act: [] } : fullGrant()
}

export function isExpired(g: Grant | null | undefined, nowSec: number): boolean {
  return !!(g && g.expiresAt && nowSec >= g.expiresAt)
}

/** The grant in force right now — empty once expired, so a stale grant confers nothing. */
export function effectiveGrant(g: Grant | null | undefined, nowSec: number): Grant {
  return !g || isExpired(g, nowSec) ? emptyGrant() : g
}

export function canPerceive(g: Grant | null | undefined, cap: Perceive): boolean {
  return !!g && g.perceive.includes(cap)
}
export function canAct(g: Grant | null | undefined, cap: Act): boolean {
  return !!g && g.act.includes(cap)
}

/** Sanitize a grant arriving over the wire: drop unknown capability strings, de-dupe, clamp the
 *  disclosure fields. A peer must never gain a capability from a malformed/oversized grant. */
export function sanitizeGrant(g: Partial<Grant> | null | undefined): Grant {
  return {
    perceive: uniq((g?.perceive ?? []).filter((c): c is Perceive => PERCEIVE_SET.has(c))),
    act: uniq((g?.act ?? []).filter((c): c is Act => ACT_SET.has(c))),
    ...(typeof g?.backend === 'string' && g.backend ? { backend: g.backend.slice(0, 80) } : {}),
    ...(g?.egress ? { egress: true } : {}),
    ...(typeof g?.expiresAt === 'number' && g.expiresAt > 0 ? { expiresAt: g.expiresAt } : {}),
  }
}

/** Grant = what the joiner REQUESTED ∩ what the host ALLOWED — never more than requested (no
 *  surprise powers) nor more than allowed. Disclosure rides from the request; expiry is the
 *  soonest of the two. Used when a host approves a subset of an agent's request. */
export function intersectGrant(request: Grant, allowed: Grant): Grant {
  const exp = [request.expiresAt, allowed.expiresAt].filter((x): x is number => !!x)
  return {
    perceive: request.perceive.filter((c) => allowed.perceive.includes(c)),
    act: request.act.filter((c) => allowed.act.includes(c)),
    ...(request.backend ? { backend: request.backend } : {}),
    ...(request.egress ? { egress: true } : {}),
    ...(exp.length ? { expiresAt: Math.min(...exp) } : {}),
  }
}

/** Human-readable split for the consent sheet: which capabilities a grant does / doesn't confer. */
export function grantSummary(g: Grant): { can: Capability[]; cannot: Capability[] } {
  const granted = new Set<string>([...g.perceive, ...g.act])
  const all: Capability[] = [...ALL_PERCEIVE, ...ALL_ACT]
  return { can: all.filter((c) => granted.has(c)), cannot: all.filter((c) => !granted.has(c)) }
}
