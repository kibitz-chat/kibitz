// Pure state logic for the floating agent-control bubble (docs/floating-agent-control.md, in the
// kibitz repo). No React, no DOM — so the state machine + action-splitting are unit-testable in
// isolation and stay stable across the later phases (meta.phase, creator gating) that only change how
// the *inputs* are resolved, not this machine.
//
// The bubble is a re-skin of AgentActionsBar onto the same `agent-actions@1` manifest + roster-meta
// state. The four HIGH-LEVEL machine states are all this file knows about; `thinking/working` is NOT a
// state (it's transient busy) and `listening` vs `speaking` is a live sub-status inside `engaged`.
import type { AgentAction } from './agentActions'

export type BubbleState = 'absent' | 'summoning' | 'ready' | 'engaged'
export type SubStatus = 'listening' | 'speaking'

export interface StateInput {
  /** An agent participant is on the call. */
  present: boolean
  /** A summon is in flight (client-tracked between the POST and the agent joining). */
  summoning: boolean
  /** The agent's engagement phase is `engaged` (it has the floor). */
  engaged: boolean
}

/** Absent → Summoning → Ready ⇄ Engaged. Present always wins over a stale `summoning`. */
export const deriveState = ({ present, summoning, engaged }: StateInput): BubbleState =>
  present ? (engaged ? 'engaged' : 'ready') : summoning ? 'summoning' : 'absent'

export const isPresentState = (s: BubbleState): boolean => s === 'ready' || s === 'engaged'

/** Live listen/speak readout — only meaningful inside `engaged`; null elsewhere. */
export const subStatus = (state: BubbleState, speaking: boolean): SubStatus | null =>
  state === 'engaged' ? (speaking ? 'speaking' : 'listening') : null

/**
 * Participants only see the bubble once the agent has actually arrived; the room creator always sees it
 * (so they can Summon before an agent is present).
 */
export const bubbleVisible = (state: BubbleState, isCreator: boolean): boolean => isCreator || isPresentState(state)

/** The one status word shown in the collapsed pill and the panel header. */
export const pillWord = (state: BubbleState, sub: SubStatus | null, scribeEnabled: boolean, known: boolean): string => {
  switch (state) {
    case 'absent':
      return known ? 'Re-summon' : 'Add agent'
    case 'summoning':
      return 'Summoning…'
    case 'ready':
      return scribeEnabled ? 'Ready' : 'Disabled'
    case 'engaged':
      return sub === 'speaking' ? 'Speaking' : 'Listening'
  }
}

// The manifest action ids the bubble special-cases. These mirror the kibitz agent's
// SESSION_ACTION_ID / LISTEN_ACTION_ID / LEAVE_ACTION_ID (agent/actions.mjs). Kibitz stays agnostic
// about everything else — those become the capability list in the expand drawer.
export const ENGAGE_ID = 'engage'
export const LISTEN_ID = 'listen'
export const LEAVE_ID = 'leave'
const CONTROL_IDS: ReadonlySet<string> = new Set([ENGAGE_ID, LISTEN_ID, LEAVE_ID])

export interface SplitActions {
  /** The engagement toggle (Go ahead / Thanks a lot) — sent as-is; its label flips on the agent side. */
  engage?: AgentAction
  /** The scribe Enable/Disable (paid-transcription pause) toggle. */
  listen?: AgentAction
  /** Leave the call (settles the coupon on the agent side). */
  leave?: AgentAction
  /** Everything else the agent published — the capabilities shown in the expand drawer. */
  capabilities: AgentAction[]
}

/** Split a manifest's actions into the bubble's special-cased controls + the capability list. */
export const splitActions = (actions: readonly AgentAction[]): SplitActions => ({
  engage: actions.find((a) => a.id === ENGAGE_ID),
  listen: actions.find((a) => a.id === LISTEN_ID),
  leave: actions.find((a) => a.id === LEAVE_ID),
  capabilities: actions.filter((a) => !CONTROL_IDS.has(a.id)),
})

/**
 * Whether the scribe is currently ENABLED, inferred from the listen toggle's live label. The kibitz
 * agent flips the label between a Pause variant (currently hearing) and a Resume variant (paused).
 * TEMPORARY heuristic for Phase 0 — Phase 1 replaces this with a robust `meta.listening` read.
 */
export const scribeEnabledFromLabel = (listen: AgentAction | undefined): boolean => {
  if (!listen) return true // no toggle published → assume it's hearing
  return !/resume|unmute|unpause/i.test(listen.label)
}

/**
 * Whether the agent is engaged (has the floor). Prefers the exact engagement-session phase the agent now
 * publishes in roster meta (`meta.phase`: 'engaged'/'closing' = has the floor, 'listening' = dormant/scribe).
 * Falls back to the Phase-0 proxy (busy responding OR the follow-up 'listening' window) for an older agent
 * build that doesn't publish `meta.phase` yet — so the bubble works against both.
 */
export const engagedFromMeta = (meta: Record<string, unknown> | undefined): boolean => {
  if (meta && typeof meta.phase === 'string') return meta.phase === 'engaged' || meta.phase === 'closing'
  return !!meta && (!!meta.busy || meta.activity === 'listening')
}
