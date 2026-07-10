/** Geometry + colour helpers for the shared pointer / annotation overlay. Pure, so
 *  the coordinate mapping (the fiddly part of aligning annotations across screens of
 *  different sizes over a letterboxed video) is unit-testable. */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The CONTENT rect of an `object-fit: contain` video — the letterboxed area the
 * picture actually occupies inside an `elW×elH` element, given the video's intrinsic
 * `vidW×vidH`. Annotations are normalized to THIS rect so they land on the same spot
 * on every viewer's screen, whatever their panel size or letterbox bars.
 */
export function containRect(elW: number, elH: number, vidW: number, vidH: number): Rect {
  if (!vidW || !vidH || !elW || !elH) return { x: 0, y: 0, w: elW, h: elH }
  const scale = Math.min(elW / vidW, elH / vidH)
  const w = vidW * scale
  const h = vidH * scale
  return { x: (elW - w) / 2, y: (elH - h) / 2, w, h }
}

/** Pixel point (relative to the element) → normalized 0..1 within the content rect,
 *  clamped so an off-picture drag stays on the edge. */
export function toNorm(px: number, py: number, r: Rect): { x: number; y: number } {
  return {
    x: r.w ? Math.min(1, Math.max(0, (px - r.x) / r.w)) : 0,
    y: r.h ? Math.min(1, Math.max(0, (py - r.y) / r.h)) : 0,
  }
}

/** Normalized 0..1 → pixel point within the content rect. */
export function fromNorm(nx: number, ny: number, r: Rect): { x: number; y: number } {
  return { x: r.x + nx * r.w, y: r.y + ny * r.h }
}

/** A stable, pleasant colour for a participant id — so each person's pointer (and
 *  their default ink) is consistently coloured without sending the colour. */
export function inkColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 85% 62%)`
}

/** The pen palette offered in the toolbar (the drawer's chosen ink colour rides the
 *  stroke; pointers stay auto-coloured per person). */
export const INK_PALETTE = ['#ff3b30', '#ffd60a', '#34c759', '#0a84ff', '#ffffff'] as const

/** One freehand stroke: a colour + normalized (0..1) points. Here (not in StageInk) so the per-image
 *  doodle store below is pure and unit-testable. */
export interface Stroke {
  color: string
  pts: { x: number; y: number }[]
}
/** The live board: strokes keyed `${who}:${sid}` (StageInk's strokesRef). */
export type StrokeMap = Map<string, Stroke>

/** Deep-copy a board, so a saved snapshot can't be mutated by ongoing drawing. */
export const cloneStrokes = (m: StrokeMap): StrokeMap => new Map([...m].map(([k, s]) => [k, { color: s.color, pts: s.pts.map((p) => ({ ...p })) }]))

/** Build a board from a `restore` event's strokes (the stager's authoritative replay of an image's doodle).
 *  Keys are synthetic (`restore:i`) — the original sender/sid aren't carried; deep-copied so it's self-owned. */
export const boardFromStrokes = (strokes: readonly Stroke[]): StrokeMap =>
  new Map((strokes || []).map((s, i) => [`restore:${i}`, { color: s.color, pts: (s.pts || []).map((p) => ({ ...p })) }]))

/** A short, opaque, stable key for an image staged on the screen — published as roster meta.stageImage so doodles
 *  bind per image WITHOUT leaking the source (filename/bytes). Same input → same key → the doodle returns on
 *  re-show. FNV-1a; matches the agent painter's content key so both sides key doodles the same way. */
export const stageImageKey = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return 'img-' + (h >>> 0).toString(36)
}

/**
 * Per-IMAGE doodle persistence. When the shared image changes, snapshot the LEAVING image's board into the
 * `saved` store (so re-showing that image brings its doodle back), and return the ENTERING image's saved board —
 * or an EMPTY board for a fresh image / a non-image surface (a live screen-share, where key === undefined).
 * Pure apart from mutating the `saved` store you pass in; the caller swaps its live board to the result + repaints.
 */
export function switchDoodle(saved: Map<string, StrokeMap>, current: StrokeMap, fromKey: string | undefined, toKey: string | undefined): StrokeMap {
  if (fromKey !== undefined) saved.set(fromKey, cloneStrokes(current)) // remember the image we're leaving
  return toKey !== undefined && saved.has(toKey) ? cloneStrokes(saved.get(toKey) as StrokeMap) : new Map() // restore, or a clean board
}
