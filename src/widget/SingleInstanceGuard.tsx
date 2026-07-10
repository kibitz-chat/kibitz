// Enforces "one live call per browser" (opt-in via singleInstance). It renders nothing: when a NEWER
// tab/window takes over (see useSingleInstance's leader election), this instance bows out — it leaves the
// call (so there's no duplicate/echoing participant) and returns to the home screen via onExit. The app's
// own leave→go-home wiring is skipped for an INVOLUNTARY dormancy (isSingleInstanceDormant), so onExit()
// here is the single, deliberate trip home — and it works whether or not this tab was in a call yet.

import { useEffect } from 'react'
import { useSingleInstance } from '../react/useSingleInstance'

export function SingleInstanceGuard({
  enabled,
  leave,
  onExit,
}: {
  enabled: boolean
  /** Drop this tab out of the room when it goes dormant (no-op if not in a call). */
  leave: () => void
  /** Go "home" (the host wires this to the landing / room exit) once this tab is superseded. */
  onExit?: () => void
}) {
  const { active } = useSingleInstance(enabled)

  useEffect(() => {
    if (!enabled || active) return
    try {
      leave()
    } catch {
      /* not in a call */
    }
    try {
      onExit?.()
    } catch {
      /* no home wired (bare embedder) → just left the call */
    }
  }, [enabled, active, leave, onExit])

  return null
}
