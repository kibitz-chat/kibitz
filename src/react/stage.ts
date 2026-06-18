/**
 * Who's presenting — the shared convention that lets ANY client (the web panel or
 * the extension) put a screen-sharer on a big "stage", and watch one another's.
 *
 * `Participant.sharing` is SELF-only (it can't tell a remote viewer who's
 * presenting), so a presenter instead advertises it in the roster metadata:
 * `setMeta({ presenting: true, presentAt: <seq> })` when the share starts, cleared
 * when it stops. `presentAt` is a monotonic-ish sequence so the NEWEST presenter
 * wins the stage on a take-over. This module reads that same shape on both sides.
 */

interface Presentable {
  meta: Record<string, unknown>
  stream: MediaStream | null
}

export const isPresenting = (p: { meta: Record<string, unknown> }): boolean => !!p.meta?.presenting

export const presentAtOf = (p: { meta: Record<string, unknown> }): number =>
  isPresenting(p) ? Number((p.meta as { presentAt?: unknown }).presentAt) || 0 : 0

/**
 * The participant to stage: the newest presenter (highest `presentAt`) that
 * actually has a stream to show — or null when nobody is presenting (or the
 * presenter's share hasn't arrived yet, so there'd be nothing to render).
 */
export function pickPresenter<T extends Presentable>(participants: readonly T[]): T | null {
  let best: T | null = null
  for (const p of participants) {
    if (!isPresenting(p) || !p.stream) continue
    if (!best || presentAtOf(p) >= presentAtOf(best)) best = p
  }
  return best
}
