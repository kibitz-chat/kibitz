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
