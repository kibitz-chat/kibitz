import { useCallback, useEffect, useRef, useState } from 'react'
import { TWEMOJI_AVATARS } from './twemojiAvatars'
import { brand } from '../brand'

// Canvas colours for the synthesized tile — themed to the build's accent on a rebrand, the exact
// Kibitz greens by default (so the default build's PiP stays pixel-identical).
const PIP = (() => {
  const a = brand.accent
  if (!a) return { felt: '#103a2c', glow: (al: number) => `rgba(63,185,80,${al})`, dot: '#3fb950' }
  const m = /^#?([0-9a-f]{6})$/i.exec(a.trim())
  const r = m ? parseInt(m[1].slice(0, 2), 16) : 37
  const g = m ? parseInt(m[1].slice(2, 4), 16) : 99
  const b = m ? parseInt(m[1].slice(4, 6), 16) : 235
  const dk = (v: number) => Math.round(v * 0.28)
  return { felt: `rgb(${dk(r)},${dk(g)},${dk(b)})`, glow: (al: number) => `rgba(${r},${g},${b},${al})`, dot: a }
})()

// Video Picture-in-Picture — the system floating player that hovers over the home screen and
// other apps (the ONLY "hover over everything" path a web app gets on iOS). Document PiP (used
// elsewhere in the widget) floats the whole panel but is desktop-Chromium only; THIS pushes a
// single synthesized video tile to the OS PiP window, which is what mobile / iOS Safari support.
//
// We don't PiP a participant's <video> directly: the call is voice-first (often camera-off), so
// we draw the active speaker onto a CANVAS (their camera frames when on; their avatar + a
// speaking glow when off) and feed canvas.captureStream() to a hidden video that we put in PiP.
// That gives a useful floating tile even on a pure voice call, and a consistent look.
//
// Best-effort: video PiP from a canvas/MediaStream is well-supported on desktop Chromium and
// Android Chrome, works in iOS Safari for media, but iOS *standalone PWA* support is unconfirmed
// — feature-detected so the button simply hides where it can't work.

/** What the floating tile should show right now (the active speaker). */
export interface PipFocus {
  stream: MediaStream | null
  hasVideo: boolean
  name: string
  /** Emoji or a single initial, shown when there's no camera video. */
  avatar: string
  speaking: boolean
}

// iOS Safari predates the standard PiP API; it exposes PiP as a "presentation mode" on the video.
interface WebkitVideo extends HTMLVideoElement {
  webkitSetPresentationMode?: (mode: 'inline' | 'picture-in-picture' | 'fullscreen') => void
  webkitSupportsPresentationMode?: (mode: string) => boolean
  webkitPresentationMode?: 'inline' | 'picture-in-picture' | 'fullscreen'
}
// requestVideoFrameCallback (already in the DOM lib type) keeps firing even when the tab is
// BACKGROUNDED — unlike rAF — so the camera stays live in the floating window after you swipe
// home. Present on Chrome/Edge/Safari, absent on Firefox → guarded at runtime.

// The floating tile's two shapes — landscape for a desktop/landscape camera, PORTRAIT for a phone camera (so a
// portrait tile FILLS the PiP window instead of being centre-cropped to a thin strip). Chosen from the source
// video's orientation; the OS PiP window adopts the canvas aspect at ENTRY, so we size it before requesting.
const LANDSCAPE = { w: 480, h: 270 }
const PORTRAIT = { w: 270, h: 480 }
// Defaults (used until the source orientation is known, and for the voice-only avatar tile): landscape.
const W = LANDSCAPE.w
const H = LANDSCAPE.h
/** Size the canvas to match a video's orientation (portrait vs landscape). No-op if already right / dims unknown. */
function fitCanvasToVideo(canvas: HTMLCanvasElement, vw: number, vh: number): void {
  if (!vw || !vh) return
  const t = vh > vw ? PORTRAIT : LANDSCAPE
  if (canvas.width !== t.w || canvas.height !== t.h) {
    canvas.width = t.w
    canvas.height = t.h
  }
}
const EMOJI_FONT = '92px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",system-ui,sans-serif'

/** Some form of video PiP is available (standard Chromium, or iOS Safari's presentation mode).
 *  Best-effort — the only sure test is trying on the actual device. */
export function videoPipSupported(): boolean {
  if (typeof document === 'undefined' || typeof HTMLVideoElement === 'undefined') return false
  if (document.pictureInPictureEnabled) return true
  return typeof (HTMLVideoElement.prototype as WebkitVideo).webkitSetPresentationMode === 'function'
}

