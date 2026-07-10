/**
 * Which bounded widget (a map) is on the STAGE — the same shared convention as the presenter (stage.ts),
 * so ANY participant can push a widget to the stage, not just whoever posted it.
 *
 * A participant promotes a widget by advertising it in their OWN roster metadata:
 * `setMeta({ stageWidget: <instanceId>, stageWAt: <seq> })`, cleared (stageWidget: undefined) to take it
 * down. `stageWAt` is a monotonic-ish sequence so the NEWEST push wins the stage on a take-over — exactly
 * like `presentAt` for screen-shares. Because it rides the roster, it survives late joins and host migration
 * with no extra signalling, and there's no special owner: the latest pusher's choice is what everyone shows.
 */

interface Stageable {
  /** The participant's media peer id (matches the roster). */
  id: string
  meta: Record<string, unknown>
}

/** The widget-instance id this participant is pushing to the stage, or null. */
export const stagedWidgetOf = (p: { meta: Record<string, unknown> }): string | null => {
  const v = (p.meta as { stageWidget?: unknown }).stageWidget
  return typeof v === 'string' && v ? v : null
}

/** The push sequence (newest wins). 0 when not pushing. */
export const stageWAtOf = (p: { meta: Record<string, unknown> }): number =>
  stagedWidgetOf(p) ? Number((p.meta as { stageWAt?: unknown }).stageWAt) || 0 : 0

/** The CLEAR ("take it off the stage") sequence. A tombstone: a clear NEWER than the newest push wins, so ANY
 *  participant can un-stage a widget someone else (or the agent, via auto-stage) pushed — not just the pusher. */
export const stageClearAtOf = (p: { meta: Record<string, unknown> }): number => Number((p.meta as { stageClearAt?: unknown }).stageClearAt) || 0

/**
 * The widget to stage: the newest push (highest `stageWAt`) across all participants — UNLESS a clear with a
 * higher sequence exists (then the stage is empty). Returns the instance id plus who pushed it (attribution).
 */
export function pickStagedWidget<T extends Stageable>(participants: readonly T[]): { id: string; from: string } | null {
  let best: { id: string; from: string; at: number } | null = null
  let maxClear = 0
  for (const p of participants) {
    const c = stageClearAtOf(p)
    if (c > maxClear) maxClear = c
    const id = stagedWidgetOf(p)
    if (!id) continue
    const at = stageWAtOf(p)
    if (!best || at >= best.at) best = { id, from: p.id, at }
  }
  if (!best) return null
  return best.at > maxClear ? { id: best.id, from: best.from } : null // a newer clear takes it off the stage
}

/** The next sequence, one past the highest push OR clear currently advertised — call when promoting/clearing. */
export const nextStageWAt = (participants: readonly { meta: Record<string, unknown> }[]): number =>
  participants.reduce((m, p) => Math.max(m, stageWAtOf(p), stageClearAtOf(p)), 0) + 1
