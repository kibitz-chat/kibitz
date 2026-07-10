// Idle-nudge state machine — pure (all deps injected, so it unit-tests offline with a fake clock).
//
// After `idleMs` with no engagement it raises a nudge ("still there?"). If the participant doesn't respond within
// `graceMs`, it fires onLeave (they opt out of the call). ANY engagement (a pointer/key/touch event) — or an
// explicit `stay()` (the "yes, keep going" button) — clears the nudge and restarts the idle countdown. `disable()`
// turns it off for the rest of the call (the per-call opt-out); `enable()` turns it back on.
export type IdleNudge = {
  bump(): void // an engagement event — resets the idle countdown (and clears the nudge if it was up)
  stay(): void // explicit "yes, continue" — same effect as bump
  disable(): void
  enable(): void
  dispose(): void
}

export function createIdleNudge(opts: {
  idleMs: number
  graceMs: number
  onNudge: (on: boolean) => void // raise (true) / lower (false) the nudge UI
  onLeave: () => void // no response within graceMs → leave the call
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
}): IdleNudge {
  let timer: unknown = null
  let nudging = false
  let off = false
  const clear = () => {
    if (timer != null) {
      opts.clearTimer(timer)
      timer = null
    }
  }
  const lower = () => {
    if (nudging) {
      nudging = false
      opts.onNudge(false)
    }
  }
  const armIdle = () => {
    clear()
    if (off) return
    timer = opts.setTimer(() => {
      nudging = true
      opts.onNudge(true)
      timer = opts.setTimer(() => {
        lower()
        opts.onLeave()
      }, opts.graceMs)
    }, opts.idleMs)
  }
  const reset = () => {
    if (off) return
    lower()
    armIdle()
  }
  armIdle()
  return {
    bump: reset,
    stay: reset,
    disable() {
      off = true
      clear()
      lower()
    },
    enable() {
      off = false
      armIdle()
    },
    dispose: clear,
  }
}
