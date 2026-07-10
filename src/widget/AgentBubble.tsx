// One floating agent-control bubble — a draggable pill that expands into a mini control panel.
// Spec: docs/floating-agent-control.md (kibitz repo). This is a re-skin of AgentActionsBar onto the
// same `agent-actions@1` manifest + roster-meta state; it sends the same action messages via
// call.sendAppTo. Two flavours share the component:
//   • an AGENT bubble (a present agent participant + its manifest) — engage/disengage, scribe, leave, caps
//   • the creator's SUMMON bubble (no agent yet) — its job is to summon one
// Rendered as an absolutely-positioned child of `.kw-stagewrap` (like the existing agent overlays); all
// styling is in widget.css (kw-agb*), injected into the shadow root.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CallController, CallParticipant } from '../react/useCall'
import { EmojiAvatar } from '../react/CallSurface'
import { actionMessage, type AgentMenu } from './agentActions'
import { type HostMenu } from './hostMenu'
import { deriveState, subStatus, pillWord, splitActions, scribeEnabledFromLabel, engagedFromMeta } from './agentBubbleState'
import { wt, isRtl } from '../react/i18n'

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
// The bubble is sized for phones; on a wide desktop that reads as tiny. Scale it up SMOOTHLY with the container
// width (the call body) — applied as the CSS var --agb-s (widget.css .kw-agb) + the panel width. It's REAL layout
// scaling (calc()/font-size, not a transform), so the drag/position math (which reads offsetWidth) stays exact.
const scaleFor = (parentW: number) => clamp(Math.round((parentW / 820) * 100) / 100, 1, 1.5)
const DRAG_THRESHOLD = 6
const TOP_SAFE = 8 // keep the pill clear of the top of the window (the call bar auto-hides, so this is small)
const BOT_SAFE = 72 // keep it clear of the bottom control bar (mic / cam / leave)
const MARGIN = 12 // horizontal gutter from the screen edges
// Progressing "Summoning…" copy: a cold agent can take a while, so the label steps forward every 15s (holding on
// the last) instead of a static "Summoning…" that reads as stuck. Driven by the summonStep timer in the component.
const SUMMON_STEPS = ['Summoning…', 'Waking the agent…', 'Getting it ready…', 'Almost there…', 'Still on it — hang tight…']

// A value that only follows `input` after it has held steady for `ms` — used to keep the Ready⇄Engaged
// button from strobing as the agent flips busy between tool calls.
function useDebounced<T>(input: T, ms: number): T {
  const [v, setV] = useState(input)
  useEffect(() => {
    const t = setTimeout(() => setV(input), ms)
    return () => clearTimeout(t)
  }, [input, ms])
  return v
}

export interface AgentBubbleProps {
  call: CallController
  isCreator: boolean
  open: boolean
  onOpen: () => void
  onClose: () => void
  index: number
  /** AGENT flavour: */
  participant?: CallParticipant
  menu?: AgentMenu
  speaking?: boolean
  /** The agent's brand host menu (e.g. "Rate the agent"), if it published one. The overlay is rendered by
   *  the layer (outside this bubble's transform), so we just hand the chosen menu up via onRate. */
  hostMenu?: HostMenu
  onRate?: (hm: HostMenu) => void
  topupUrl?: string // creator-only "Top up" checkout link in the credit panel
  /** SUMMON flavour (creator, no agent present): */
  summon?: boolean
  summoning?: boolean
  known?: boolean // agentResumable — an agent was here before → "bring it back"
  onSummon?: () => void
}