// Decoded Twemoji avatar images, keyed by emoji — so the floating PiP tile draws the SAME consistent
// SVG as the in-call tiles instead of the device's native emoji font (canvas fillText uses the OS font).
// Lazily decoded from the vendored SVG via a data URI: no network (works offline), same-origin so it
// never taints the canvas (captureStream keeps working). `width/height` is re-injected (the vendored SVG
// has them stripped for CSS sizing) so every browser sizes the image when drawn to canvas.
const twemojiImgCache = new Map<string, { img: HTMLImageElement; ready: boolean }>()
function twemojiAvatarImg(emoji: string): HTMLImageElement | null {
  const svg = TWEMOJI_AVATARS[emoji]
  if (!svg || typeof Image === 'undefined') return null
  let entry = twemojiImgCache.get(emoji)
  if (!entry) {
    const img = new Image()
    entry = { img, ready: false }
    twemojiImgCache.set(emoji, entry)
    img.onload = () => {
      entry!.ready = true
    }
    const sized = svg.replace('<svg ', '<svg width="144" height="144" ')
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`
  }
  return entry.ready ? entry.img : null // null until decoded → fall back to the native glyph this frame
}

/** Draw a video frame cover-fit (fill the canvas, centre-crop) — like object-fit: cover. */
function coverDraw(ctx: CanvasRenderingContext2D, video: HTMLVideoElement) {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  const scale = Math.max(W / vw, H / vh)
  const dw = vw * scale
  const dh = vh * scale
  ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh)
}

/** The avatar view (no camera): felt background, speaking glow, big emoji/initial. */
function drawAvatar(ctx: CanvasRenderingContext2D, f: PipFocus | null) {
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  ctx.fillStyle = PIP.felt
  ctx.fillRect(0, 0, W, H)
  const cx = W / 2
  const cy = H / 2 - 8
  if (f?.speaking) {
    const glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, 120)
    glow.addColorStop(0, PIP.glow(0.5))
    glow.addColorStop(1, PIP.glow(0))
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, W, H)
  }
  ctx.beginPath()
  ctx.arc(cx, cy, 72, 0, Math.PI * 2)
  ctx.fillStyle = f?.speaking ? PIP.glow(0.22) : 'rgba(255,255,255,0.06)'
  ctx.fill()
  const avatar = f?.avatar || '🙂'
  // A picked emoji → the vendored Twemoji SVG (device-consistent); a name-initial (or an emoji we didn't
  // bundle, or one not decoded yet) → the native glyph/letter via fillText.
  const img = twemojiAvatarImg(avatar)
  if (img) {
    const s = 116
    ctx.drawImage(img, cx - s / 2, cy - s / 2, s, s)
  } else {
    ctx.font = EMOJI_FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#fff'
    ctx.fillText(avatar, cx, cy)
  }
}

/** The name strip along the bottom, with a speaking dot. */
function drawLabel(ctx: CanvasRenderingContext2D, f: PipFocus | null) {
  if (!f?.name) return
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  ctx.fillStyle = 'rgba(0,0,0,0.42)'
  ctx.fillRect(0, H - 42, W, 42)
  let x = 16
  if (f.speaking) {
    ctx.beginPath()
    ctx.arc(x + 6, H - 21, 6, 0, Math.PI * 2)
    ctx.fillStyle = PIP.dot
    ctx.fill()
    x += 20
  }
  ctx.font = '600 22px system-ui,sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#fff'
  ctx.fillText(f.name.length > 22 ? `${f.name.slice(0, 21)}…` : f.name, x, H - 20)
}

interface Rig {
  wrap: HTMLDivElement
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  src: HTMLVideoElement // draws the focus's camera (kept alive in the background via rVFC)
  out: WebkitVideo // the canvas-backed video we put in PiP
  srcStream: MediaStream | null
  running: boolean
  timer: number
  onLeave: () => void // PiP-closed handlers — kept so we can removeEventListener on teardown
  onModeChange: () => void
}

/**
 * Manage a single floating video-PiP tile for the call. `getFocus` is read every frame (store it
 * however you like — it's kept in a ref), so the tile always follows the current active speaker.
 * Returns `supported` (gate the button), `active`, `toggle`, and `release` (full rig teardown — call it
 * when the call ends, since the host component never unmounts).
 */
export function useVideoPip(getFocus: () => PipFocus | null): {
  supported: boolean
  active: boolean
  toggle: () => void
  release: () => void
} {
  const [supported] = useState(videoPipSupported)
  const [active, setActive] = useState(false)
  const getRef = useRef(getFocus)
  getRef.current = getFocus
  const rigRef = useRef<Rig | null>(null)
  const enteringRef = useRef(false) // guards against a double-tap entering PiP twice (race)

  const draw = useCallback(() => {
    const rig = rigRef.current
    if (!rig) return
    const f = getRef.current()
    if (f && f.hasVideo && f.stream) {
      if (rig.srcStream !== f.stream) {
        rig.src.srcObject = f.stream
        rig.srcStream = f.stream
        rig.src.play().catch(() => {})
      }
      if (rig.src.readyState >= 2 && rig.src.videoWidth) {
        fitCanvasToVideo(rig.canvas, rig.src.videoWidth, rig.src.videoHeight) // portrait tile → portrait canvas
        coverDraw(rig.ctx, rig.src)
      } else drawAvatar(rig.ctx, f)
    } else {
      if (rig.srcStream) {
        rig.src.srcObject = null
        rig.srcStream = null
      }
      drawAvatar(rig.ctx, f)
    }
    drawLabel(rig.ctx, f)
  }, [])

  const startRender = useCallback(() => {
    const rig = rigRef.current
    if (!rig || rig.running) return
    rig.running = true
    // Interval drives the avatar/glow (and is a fallback); rVFC drives live camera frames and
    // keeps firing while backgrounded, so the floating camera doesn't freeze after you swipe home.
    rig.timer = window.setInterval(draw, 120)
    const v = rig.src
    if (typeof v.requestVideoFrameCallback === 'function') {
      const loop = () => {
        if (!rig.running) return
        draw()
        v.requestVideoFrameCallback(loop)
      }
      v.requestVideoFrameCallback(loop)
    }
  }, [draw])

  const stopRender = useCallback(() => {
    const rig = rigRef.current
    if (!rig) return
    rig.running = false
    if (rig.timer) {
      clearInterval(rig.timer)
      rig.timer = 0
    }
  }, [])

  const buildRig = useCallback((): Rig | null => {
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const src = document.createElement('video')
    src.muted = true
    src.playsInline = true
    src.autoplay = true
    const out = document.createElement('video') as WebkitVideo
    out.muted = true
    out.playsInline = true
    out.autoplay = true
    // Off-screen but NOT display:none (a hidden video may refuse to play / enter PiP).
    const wrap = document.createElement('div')
    wrap.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none'
    wrap.append(src, out)
    document.body.appendChild(wrap)
    const onLeave = () => {
      stopRender()
      setActive(false)
    }
    const onModeChange = () => {
      if (out.webkitPresentationMode !== 'picture-in-picture') onLeave()
    }
    const rig: Rig = { wrap, canvas, ctx, src, out, srcStream: null, running: false, timer: 0, onLeave, onModeChange }
    rigRef.current = rig
    drawAvatar(ctx, getRef.current()) // a first frame so captureStream has content
    out.srcObject = canvas.captureStream(12)
    out.addEventListener('leavepictureinpicture', onLeave)
    out.addEventListener('webkitpresentationmodechanged', onModeChange)
    return rig
  }, [stopRender])

  const enter = useCallback(async () => {
    if (!supported || enteringRef.current) return // no re-entry (a double-tap would desync state)
    enteringRef.current = true
    try {
      const rig = rigRef.current ?? buildRig()
      if (!rig) return
      // Size the floating tile to the active speaker's orientation BEFORE requesting PiP (the OS window locks its
      // aspect at entry). The track settings carry the camera dims even before the hidden <video> has a frame.
      const st0 = getRef.current()?.stream?.getVideoTracks?.()[0]?.getSettings?.()
      if (st0?.width && st0?.height) fitCanvasToVideo(rig.canvas, st0.width, st0.height)
      draw()
      startRender()
      try {
        await rig.out.play()
      } catch {
        /* play can be deferred; PiP request below still works from the click gesture */
      }
      try {
        const w = rig.out
        if (document.pictureInPictureEnabled && rig.out.requestPictureInPicture) {
          await rig.out.requestPictureInPicture()
        } else if (w.webkitSetPresentationMode) {
          w.webkitSetPresentationMode('picture-in-picture')
        } else {
          throw new Error('no pip')
        }
        setActive(true)
      } catch {
        stopRender()
        setActive(false)
      }
    } finally {
      enteringRef.current = false
    }
  }, [supported, buildRig, draw, startRender, stopRender])

  const exit = useCallback(() => {
    const rig = rigRef.current
    if (rig) {
      const w = rig.out as WebkitVideo
      try {
        if (document.pictureInPictureElement === rig.out) void document.exitPictureInPicture()
        else if (w.webkitSetPresentationMode && w.webkitPresentationMode === 'picture-in-picture')
          w.webkitSetPresentationMode('inline')
      } catch {
        /* already out */
      }
    }
    stopRender()
    setActive(false)
  }, [stopRender])

  const toggle = useCallback(() => {
    if (active) exit()
    else void enter()
  }, [active, enter, exit])

  // Full rig teardown: exit PiP, stop the canvas capture we own, release the off-screen decodes, remove
  // the elements. Idempotent. Runs on unmount AND — because the host Widget never unmounts — must be
  // called explicitly when the call ends. Without it, leaving a call after using PiP strands a live
  // 12fps canvas.captureStream plus an off-screen <video> still decoding the remote stream.
  const release = useCallback(() => {
    exit()
    const rig = rigRef.current
    if (rig) {
      rig.out.removeEventListener('leavepictureinpicture', rig.onLeave)
      rig.out.removeEventListener('webkitpresentationmodechanged', rig.onModeChange)
      try {
        // Stop ONLY the canvas-capture stream (we own it). NEVER stop src's stream — it's the
        // call's shared MediaStream, owned and reused by the tiles; just release our reference.
        ;(rig.out.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop())
      } catch {
        /* ignore */
      }
      rig.src.srcObject = null
      rig.out.srcObject = null
      rig.wrap.remove()
      rigRef.current = null
    }
  }, [exit])

  // Tear everything down on unmount (leaving the call).
  useEffect(() => release, [release])

  return { supported, active, toggle, release }
}
