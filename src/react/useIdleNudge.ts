import { useEffect, useRef, useState } from 'react'
import { createIdleNudge, type IdleNudge } from './idleNudge'

// Screen-engagement events that count as "I'm still here" (reset the idle countdown). pointermove is throttled in
// the handler since it fires continuously; the rest are discrete.
const ENGAGE = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'pointermove'] as const
const DEFAULT_IDLE_MS = 5 * 60_000 // 5 minutes with no engagement → nudge
const DEFAULT_GRACE_MS = 60_000 // then 1 minute to answer before opting out

/** After `idleMs` with no screen engagement, raise a "still there?" nudge; if it goes unanswered for `graceMs`, call
 *  onLeave (the participant opts out of the call). `enabled=false` (per-call opt-out, not in a call, preview) → inert.
 *  Returns `nudging` (render the prompt) and `stay` (the "yes, keep going" handler). Pure logic lives in idleNudge.ts
 *  (unit-tested); this hook just wires DOM engagement events + window timers to it. */
export function useIdleNudge(opts: {
  enabled: boolean
  idleMs?: number
  graceMs?: number
  onLeave: () => void
  /** Any value that CHANGES on conversation activity (pass `call.chat` — its ref changes on every new chat line,
   *  including the agent's replies + produced images). A change resets the idle countdown, so a VOICE call that's
   *  actively conversing (no pointer/keyboard, just talking + the agent painting) isn't killed by a cursor-idle
   *  timer. Mouse/key/touch still bump via the DOM listeners below — this just ADDS chat as engagement. */
  activity?: unknown
}): { nudging: boolean; stay: () => void } {
  const [nudging, setNudging] = useState(false)
  const onLeaveRef = useRef(opts.onLeave)
  onLeaveRef.current = opts.onLeave
  const ctlRef = useRef<IdleNudge | null>(null)
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS

  useEffect(() => {
    if (!opts.enabled || typeof window === 'undefined') {
      setNudging(false)
      return
    }
    const ctl = createIdleNudge({
      idleMs,
      graceMs,
      onNudge: setNudging,
      onLeave: () => onLeaveRef.current(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (t) => window.clearTimeout(t as number),
    })
    ctlRef.current = ctl
    let lastMove = 0
    const onEvt = (e: Event) => {
      if (e.type === 'pointermove') {
        const now = Date.now()
        if (now - lastMove < 2000) return // throttle: a move every ≤2s is enough to count as engaged
        lastMove = now
      }
      ctl.bump()
    }
    for (const ev of ENGAGE) window.addEventListener(ev, onEvt, { passive: true })
    return () => {
      for (const ev of ENGAGE) window.removeEventListener(ev, onEvt)
      ctl.dispose()
      ctlRef.current = null
    }
  }, [opts.enabled, idleMs, graceMs])

  // Conversation activity = engagement too. A change in `activity` (chat line / produced image) resets the
  // countdown and clears any nudge, so an active voice call stays alive while it's actually conversing. Defined
  // AFTER the ctl-creation effect, so ctlRef is already set when this runs.
  useEffect(() => {
    ctlRef.current?.bump()
  }, [opts.activity])

  return { nudging, stay: () => ctlRef.current?.stay() }
}