export function AgentBubble(props: AgentBubbleProps) {
  const { call, isCreator, open, onOpen, onClose, index, participant, menu, speaking, summon, summoning, known, onSummon, hostMenu, onRate, topupUrl } = props

  // ── derive machine state from existing signals ──────────────────────────────────
  const meta = participant?.meta as Record<string, unknown> | undefined
  const minutesLeft = typeof meta?.minutesLeft === 'number' ? (meta.minutesLeft as number) : null // coupon credit (creator panel)
  const present = !!participant
  const engagedRaw = present && engagedFromMeta(meta)
  const engaged = useDebounced(engagedRaw, 300) // smooth the proxy fallback's busy-flicker; exact meta.phase barely needs it
  const split = menu ? splitActions(menu.actions) : { engage: undefined, listen: undefined, leave: undefined, capabilities: [] }
  const scribeEnabled = scribeEnabledFromLabel(split.listen)
  const state = deriveState({ present, summoning: !!summoning, engaged })
  // Advance the "Summoning…" label every 15s so a slow cold-start never looks frozen (reset when not summoning).
  const [summonStep, setSummonStep] = useState(0)
  useEffect(() => {
    if (state !== 'summoning') {
      setSummonStep(0)
      return
    }
    const id = setInterval(() => setSummonStep((s) => Math.min(s + 1, SUMMON_STEPS.length - 1)), 15000)
    return () => clearInterval(id)
  }, [state])
  const summoningLabel = wt(SUMMON_STEPS[summonStep])
  const sub = subStatus(state, !!speaking)
  const emoji = present ? menu?.theme.icon || participant?.avatar || '🤖' : '🤖'
  const name = menu?.agent || participant?.name || wt('AI agent')
  // Status word: kibitz-derived chrome → localized via the string table (the agent never sends this word).
  const word = summon ? (state === 'summoning' ? summoningLabel : known ? wt('Bring it back') : wt('Add agent')) : wt(pillWord(state, sub, scribeEnabled, !!known))

  // ── position + drag (absolute within the offsetParent = .kw-stagewrap) ───────────
  const rootRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  // DERIVED pixel position (offsetParent-local), refreshed by place() for the panel + drag-start math.
  const posRef = useRef<{ x: number; y: number } | null>(null)
  // SOURCE OF TRUTH: the pill's position as a fraction (0..1) of its MOVABLE RANGE, measured against the
  // VISUAL viewport (window.visualViewport). iOS's window.innerWidth/Height lag and ignore the URL bar / pinch
  // during a rotate; visualViewport is the only viewport metric it reports live, frame by frame — which is what
  // makes the pill hold its spot through the progressive rotation. ONE fraction (not per-orientation): e.g.
  // 90%-across / bottom maps to the same relative spot in BOTH portrait and landscape.
  const fracRef = useRef<{ x: number; y: number }>({ x: 1, y: clamp(1 - index * 0.12, 0, 1) })
  const [, forcePos] = useState(0)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})
  // Two-tap confirm for the DESTRUCTIVE agent-leave (removes the agent from the call + settles its coupon): first
  // tap arms ("Tap again to remove"), a second within 3s fires. Mirrors the human ✕ so an accidental tap can't evict it.
  const [leaveArmed, setLeaveArmed] = useState(false)
  const leaveArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (leaveArmTimer.current) clearTimeout(leaveArmTimer.current) }, [])

  const parentBox = () => rootRef.current?.offsetParent as HTMLElement | null
  // iOS reports window.innerWidth/Height late (and ignores the URL bar / pinch) during a rotate; visualViewport
  // is live. Read it (with a fallback) — this is the fix that makes the pill hold its spot through the rotation.
  const viewport = () => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    return { width: vv?.width ?? window.innerWidth, height: vv?.height ?? window.innerHeight, offsetLeft: vv?.offsetLeft ?? 0, offsetTop: vv?.offsetTop ?? 0 }
  }
  // Position the pill from its fraction against the LIVE visual viewport, written as an offsetParent-local
  // transform (compositor-only). maxX/maxY are the pill's travel range inside the visible glass, holding the
  // horizontal gutter + the top/bottom-bar safe zones. Caches the derived local pixels in posRef for the panel.
  const place = useCallback(() => {
    const el = rootRef.current
    const pill = pillRef.current
    const parent = parentBox()
    if (!el || !pill || !parent) return
    const f = fracRef.current
    const vp = viewport()
    const w = pill.offsetWidth
    const h = pill.offsetHeight
    const maxX = Math.max(0, vp.width - w - MARGIN * 2)
    const maxY = Math.max(0, vp.height - h - TOP_SAFE - BOT_SAFE)
    const pr = parent.getBoundingClientRect() // visible-screen coords → offsetParent-local
    const x = vp.offsetLeft + MARGIN + f.x * maxX - pr.left
    const y = vp.offsetTop + TOP_SAFE + f.y * maxY - pr.top
    posRef.current = { x, y }
    el.style.setProperty('--agb-s', String(scaleFor(parent.clientWidth)))
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`
  }, [])
  // Set the fraction from a dragged local top-left (converts back through the visual viewport), then place.
  const setFromLocal = useCallback((localX: number, localY: number) => {
    const pill = pillRef.current
    const parent = parentBox()
    if (!pill || !parent) return
    const vp = viewport()
    const pr = parent.getBoundingClientRect()
    const w = pill.offsetWidth
    const h = pill.offsetHeight
    const maxX = Math.max(1, vp.width - w - MARGIN * 2)
    const maxY = Math.max(1, vp.height - h - TOP_SAFE - BOT_SAFE)
    fracRef.current = {
      x: clamp((localX + pr.left - vp.offsetLeft - MARGIN) / maxX, 0, 1),
      y: clamp((localY + pr.top - vp.offsetTop - TOP_SAFE) / maxY, 0, 1),
    }
    place()
  }, [place])

  // initial placement: the default fraction (bottom-right, stacked per index) is already set — place once, then
  // a re-render so the panel can size against the fresh posRef.
  useLayoutEffect(() => {
    if (!pillRef.current || !parentBox()) return
    place()
    forcePos((n) => n + 1)
  }, [place])

  const positionPanel = useCallback(() => {
    const parent = parentBox()
    const pill = pillRef.current
    const p = posRef.current
    if (!parent || !pill || !p) return
    const panelW = Math.min(parent.clientWidth - 24, Math.round(280 * scaleFor(parent.clientWidth)))
    const openUp = p.y + pill.offsetHeight / 2 > parent.clientHeight * 0.5
    const left = clamp(p.x + pill.offsetWidth / 2 - panelW / 2, 8, parent.clientWidth - panelW - 8) - p.x
    setPanelStyle({
      width: panelW,
      left,
      ...(openUp ? { bottom: pill.offsetHeight + 8, top: 'auto' } : { top: pill.offsetHeight + 8, bottom: 'auto' }),
      maxHeight: (openUp ? p.y : parent.clientHeight - (p.y + pill.offsetHeight)) - 12,
      transformOrigin: openUp ? 'bottom center' : 'top center',
    })
  }, [])

  // Reposition on anything that changes the visible viewport: window resize, and — crucially on iOS — the
  // visualViewport's OWN resize/scroll, which is what fires frame-by-frame through a PROGRESSIVE rotate (iOS
  // animates the flip through many half-rotated sizes rather than one clean swap). Because place() re-derives
  // from the fraction against the LIVE visual viewport, every intermediate frame lands the pill at the same
  // relative spot. A 250ms settle re-place then corrects for after the rotation animation lands. Also observe
  // the offsetParent (covers a chrome-bar toggle that resizes an embedded layer). A live drag owns the fraction.
  useEffect(() => {
    const parent = parentBox()
    if (!parent) return
    let raf = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const reposition = () => {
      if (dragRef.current.dragging) return
      place()
      if (openRef.current) positionPanel()
    }
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(reposition)
      if (timer) clearTimeout(timer)
      timer = setTimeout(reposition, 250) // final correction after iPhone progressive rotation settles
    }
    window.addEventListener('resize', schedule)
    const vv = window.visualViewport
    vv?.addEventListener('resize', schedule)
    vv?.addEventListener('scroll', schedule)
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(schedule)
      ro.observe(parent)
    }
    return () => {
      cancelAnimationFrame(raf)
      if (timer) clearTimeout(timer)
      window.removeEventListener('resize', schedule)
      vv?.removeEventListener('resize', schedule)
      vv?.removeEventListener('scroll', schedule)
      ro?.disconnect()
    }
  }, [place, positionPanel])

  const toggleOpen = useCallback(() => {
    if (open) onClose()
    else {
      positionPanel()
      onOpen()
    }
  }, [open, onOpen, onClose, positionPanel])

  // One-tap summon: the summon pill fires onSummon AND opens the panel (to show the progressing status) — no
  // separate "Summon an agent" button tap. Present agents keep tap→toggle; a tap while already summoning just opens.
  const onSummonTap = useCallback(() => {
    onSummon?.()
    if (!open) {
      positionPanel()
      onOpen()
    }
  }, [onSummon, open, positionPanel, onOpen])

  // Drag state lives in a REF, not closure locals, so a mid-gesture re-render — e.g. `speaking` flipping
  // while someone talks — can't reset the in-progress drag (that was the "not fluid / drops the drag"
  // bug). stopPropagation keeps the pointer off the parent .kw-stagewrap swipe handler (which was
  // stealing the gesture → "sometimes it did the swipe"). Moves are coalesced to one write per frame.
  const dragRef = useRef<{ start: { px: number; py: number; x: number; y: number } | null; dragging: boolean; raf: number; onTap: () => void; closeOnDrag: boolean }>({ start: null, dragging: false, raf: 0, onTap: () => {}, closeOnDrag: false })
  const openRef = useRef(open)
  openRef.current = open
  const onDragDown = useCallback(
    (e: React.PointerEvent, opts: { onTap: () => void; closeOnDrag: boolean; isHead: boolean }) => {
      if (opts.isHead && (e.target as HTMLElement).closest('button')) return // let header buttons (expand) click through
      e.stopPropagation()
      const p = posRef.current
      if (!p) return
      focus()
      dragRef.current = { start: { px: e.clientX, py: e.clientY, x: p.x, y: p.y }, dragging: false, raf: 0, onTap: opts.onTap, closeOnDrag: opts.closeOnDrag }
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    },
    [focus],
  )
  const onDragMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current
      if (!d.start) return
      e.stopPropagation()
      const dx = e.clientX - d.start.px
      const dy = e.clientY - d.start.py
      if (!d.dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        d.dragging = true
        rootRef.current?.classList.add('kw-agb--dragging')
        if (d.closeOnDrag && open) onClose()
      }
      if (!d.dragging) return
      // Drive the FRACTION from the dragged local top-left (start pixels + delta); place() re-derives on-screen
      // pixels against the live visual viewport, so the drag and the rotation logic share one source of truth.
      setFromLocal(d.start.x + dx, d.start.y + dy)
    },
    [open, onClose, setFromLocal],
  )
  const onDragEnd = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current
      if (!d.start) return
      e.stopPropagation()
      try {
        ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      if (d.raf) {
        cancelAnimationFrame(d.raf)
        d.raf = 0
      }
      place() // settle the final position from the fraction
      const wasDrag = d.dragging
      d.start = null
      d.dragging = false
      rootRef.current?.classList.remove('kw-agb--dragging')
      if (wasDrag) positionPanel()
      else d.onTap()
    },
    [place, positionPanel],
  )
  const pillDrag = { onPointerDown: (e: React.PointerEvent) => onDragDown(e, { onTap: summon && !summoning ? onSummonTap : toggleOpen, closeOnDrag: true, isHead: false }), onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd }
  const headDrag = { onPointerDown: (e: React.PointerEvent) => onDragDown(e, { onTap: () => {}, closeOnDrag: false, isHead: true }), onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd }
  // The grabber bar doubles as a collapse affordance (it LOOKS like a bottom-sheet handle): a TAP collapses the
  // panel, a DRAG still repositions it. Distinct from headDrag (the title row), which only drags — its buttons own taps.
  const barDrag = { onPointerDown: (e: React.PointerEvent) => onDragDown(e, { onTap: toggleOpen, closeOnDrag: false, isHead: true }), onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd }

  // ── drawer (state text + capabilities) ──────────────────────────────────────────
  const [drawer, setDrawer] = useState(false)
  const [caps, setCaps] = useState(false)
  useEffect(() => {
    if (open) positionPanel()
  }, [open, drawer, caps, positionPanel])

  const stateText = summon
    ? known
      ? wt('{name} left the call. Bring it back to pick up where you left off.', { name })
      : wt('No agent in this call yet.')
    : state === 'engaged'
      ? sub === 'speaking'
        ? wt('Engaged — replying on the call.')
        : wt('Engaged — go ahead, it’s listening.')
      : scribeEnabled
        ? wt('In the call and taking notes. Hand it the floor to reply.')
        : wt('Note-taking is disabled — it can’t hear the call. Enable it, or hand it the floor.')

  const fire = (id: string) => participant && call.sendAppTo(participant.id, actionMessage(id))
  const onPrimary = () => {
    if (summon || state === 'absent') onSummon?.()
    else if (state === 'summoning') void 0
    else if (split.engage) fire(split.engage.id)
  }
  // The engage button uses the AGENT's own localized label (it ships & flips it in the manifest — e.g.
  // "🎙️ דבר איתי" / "✅ סיימתי"); the summon-phase labels are kibitz chrome, localized from the table.
  const primaryLabel =
    state === 'summoning'
      ? summoningLabel
      : summon || state === 'absent'
        ? known
          ? wt('Bring it back')
          : wt('Summon an agent')
        : split.engage?.label || (state === 'engaged' ? wt('“Thanks a lot, friend”') : wt('“Go ahead, friend”'))
  const primaryBusy = state === 'summoning'
  // First-run nudge: highlight the summon pill until the agent is actually called. Creator-only (only the creator
  // gets a summon bubble), first summon only (!known), and it vanishes the moment summoning starts or the panel opens.
  const showNudge = !!summon && !known && !summoning && !open

  return (
    <div ref={rootRef} className="kw-agb" data-state={state} data-activity={sub ?? ''} data-scribe={scribeEnabled ? 'on' : 'off'} data-open={open ? 'true' : 'false'} onPointerDown={(e) => e.stopPropagation()}>
      {open && (
        <div className="kw-agb-panel" role="dialog" dir={isRtl() ? 'rtl' : 'ltr'} aria-label={wt('{name} controls', { name })} style={panelStyle}>
          <div
            className="kw-agb-dragbar"
            role="button"
            tabIndex={0}
            aria-label={wt('Collapse')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggleOpen()
              }
            }}
            {...barDrag}
          />
          <div className="kw-agb-head" {...headDrag}>
            <span className="kw-agb-avatar">
              <EmojiAvatar value={emoji} />
            </span>
            <span className="kw-agb-id">
              <span className="kw-agb-name">{name}</span>
              <span className="kw-agb-status">
                <span className="kw-agb-dot" aria-hidden="true" />
                <span className="kw-agb-word">{word}</span>
              </span>
            </span>
            {!summon && hostMenu && onRate && (
              <button type="button" className="kw-agb-rate" aria-label={hostMenu.label} title={hostMenu.label} onClick={() => onRate(hostMenu)}>
                <span aria-hidden="true">★</span>
              </button>
            )}
            <button type="button" className="kw-agb-expand" aria-expanded={drawer} aria-label={wt('Show details')} onClick={() => setDrawer((d) => !d)}>
              <span className="kw-agb-chev" />
            </button>
          </div>

          {drawer && (
            <div className="kw-agb-drawer">
              <p className="kw-agb-statetext">{stateText}</p>
              {!summon && (menu?.theme.icon || split.capabilities.length > 0) && (
                <div className="kw-agb-caps">
                  <button type="button" className="kw-agb-caphead" aria-expanded={caps} onClick={() => setCaps((c) => !c)}>
                    <span className="kw-agb-capcore">
                      {emoji} {name}
                    </span>
                    <span className="kw-agb-chev kw-agb-chev--sm" />
                  </button>
                  {caps && (
                    <ul className="kw-agb-caplist">
                      {split.capabilities.length ? (
                        split.capabilities.map((c) => (
                          <li key={c.id}>
                            <button type="button" className="kw-agb-cap" title={c.desc || c.label} onClick={() => fire(c.id)}>
                              {c.label}
                            </button>
                          </li>
                        ))
                      ) : (
                        <li className="kw-agb-capnone">{wt('Talk to it to see what it can do.')}</li>
                      )}
                    </ul>
                  )}
                </div>
              )}
              {/* Room-creator credit panel — live coupon balance from the agent's meta + a Top-up checkout link. */}
              {isCreator && !summon && (
                <div className="kw-agb-credit">
                  <span className="kw-agb-creditrow">
                    <span className="kw-agb-creditlabel">{wt('Credit')}</span>
                    <span className="kw-agb-creditval">{minutesLeft != null ? wt('~{n} min left', { n: minutesLeft }) : '—'}</span>
                  </span>
                  {topupUrl && (
                    <a className="kw-agb-topup" href={topupUrl} target="_blank" rel="noopener noreferrer">
                      {wt('Top up ↗')}
                    </a>
                  )}
                </div>
              )}
            </div>
          )}

          <button type="button" className="kw-agb-primary" data-kind={summon || state === 'absent' ? 'summon' : state === 'engaged' ? 'disengage' : 'engage'} disabled={primaryBusy} onClick={onPrimary}>
            {primaryBusy && <span className="kw-agb-spin" aria-hidden="true" />}
            {primaryLabel}
          </button>

          {!summon && (split.listen || (isCreator && split.leave)) && (
            <div className="kw-agb-secondary" data-solo={split.listen && !(isCreator && split.leave) ? 'true' : 'false'}>
              {split.listen && (
                <button type="button" className="kw-agb-sbtn kw-agb-listen" aria-pressed={!scribeEnabled} aria-label={scribeEnabled ? wt('Disable note-taking') : wt('Enable note-taking')} onClick={() => fire(split.listen!.id)}>
                  <span className="kw-agb-ico" aria-hidden="true">
                    <span className="kw-agb-pause">
                      <i />
                      <i />
                    </span>
                    <span className="kw-agb-play" />
                  </span>
                  {/* The agent ships this label localized + state-flipped (⏸ Pause listening / 🎧 Resume listening). */}
                  {split.listen.label || (scribeEnabled ? wt('Enabled') : wt('Disabled'))}
                </button>
              )}
              {isCreator && split.leave && (
                <button
                  type="button"
                  className={`kw-agb-sbtn kw-agb-leave${leaveArmed ? ' armed' : ''}`}
                  onClick={() => {
                    if (leaveArmed) {
                      if (leaveArmTimer.current) clearTimeout(leaveArmTimer.current)
                      setLeaveArmed(false)
                      fire(split.leave!.id)
                    } else {
                      setLeaveArmed(true)
                      if (leaveArmTimer.current) clearTimeout(leaveArmTimer.current)
                      leaveArmTimer.current = setTimeout(() => setLeaveArmed(false), 3000)
                    }
                  }}
                >
                  {/* First tap arms, a second confirms — removing the agent is destructive. Disarmed shows the
                      agent's own localized label (👋 Leave the call). */}
                  {leaveArmed ? wt('Tap again to remove {name}', { name: name || wt('AI agent') }) : split.leave.label || wt('Leave call')}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <button ref={pillRef} type="button" className="kw-agb-pill" data-nudge={showNudge ? 'true' : 'false'} aria-label={`${name} — ${word}`} aria-expanded={open} {...pillDrag}>
        <span className="kw-agb-grip" aria-hidden="true" />
        <span className="kw-agb-avatar kw-agb-avatar--pill">
          <EmojiAvatar value={emoji} />
        </span>
        <span className="kw-agb-pillcopy">
          <span className="kw-agb-dot" aria-hidden="true" />
          <span className="kw-agb-word">{word}</span>
        </span>
      </button>
      {showNudge && <div className="kw-agb-nudge">{wt('Tap to add your AI agent')}</div>}
    </div>
  )
}
