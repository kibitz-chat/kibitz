import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

/**
 * Pinch-to-zoom + pan on the presenter stage (a shared screen). This is a LOCAL
 * view operation — each viewer zooms their own copy; nothing rides the wire. It
 * lets someone magnify small text on a shared screen the same way they'd pinch a
 * photo. The result is a CSS `transform` the caller applies to the stage content
 * (the video tile AND the ink overlay, so annotations stay aligned while zoomed).
 *
 * Gestures (touch only — a mouse uses the page, a screen-share rarely needs it):
 *   • two fingers → scale about the pinch midpoint, panning as the fingers move
 *   • one finger while zoomed in → pan
 *   • double-tap → toggle between fit (1×) and 2.5× centred on the tap
 *
 * Zoom is only wired when the ink tool is OFF: an active pen/laser puts the ink
 * canvas (pointer-events:auto) on top, so it eats the touches and drawing wins —
 * no explicit coordination needed, it falls out of the existing z-order.
 */

const MIN = 1
const MAX = 4
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_SLOP = 24 // px — a second tap farther than this starts a fresh count
const TAP_MOVE_SLOP = 10 // px — movement above this is a drag, not a tap
const DBL_ZOOM = 2.5 // the level a double-tap jumps to

interface ZoomState {
  s: number
  tx: number
  ty: number
}
const IDENT: ZoomState = { s: 1, tx: 0, ty: 0 }

/** Keep the scaled content covering the stage: translate is bounded so the edges
 *  can't be dragged inside the frame (origin is the stage's top-left). At s=1 the
 *  only valid translate is 0,0 — so zooming back out auto-recentres. */
function clamp(st: ZoomState, w: number, h: number): ZoomState {
  const s = Math.min(MAX, Math.max(MIN, st.s))
  return {
    s,
    tx: Math.min(0, Math.max(w * (1 - s), st.tx)),
    ty: Math.min(0, Math.max(h * (1 - s), st.ty)),
  }
}

interface Result {
  /** CSS transform string for the stage content; 'none' when not zoomed. */
  transform: string
  /** True once the user has zoomed in (drives a "reset" affordance + touch-action). */
  zoomed: boolean
  /** Snap back to fit (1×, centred). */
  reset: () => void
}

