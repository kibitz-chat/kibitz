import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type React from 'react'

const POS_KEY = 'kibitz.widget.pos2' // left/top coords (v2 — was bottom-right offsets)
const SIZE_KEY = 'kibitz.widget.size' // user-dragged panel width + tile-area height
const DRAG_THRESHOLD = 6 // px of movement before a header press becomes a drag (vs a tap)
const MIN_W = 240 // resize clamps — smaller than this and the controls crowd
export const MIN_H = 130

interface Pos {
  x: number // viewport left/top of the panel, in px
  y: number
}
/** Panel width + tile-area height once the user has corner-dragged it; null = the
 *  CSS defaults (300px / content-driven). */
interface Size {
  w: number
  h: number
}

function loadPos(): Pos | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Pos
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) return p
    }
  } catch {
    /* ignore */
  }
  return null // default: the CSS bottom-right anchor
}
function loadSize(): Size | null {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    if (raw) {
      const s = JSON.parse(raw) as Size
      if (Number.isFinite(s.w) && Number.isFinite(s.h) && s.w >= MIN_W && s.h >= MIN_H) return s
    }
  } catch {
    /* ignore */
  }
  return null
}

// The floating panel's window geometry, lifted out of Widget.tsx (~180 lines). DRAG-to-move the whole header (a
// press only becomes a drag past a 6px threshold so taps stay taps; pointer-captured; the trailing click swallowed),
// edge/corner RESIZE like a real window (the dragged side follows the pointer, opposite edges pinned), plus three
// effects: re-clamp a moved panel on window resize, the iOS-standalone landscape-rotation re-layout hack, and a
// re-clamp when the stage widens/narrows. Persists pos/size to localStorage. Returns pos/size + panelRef + the
// drag/resize pointer handlers, consumed by the panel header + resize edges + the panelStyle. A pure verbatim move.
export function usePanelDrag(
  fill: boolean,
  canTouch: boolean,
  tilesRef: RefObject<HTMLDivElement | null>,
  presenter: unknown,
  chatOpen: boolean,
) {
  const [pos, setPos] = useState<Pos | null>(loadPos)
  const [size, setSize] = useState<Size | null>(loadSize)
  // Drag — the original pattern: the WHOLE header drags, buttons included. A
  // press only becomes a drag past a 6px threshold (so taps stay taps); the
  // pointer is captured once dragging, and the click that trails a real drag
  // is swallowed so the button under the finger doesn't fire.
  const panelRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ ox: number; oy: number; gx: number; gy: number; moved: boolean } | null>(null)
  const draggedRef = useRef(false)

  const clampPos = useCallback((x: number, y: number): Pos => {
    const rect = panelRef.current?.getBoundingClientRect()
    const w = rect?.width ?? 300
    const h = rect?.height ?? 160
    return {
      x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w)),
      y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - h)),
    }
  }, [])

  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (fill) return // the room window is anchored — resize it by its edges, don't drag it
    draggedRef.current = false // clear any stale suppression
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    dragRef.current = { ox: e.clientX - rect.left, oy: e.clientY - rect.top, gx: e.clientX, gy: e.clientY, moved: false }
  }
  const onBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    if (!d.moved) {
      if (Math.abs(e.clientX - d.gx) + Math.abs(e.clientY - d.gy) < DRAG_THRESHOLD) return
      d.moved = true
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }
    setPos(clampPos(e.clientX - d.ox, e.clientY - d.oy))
  }
  const onBarUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.moved) {
      draggedRef.current = true // suppress the click that follows a drag
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      setPos((p) => {
        try {
          if (p) localStorage.setItem(POS_KEY, JSON.stringify(p))
        } catch {
          /* ignore */
        }
        return p
      })
    }
    dragRef.current = null
  }
  const onBarClickCapture = (e: React.MouseEvent) => {
    if (draggedRef.current) {
      e.preventDefault()
      e.stopPropagation()
      draggedRef.current = false
    }
  }

  // Window-style resize from ANY edge / corner (pointer events → mouse AND touch, desktop-only via CSS).
  // On grab we snapshot the four edges + the tile/chrome split; whichever edge(s) the chosen handle drives
  // (l/r/t/b) follow the pointer while the OPPOSITE edges stay pinned — exactly like a real window. Width
  // sizes the panel; height sizes the tile area (grid / stage); `chrome` is the constant non-tile part.
  const resizeRef = useRef<{ L: number; T: number; R: number; B: number; chrome: number; l: boolean; r: boolean; t: boolean; b: boolean } | null>(null)
  const startResize = (l: boolean, r: boolean, t: boolean, b: boolean) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    setPos((p) => p ?? { x: rect.left, y: rect.top }) // pin the current top-left so the panel can move
    const tileH = tilesRef.current?.getBoundingClientRect().height ?? 200
    resizeRef.current = { L: rect.left, T: rect.top, R: rect.right, B: rect.bottom, chrome: Math.max(0, rect.height - tileH), l, r, t, b }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const z = resizeRef.current
    if (!z) return
    const M = 8 // keep the box this far inside the viewport on every edge
    const vw = window.innerWidth
    const vh = window.innerHeight
    const maxW = Math.max(MIN_W, vw - 2 * M)
    const maxH = Math.max(MIN_H, vh - 2 * M)
    // Horizontal: the dragged side follows the pointer but is CLAMPED to the viewport (so the box never
    // runs off-screen right/left); the opposite side stays pinned. Then derive width + left.
    const left = z.l ? Math.max(M, Math.min(e.clientX, z.R - MIN_W)) : z.L
    const right = z.r ? Math.min(vw - M, Math.max(e.clientX, z.L + MIN_W)) : z.R
    const w = Math.min(Math.max(MIN_W, right - left), maxW)
    const posX = z.l ? right - w : left // left moved → right edge fixed; else left edge fixed
    // Vertical: same, on the panel height (chrome + tile), clamped top/bottom to the viewport.
    const top = z.t ? Math.max(M, Math.min(e.clientY, z.B - (z.chrome + MIN_H))) : z.T
    const bottom = z.b ? Math.min(vh - M, Math.max(e.clientY, z.T + z.chrome + MIN_H)) : z.B
    const h = Math.min(Math.max(MIN_H, bottom - top - z.chrome), maxH)
    const posY = z.t ? bottom - (z.chrome + h) : top // top moved → bottom edge fixed; else top edge fixed
    setSize({ w, h })
    setPos({ x: Math.max(M, posX), y: Math.max(M, posY) })
  }
  const onResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return
    resizeRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    setSize((s) => {
      try {
        if (s) localStorage.setItem(SIZE_KEY, JSON.stringify(s))
      } catch {
        /* ignore */
      }
      return s
    })
    setPos((p) => {
      try {
        if (p) localStorage.setItem(POS_KEY, JSON.stringify(p))
      } catch {
        /* ignore */
      }
      return p
    })
  }

  // Keep a moved panel on-screen across rotation / resize.
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampPos(p.x, p.y) : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampPos])

  // iOS STANDALONE PWA, the moment you rotate to landscape: it leaves a PHANTOM document scroll behind
  // AND a stale position:fixed hit map, so taps land offset (you tap the control, the hit lands where it
  // was before the rotation) until a real touch re-syncs it (the user's "touch the header fixes it").
  // Compositing the panel + a transform nudge didn't move it. This resets the phantom scroll and forces
  // a genuine RE-LAYOUT of the fixed panel (a 0.01% height blip) after the rotation settles — the closest
  // programmatic equivalent to the manual touch. Touch devices only; debounced past iOS's settle delay.
  useEffect(() => {
    if (!canTouch) return
    // Gate on the orientation FLIP: `resize` also fires for the on-screen keyboard and
    // chrome collapse, and blipping the panel height on those causes a visible jump while
    // typing in chat. Only a real rotation needs the re-layout (checked after the settle).
    let wasLandscape = window.innerWidth > window.innerHeight
    const fix = () => {
      const landscape = window.innerWidth > window.innerHeight
      if (landscape === wasLandscape) return // not a rotation — don't blip the live panel
      wasLandscape = landscape
      try {
        window.scrollTo(0, 0)
      } catch {
        /* ignore */
      }
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0
      const el = panelRef.current
      if (!el) return
      const prev = el.style.height
      el.style.height = '100.01%' // a real (imperceptible) size change → forces the fixed panel to re-lay-out + re-hit-test
      void el.offsetHeight
      el.style.height = prev
    }
    let t = 0
    const onRotate = () => {
      clearTimeout(t)
      t = window.setTimeout(fix, 350) // iOS settles the new orientation a beat after the event fires
    }
    window.addEventListener('orientationchange', onRotate)
    window.addEventListener('resize', onRotate)
    return () => {
      clearTimeout(t)
      window.removeEventListener('orientationchange', onRotate)
      window.removeEventListener('resize', onRotate)
    }
  }, [canTouch])

  // The panel widens for the stage (and narrows again when chat covers it); re-clamp
  // a dragged panel so it can't overflow the right edge as the width changes.
  useEffect(() => {
    setPos((p) => (p ? clampPos(p.x, p.y) : p))
  }, [presenter, chatOpen, clampPos])

  return { pos, size, panelRef, onBarDown, onBarMove, onBarUp, onBarClickCapture, startResize, onResizeMove, onResizeUp }
}
