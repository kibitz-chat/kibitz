/**
 * Which shared MEDIA FILE (a chat-shared video/audio) is on the STAGE — the same shared-roster convention as
 * stageWidget.ts, so ANY participant can push a file to the stage, not just whoever shared it.
 *
 * The redesign: instead of the presenter capturing its <video> and broadcasting PIXELS, the stage carries only a
 * POINTER to the file (its stable cross-peer media key, `ChatItem.mid` — `${senderVoiceId}#${seq}`). Every peer
 * already holds its OWN local `blob:` copy of that file (`attachment.url`, created independently on each receiver),
 * so each peer resolves the key to its own copy and renders a native <video> locally — full quality, no re-encode.
 * Playback stays in lockstep via the existing timeline broadcast (`broadcastStageState`/`stagecmd`).
 *
 * A participant promotes a file by advertising it in its OWN roster metadata:
 * `setMeta({ stageMedia: <mid>, stageMAt: <seq> })`, cleared (stageMedia: undefined, bump stageMClearAt) to take it
 * down. `stageMAt` is a monotonic-ish sequence so the NEWEST push wins on take-over; a CLEAR with a higher sequence
 * is a tombstone so ANY participant can un-stage it. Rides the roster → survives late joins / host migration.
 */

interface Stageable {
  /** The participant's media peer id (matches the roster). */
  id: string
  meta: Record<string, unknown>
}

/** The media key (`mid`) this participant is pushing to the stage, or null. */
export const stagedMediaOf = (p: { meta: Record<string, unknown> }): string | null => {
  const v = (p.meta as { stageMedia?: unknown }).stageMedia
  return typeof v === 'string' && v ? v : null
}

/** The push sequence (newest wins). 0 when not pushing. */
export const stageMAtOf = (p: { meta: Record<string, unknown> }): number =>
  stagedMediaOf(p) ? Number((p.meta as { stageMAt?: unknown }).stageMAt) || 0 : 0

/** The CLEAR ("take it off the stage") sequence — a tombstone: a clear NEWER than the newest push empties the
 *  stage, so ANY participant can un-stage a file someone else pushed, not just the pusher. */
export const stageMClearAtOf = (p: { meta: Record<string, unknown> }): number => Number((p.meta as { stageMClearAt?: unknown }).stageMClearAt) || 0

/**
 * The file to stage: the newest push (highest `stageMAt`) across all participants — UNLESS a clear with a higher
 * sequence exists (then the stage is empty). Returns the media key plus who pushed it. `from` is the playback
 * AUTHORITY (it holds the master timeline that everyone else follows).
 */
export function pickStagedMedia<T extends Stageable>(participants: readonly T[]): { key: string; from: string } | null {
  let best: { key: string; from: string; at: number } | null = null
  let maxClear = 0
  for (const p of participants) {
    const c = stageMClearAtOf(p)
    if (c > maxClear) maxClear = c
    const key = stagedMediaOf(p)
    if (!key) continue
    const at = stageMAtOf(p)
    if (!best || at >= best.at) best = { key, from: p.id, at }
  }
  if (!best) return null
  return best.at > maxClear ? { key: best.key, from: best.from } : null // a newer clear takes it off the stage
}

/** The next sequence, one past the highest push OR clear currently advertised — call when promoting/clearing. */
export const nextStageMAt = (participants: readonly { meta: Record<string, unknown> }[]): number =>
  participants.reduce((m, p) => Math.max(m, stageMAtOf(p), stageMClearAtOf(p)), 0) + 1

/** A chat row carrying a shared file (structural — avoids importing useCall's full ChatItem). */
interface MediaItem {
  mid?: string
  attachment?: { xid?: string; url?: string } | null
}

/**
 * Resolve a stage media key to THIS peer's OWN local playable src (its `blob:` copy), or null if this peer doesn't
 * have the bytes (never received / evicted / saved-to-disk with no readable url — e.g. a large file). A null is the
 * signal to fall back (the deferred large-file/option-B path). Matches on `mid` (the stable public id) first, then
 * `xid` (the transfer id) — both are identical across peers; only the `url` differs per peer (each its own copy).
 */
export function localMediaSrc(chat: readonly MediaItem[], key: string): string | null {
  if (!key) return null
  for (const it of chat) {
    const a = it.attachment
    if (a && (it.mid === key || a.xid === key)) return a.url || null
  }
  return null
}
