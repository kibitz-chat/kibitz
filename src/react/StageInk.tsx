import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { InkEvent } from '../core/protocol'
import { boardFromStrokes, cloneStrokes, containRect, fromNorm, INK_PALETTE, inkColor, type Rect, type StrokeMap, switchDoodle, toNorm } from './ink'

/** The room seam the overlay needs (online room only; preview/LAN omit it). */
export interface InkRoom {
  sendInk?(e: InkEvent): void
  onInk?(cb: (from: string, name: string, e: InkEvent, color?: string) => void): void
}

type Tool = 'off' | 'laser' | 'pen'
interface Pointer {
  x: number
  y: number
  name: string
  color: string
  at: number
}

const SEND_MS = 28 // throttle pointer/draw sends (~35/s)
const PTR_FADE_MS = 1600
const PEN_W = 5
const SELF_PTR = '__self' // reserved key for the local user's own laser echo
const SELF_COLOR = '#ffd400' // amber — our own laser, distinct from peers' auto-colours

/**
 * Shared pointer + freehand annotation over a presentation. Overlays the stage
 * video's CONTENT rect (so points land on the same spot on every screen), draws ink
 * on a canvas (persists until cleared), and shows each other person's live laser
 * pointer as a labeled, auto-coloured dot. Events ride the room's `ink` broadcast.
 */