export function useStageZoom(stageRef: RefObject<HTMLElement | null>, enabled: boolean, resetKey?: string): Result {
  const [state, setState] = useState<ZoomState>(IDENT)
  const stateRef = useRef(state)
  stateRef.current = state

  // Live pointers on the stage, in stage-local coordinates.
  const ptrs = useRef<Map<number, { x: number; y: number }>>(new Map())
  // Baseline captured when the pointer count changes — the maths is relative to it.
  const base = useRef<{ st: ZoomState; ids: number[]; pts: { x: number; y: number }[]; dist: number; mid: { x: number; y: number } } | null>(null)
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null)
  const moved = useRef(false)

  const reset = useCallback(() => setState(IDENT), [])

  // A fresh presenter (or leaving the stage) starts from fit.
  useEffect(() => {
    setState(IDENT)
    ptrs.current.clear()
    base.current = null
  }, [resetKey, enabled])

  useEffect(() => {
    const el = stageRef.current
    if (!el || !enabled) return

    const local = (e: PointerEvent) => {
      const r = el.getBoundingClientRect() // the stage box isn't transformed — only its children are
      return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }
    }

    // Snapshot the current gesture so later moves are measured against a fixed start.
    const rebase = () => {
      const entries = [...ptrs.current.entries()]
      const ids = entries.map(([id]) => id)
      const pts = entries.map(([, p]) => p)
      let dist = 0
      let mid = { x: 0, y: 0 }
      if (pts.length >= 2) {
        const [a, b] = pts
        dist = Math.hypot(a.x - b.x, a.y - b.y)
        mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      } else if (pts.length === 1) {
        mid = pts[0]
      }
      base.current = { st: stateRef.current, ids, pts, dist, mid }
    }

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return
      // A touch that lands on a CONTROL (the ink canvas while a tool is active, the
      // pen/laser toolbar, the reset chip, any button) must NOT start a zoom/pan: the
      // event still BUBBLES to this stage listener, so without this guard a draw would
      // also pan and a button tap would be eaten by a one-finger pan (the "panel is
      // unresponsive while zoomed" bug). Zoom/pan only on the bare video surface.
      if ((e.target as HTMLElement | null)?.closest?.('button, .kw-ink-canvas, .kw-ink-bar')) return
      const p = local(e)
      ptrs.current.set(e.pointerId, { x: p.x, y: p.y })
      moved.current = false
      // Capture so move/up keep routing to the stage even when a finger drifts over a
      // child or past the stage edge mid-pinch — otherwise a brief boundary cross would
      // drop that pointer and silently degrade a two-finger pinch into a one-finger pan.
      // (Controls already returned above, so buttons/ink are never captured.) Auto-released
      // on pointerup/cancel.
      try { el.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
      rebase()
    }

    const onMove = (e: PointerEvent) => {
      if (!ptrs.current.has(e.pointerId)) return
      const p = local(e)
      ptrs.current.set(e.pointerId, { x: p.x, y: p.y })
      const b = base.current
      if (!b) return
      const count = ptrs.current.size

      if (count >= 2) {
        e.preventDefault()
        const live = b.ids.map((id) => ptrs.current.get(id)).filter(Boolean) as { x: number; y: number }[]
        if (live.length < 2) return
        const [a, c] = live
        const dist = Math.hypot(a.x - c.x, a.y - c.y)
        const mid = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }
        if (!b.dist) return
        const ns = b.st.s * (dist / b.dist)
        // Keep the content point that sat under the pinch's start-midpoint under the
        // live midpoint (so the pinch zooms about the fingers and pans as they move).
        const cx = (b.mid.x - b.st.tx) / b.st.s
        const cy = (b.mid.y - b.st.ty) / b.st.s
        moved.current = true
        setState(clamp({ s: ns, tx: mid.x - cx * ns, ty: mid.y - cy * ns }, p.w, p.h))
      } else if (count === 1 && b.st.s > 1) {
        const dx = p.x - b.mid.x
        const dy = p.y - b.mid.y
        if (Math.abs(dx) > TAP_MOVE_SLOP || Math.abs(dy) > TAP_MOVE_SLOP) {
          e.preventDefault()
          moved.current = true
          setState(clamp({ s: b.st.s, tx: b.st.tx + dx, ty: b.st.ty + dy }, p.w, p.h))
        }
      }
    }

    const onUp = (e: PointerEvent) => {
      if (!ptrs.current.has(e.pointerId)) return
      const wasSingle = ptrs.current.size === 1
      const p = local(e)
      ptrs.current.delete(e.pointerId)
      // Double-tap toggles fit ⇄ 2.5× centred on the tap — only a clean single-finger tap.
      if (wasSingle && !moved.current && e.pointerType !== 'mouse') {
        const prev = lastTap.current
        const isDbl = prev && e.timeStamp - prev.t < DOUBLE_TAP_MS && Math.hypot(p.x - prev.x, p.y - prev.y) < DOUBLE_TAP_SLOP
        if (isDbl) {
          lastTap.current = null
          const cur = stateRef.current
          if (cur.s > 1) setState(IDENT)
          else setState(clamp({ s: DBL_ZOOM, tx: p.x - p.x * DBL_ZOOM, ty: p.y - p.y * DBL_ZOOM }, p.w, p.h))
        } else {
          lastTap.current = { t: e.timeStamp, x: p.x, y: p.y }
        }
      }
      // All fingers up: clear the gesture AND the moved flag, so the next clean tap
      // isn't pre-poisoned by movement from the gesture that just ended (a pan/pinch
      // would otherwise leave moved=true and suppress the following double-tap).
      if (ptrs.current.size > 0) rebase()
      else { base.current = null; moved.current = false }
    }

    const onCancel = (e: PointerEvent) => {
      ptrs.current.delete(e.pointerId)
      if (ptrs.current.size > 0) rebase()
      else { base.current = null; moved.current = false }
    }

    // No pointerleave: with setPointerCapture, pointercancel covers genuine cancellation
    // and leave-the-box no longer drops a live pointer (the pinch-into-pan degrade bug).
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove, { passive: false })
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      ptrs.current.clear()
      base.current = null
    }
  }, [stageRef, enabled])

  const zoomed = state.s > 1.001
  return {
    transform: zoomed ? `translate(${state.tx}px, ${state.ty}px) scale(${state.s})` : 'none',
    zoomed,
    reset,
  }
}