export function StageInk({
  room,
  stageRef,
  contentRef,
  zoomTransform = 'none',
  onActiveChange,
  toolbarSlot,
  selfId,
  imageKey,
}: {
  room: InkRoom | null
  stageRef: RefObject<HTMLDivElement | null>
  /** The ACTUAL rendered media element when it lives OUTSIDE .kw-stage — i.e. the presenter's staged clip/image,
   *  which sits in the panel-level .kw-staged-vid overlay, not inside the (blanked) stage tile. Ink anchors to THIS
   *  element's content rect (the picture, letterbox-excluded) mapped into stage-space, so strokes land on the
   *  screen — not on the whole stage box — and match what viewers anchor to (their in-stage video's content rect),
   *  so a doodle lines up across peers AND survives a layout reflow (e.g. opening chat). Null → measure the
   *  in-stage <video> (viewers) or, failing that, the stage box. */
  contentRef?: RefObject<HTMLVideoElement | HTMLImageElement | null>
  /** Same CSS transform the stage video is zoomed by, so ink tracks the magnified content. */
  zoomTransform?: string
  /** Identity of the IMAGE currently on the stage (e.g. the shared image's id). When it changes, the doodle for
   *  the leaving image is saved and the entering image's doodle is restored (or a clean board for a new image).
   *  `undefined` = a non-image surface (a live screen-share) — the running board is left as-is. */
  imageKey?: string
  /** Fires when a tool turns on/off, so the host can pin the auto-hiding chrome while annotating. */
  onActiveChange?: (active: boolean) => void
  /** Where to render the toolbar. The stage has touch-action:none + the zoom listeners, which on iOS
   *  swallow taps to its children — so the toolbar is portalled OUT to a slot beside the tiles instead.
   *  Null → render inline (fallback). The canvas/pointer overlay always stays in the stage. */
  toolbarSlot?: HTMLElement | null
  /** Our own participant id — so the LOCAL laser echo uses inkColor(selfId), the SAME colour peers
   *  compute for us (they auto-colour by sender id). Without it, you'd see your own laser in a generic
   *  colour while everyone else saw it in your assigned hue. */
  selfId?: string
}) {
  const [rect, setRect] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 })
  const rectRef = useRef(rect)
  rectRef.current = rect
  const [tool, setTool] = useState<Tool>('off')
  const toolRef = useRef(tool)
  toolRef.current = tool
  const [color, setColor] = useState<string>(INK_PALETTE[0])
  const colorRef = useRef(color)
  colorRef.current = color
  // The colour swatches are a popup ABOVE the pen (not an inline row): tap the pen to raise it, pick a
  // colour → the pen adopts it and the popup auto-hides. Keeps the toolbar to one pen in the chat box.
  const [paletteOpen, setPaletteOpen] = useState(false)
  // Keep the colour popup on-screen. It's centred on the pen (translateX(-50%)); when the toolbar sits near a
  // screen edge — e.g. the left column with chat open — the centred pill overflowed the viewport and clipped the
  // first swatch (red) off the left. After it opens, measure and nudge it horizontally back inside the viewport.
  const paletteRef = useRef<HTMLSpanElement>(null)
  const [paletteShift, setPaletteShift] = useState(0)
  useLayoutEffect(() => {
    if (!paletteOpen) {
      setPaletteShift(0)
      return
    }
    const el = paletteRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = window.visualViewport?.width ?? window.innerWidth
    const M = 8 // keep this much gap from the viewport edge
    let dx = 0
    if (r.left < M) dx = M - r.left // spilling off the left → push right
    else if (r.right > vw - M) dx = vw - M - r.right // spilling off the right → push left
    setPaletteShift((prev) => (Math.abs(prev - dx) < 0.5 ? prev : dx)) // deps=[paletteOpen] only → no measure loop
  }, [paletteOpen])
  const selfIdRef = useRef(selfId)
  selfIdRef.current = selfId
  const [pointers, setPointers] = useState<Record<string, Pointer>>({})

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const strokesRef = useRef<StrokeMap>(new Map())
  const sidRef = useRef(0)
  const lastSendRef = useRef(0)
  // Per-image doodle store: imageKey → that image's saved board. The live board (strokesRef) is swapped in/out
  // of here as the shared image changes (see the effect below).
  const savedByImageRef = useRef<Map<string, StrokeMap>>(new Map())
  const prevImageKeyRef = useRef<string | undefined>(undefined)

  // --- Track the video's content rect (letterboxed area), robustly across the
  // share starting, resolution changes, and panel resize. -----------------------
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () => {
      // 1) PRESENTER's staged clip/image: the media is rendered in a SEPARATE panel-level overlay (.kw-staged-vid),
      //    NOT inside .kw-stage. Anchor ink to THAT element's content rect (the picture, letterbox excluded), mapped
      //    into stage-space — so strokes land on the screen, survive a layout reflow (chat open re-letterboxes the
      //    clip), and match viewers (who anchor to their in-stage video's content rect → cross-peer alignment).
      const ext = contentRef?.current
      if (ext) {
        const eb = ext.getBoundingClientRect()
        const sb = stage.getBoundingClientRect()
        const nw = (ext as HTMLVideoElement).videoWidth || (ext as HTMLImageElement).naturalWidth || 0
        const nh = (ext as HTMLVideoElement).videoHeight || (ext as HTMLImageElement).naturalHeight || 0
        if (eb.width && nw && nh) {
          const c = containRect(eb.width, eb.height, nw, nh) // content rect within the element (letterbox offset)
          const r = { x: Math.round(eb.left - sb.left + c.x), y: Math.round(eb.top - sb.top + c.y), w: Math.round(c.w), h: Math.round(c.h) }
          setRect((p) => (p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h ? p : r))
          return
        }
        // element mounted but not yet measurable (metadata pending) → fall through; the 500ms tick re-tries.
      }
      // 2) VIEWER: the share <video> is INSIDE .kw-stage (fills it) — its content rect is already stage-relative.
      //    3) Fallback (no measurable media): the full stage box, so the pen still has an area.
      const v = stage.querySelector('video')
      const r =
        v && v.clientWidth
          ? containRect(v.clientWidth, v.clientHeight, v.videoWidth, v.videoHeight)
          : stage.clientWidth
            ? { x: 0, y: 0, w: stage.clientWidth, h: stage.clientHeight }
            : null
      if (!r) return
      setRect((p) => (p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h ? p : r))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(stage)
    if (contentRef?.current) ro.observe(contentRef.current) // re-measure when the overlay clip resizes/reflows
    const id = setInterval(measure, 500) // catch late metadata / a resolution change / a mid-effect media swap
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      clearInterval(id)
      window.removeEventListener('resize', measure)
    }
  }, [stageRef, contentRef])

  // --- Canvas drawing ----------------------------------------------------------
  const ctx = () => canvasRef.current?.getContext('2d') ?? null

  const drawSeg = useCallback((c: CanvasRenderingContext2D, color: string, a: { x: number; y: number }, b: { x: number; y: number }, r: Rect) => {
    const p0 = fromNorm(a.x, a.y, { x: 0, y: 0, w: r.w, h: r.h })
    const p1 = fromNorm(b.x, b.y, { x: 0, y: 0, w: r.w, h: r.h })
    c.strokeStyle = color
    c.lineWidth = PEN_W
    c.lineCap = 'round'
    c.lineJoin = 'round'
    c.beginPath()
    c.moveTo(p0.x, p0.y)
    c.lineTo(p1.x, p1.y)
    c.stroke()
  }, [])

  const redraw = useCallback(() => {
    const c = ctx()
    const cv = canvasRef.current
    if (!c || !cv) return
    const r = rectRef.current
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.max(1, Math.round(r.w * dpr))
    cv.height = Math.max(1, Math.round(r.h * dpr))
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.clearRect(0, 0, r.w, r.h)
    for (const s of strokesRef.current.values()) {
      for (let i = 1; i < s.pts.length; i++) drawSeg(c, s.color, s.pts[i - 1], s.pts[i], r)
    }
  }, [drawSeg])

  // Re-fit + repaint whenever the content rect changes.
  useEffect(() => {
    redraw()
  }, [rect, redraw])

  // Per-IMAGE doodle: when the stage image changes, save the leaving image's doodle and restore the entering
  // one (or a clean board for a new image). Skips when imageKey is unchanged or absent (a live screen-share
  // keeps its running board). The local board persists per-viewer for this session — re-showing an image you
  // doodled on brings YOUR view of that doodle back.
  useEffect(() => {
    if (imageKey === prevImageKeyRef.current) return
    strokesRef.current = switchDoodle(savedByImageRef.current, strokesRef.current, prevImageKeyRef.current, imageKey)
    prevImageKeyRef.current = imageKey
    redraw()
  }, [imageKey, redraw])

  const addPoint = useCallback(
    (key: string, color: string, pt: { x: number; y: number }, start: boolean) => {
      const map = strokesRef.current
      let s = map.get(key)
      if (start || !s) {
        s = { color, pts: [pt] }
        map.set(key, s)
        return
      }
      const prev = s.pts[s.pts.length - 1]
      s.pts.push(pt)
      const c = ctx()
      if (c && prev) drawSeg(c, s.color, prev, pt, rectRef.current)
    },
    [drawSeg],
  )

  // Clear only ONE person's strokes — your own (the reserved SELF_PTR key) or a peer's
  // (their id). Strokes are keyed `${who}:${sid}`, so a person can wipe their drawing
  // without erasing everyone else's. Clearing all was wrong: it let anyone nuke the board.
  // (Own strokes use SELF_PTR, not a 'me' literal, so no real peer id can collide.)
  const clearBy = useCallback(
    (who: string) => {
      const map = strokesRef.current
      let changed = false
      for (const key of [...map.keys()]) {
        if (key.startsWith(`${who}:`)) {
          map.delete(key)
          changed = true
        }
      }
      if (changed) redraw()
    },
    [redraw],
  )

  // --- Receive others' ink -----------------------------------------------------
  useEffect(() => {
    const r = room
    if (!r?.onInk) return
    r.onInk((from, name, e, color) => {
      // Prefer the mover's STAMPED colour (same for everyone) — falls back to inkColor(from) only for an
      // older sender that didn't stamp it. For pen strokes the drawer's chosen pen colour wins.
      const who = color || inkColor(from)
      if (e.k === 'ptr') {
        setPointers((prev) => ({ ...prev, [from]: { x: e.x, y: e.y, name: name || 'Guest', color: who, at: performance.now() } }))
      } else if (e.k === 'draw') {
        addPoint(`${from}:${e.sid}`, e.color || who, { x: e.x, y: e.y }, !!e.start)
      } else if (e.k === 'clear') {
        clearBy(from) // a clear wipes only the SENDER's strokes, not the whole board
      } else if (e.k === 'restore' && e.image) {
        // The stager replayed an image's doodle (sync — so late joiners / cleared views get it). Store it in the
        // per-image store; if it's the image we're showing RIGHT NOW, paint it. Storing it (not just painting)
        // is race-proof: whether this arrives before or after the imageKey change, switchDoodle reads it on switch.
        const board = boardFromStrokes(e.strokes || [])
        savedByImageRef.current.set(e.image, board)
        if (e.image === prevImageKeyRef.current) {
          strokesRef.current = cloneStrokes(board)
          redraw()
        }
      }
    })
    // onInk is single-subscriber (it replaces an internal ref) — drop our callback on
    // teardown/room-change so a previous room's late ink can't mutate this overlay.
    return () => { r.onInk?.(() => {}) }
  }, [room, addPoint, clearBy, redraw])

  // Fade out idle pointers.
  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now()
      setPointers((prev) => {
        let changed = false
        const next: Record<string, Pointer> = {}
        for (const [k, p] of Object.entries(prev)) {
          if (now - p.at < PTR_FADE_MS) next[k] = p
          else changed = true
        }
        return changed ? next : prev
      })
    }, 600)
    return () => clearInterval(id)
  }, [])

  // --- Local capture -----------------------------------------------------------
  const send = useCallback(
    (e: InkEvent, throttle: boolean) => {
      if (throttle) {
        const now = performance.now()
        if (now - lastSendRef.current < SEND_MS) return
        lastSendRef.current = now
      }
      room?.sendInk?.(e)
    },
    [room],
  )

  const norm = useCallback((ev: React.PointerEvent) => {
    const host = canvasRef.current
    if (!host) return null
    const b = host.getBoundingClientRect()
    return toNorm(ev.clientX - b.left, ev.clientY - b.top, { x: 0, y: 0, w: b.width, h: b.height })
  }, [])

  const onDown = useCallback(
    (ev: React.PointerEvent) => {
      if (toolRef.current !== 'pen') return
      const n = norm(ev)
      if (!n) return
      ev.currentTarget.setPointerCapture(ev.pointerId)
      sidRef.current += 1
      addPoint(`${SELF_PTR}:${sidRef.current}`, colorRef.current, n, true)
      send({ k: 'draw', sid: sidRef.current, x: n.x, y: n.y, start: true, color: colorRef.current }, false)
    },
    [norm, addPoint, send],
  )

  const onMove = useCallback(
    (ev: React.PointerEvent) => {
      const n = norm(ev)
      if (!n) return
      if (toolRef.current === 'laser') {
        send({ k: 'ptr', x: n.x, y: n.y }, true)
        // Echo our OWN laser locally — otherwise you can't see where you're pointing
        // (others get it over the wire, but you never receive your own ink). No name on
        // it: it's YOUR pointer, a label would just be a wrong/cluttering tag on yourself.
        // Colour it with OUR assigned hue (inkColor(selfId)) so we see exactly the colour the
        // audience sees; fall back to a neutral amber only if the id isn't known yet.
        const mineColor = selfIdRef.current ? inkColor(selfIdRef.current) : SELF_COLOR
        setPointers((prev) => ({ ...prev, [SELF_PTR]: { x: n.x, y: n.y, name: '', color: mineColor, at: performance.now() } }))
      } else if (toolRef.current === 'pen' && ev.buttons) {
        const now = performance.now()
        if (now - lastSendRef.current < SEND_MS) return
        lastSendRef.current = now
        addPoint(`${SELF_PTR}:${sidRef.current}`, colorRef.current, n, false)
        room?.sendInk?.({ k: 'draw', sid: sidRef.current, x: n.x, y: n.y })
      }
    },
    [norm, send, room],
  )

  const active = tool !== 'off'
  // Tell the host whenever a tool turns on/off (it pins the auto-hiding chrome while
  // you annotate) — and always clear the flag when this overlay unmounts (share ended).
  // biome note: project has no linter; deps are correct (onActiveChange is stable).
  useEffect(() => {
    onActiveChange?.(active)
  }, [active, onActiveChange])
  useEffect(() => () => onActiveChange?.(false), [onActiveChange])

  const can = !!room?.sendInk
  if (!can) return null

  const toolbar = (
    <div className="kw-ink-bar">
      <button
        className={`kw-ink-tool${tool === 'laser' ? ' on' : ''}`}
        onClick={() => { setTool((t) => (t === 'laser' ? 'off' : 'laser')); setPaletteOpen(false) }}
        title="Laser pointer — others see where you point"
      >
        👆
      </button>
      {/* The pen carries the current colour; tapping it raises the colour popup ABOVE. Cycle:
          off → pen + palette → (pick) pen drawing → (tap) palette again → (tap) off. */}
      <span className="kw-ink-pen-wrap">
        {paletteOpen && (
          <span
            ref={paletteRef}
            className="kw-ink-palette"
            role="listbox"
            aria-label="Pen colour"
            style={paletteShift ? { transform: `translateX(calc(-50% + ${paletteShift}px))` } : undefined}
          >
            {INK_PALETTE.map((c) => (
              <button
                key={c}
                className={`kw-ink-sw${color === c ? ' on' : ''}`}
                style={{ background: c }}
                onClick={() => { setColor(c); setPaletteOpen(false) }}
                aria-label={`Pen colour ${c}`}
              />
            ))}
          </span>
        )}
        <button
          className={`kw-ink-tool kw-ink-pen${tool === 'pen' ? ' on' : ''}`}
          style={{ ['--pen' as string]: color }}
          onClick={() => {
            if (tool !== 'pen') { setTool('pen'); setPaletteOpen(true) } // turn on → raise the colours
            else if (!paletteOpen) setPaletteOpen(true) // on, closed → re-pick
            else { setTool('off'); setPaletteOpen(false) } // on, palette up → tap again to put it away
          }}
          title="Draw on the shared screen — tap for colours"
        >
          ✏️
        </button>
      </span>
      <button className="kw-ink-tool" onClick={() => { clearBy(SELF_PTR); send({ k: 'clear' }, false) }} title="Clear MY drawing (leaves everyone else's)">
        🧹
      </button>
    </div>
  )

  return (
    <>
      {/* Canvas + live pointers ride the SAME zoom transform as the video (origin top-left of the stage)
          so a magnified screen stays annotation-aligned. These MUST stay in the stage (they overlay the
          video); only the toolbar moves out. */}
      <div className="kw-ink-zoom" style={{ transform: zoomTransform, transformOrigin: '0 0' }}>
        <canvas
          ref={canvasRef}
          className="kw-ink-canvas"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, pointerEvents: active ? 'auto' : 'none', cursor: tool === 'pen' ? 'crosshair' : 'default' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
        />
        <div className="kw-ink-ptrs" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
          {Object.entries(pointers).map(([k, p]) => {
            const px = fromNorm(p.x, p.y, { x: 0, y: 0, w: rect.w, h: rect.h })
            return (
              <span
                key={k}
                className="kw-ink-ptr"
                // Our OWN dot tracks the finger/cursor 1:1 — the smoothing transition is only there to
                // interpolate peers' THROTTLED updates, and on the local echo it just reads as lag.
                style={{ left: px.x, top: px.y, color: p.color, transition: k === SELF_PTR ? 'none' : undefined }}
              >
                <span
                  className="kw-ink-dot"
                  // A bright, glowing dot that's hard to miss on a busy screen: a white ring for contrast on
                  // any background + a soft halo in the pointer's own colour.
                  style={{ background: p.color, boxShadow: `0 0 0 2.5px rgba(255,255,255,0.95), 0 0 16px 4px ${p.color}` }}
                />
                {p.name && <span className="kw-ink-name">{p.name}</span>}
              </span>
            )
          })}
        </div>
      </div>
      {/* The toolbar lives OUTSIDE the stage (beside the tiles) — see toolbarSlot above. */}
      {toolbarSlot ? createPortal(toolbar, toolbarSlot) : toolbar}
    </>
  )
}
