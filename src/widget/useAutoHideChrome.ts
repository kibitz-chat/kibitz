import { useEffect, useState, type RefObject } from 'react'

// The auto-hiding call chrome (dedicated room window / fullscreen only): the header + controls fade a few seconds
// after activity (Zoom-style), and any pointer/key activity in the panel reveals them again + re-arms the idle
// timer. Lifted out of Widget.tsx (the chromeHidden flag + its effect). The PIN conditions (avatar picker open, a
// pending knock, an open agent menu, an active pen, a desktop screen-share, …) are folded into `autoHideChrome`
// upstream and passed in as one bool. swipeActiveRef (a stage swipe must NOT pop the bars) + revealChromeRef (a tap
// reveals explicitly) stay in Widget, shared with the swipe handler — the hook reads the former and publishes
// show() into the latter. `host` is the shadow host we listen on. A pure move — effect + dep array preserved.
export function useAutoHideChrome(
  autoHideChrome: boolean,
  host: HTMLElement | undefined,
  chatSplit: boolean,
  swipeActiveRef: RefObject<boolean>,
  revealChromeRef: RefObject<(() => void) | null>,
) {
  const [chromeHidden, setChromeHidden] = useState(false)
  useEffect(() => {
    if (!autoHideChrome || !host) {
      setChromeHidden(false)
      return
    }
    let t = 0
    const show = (e?: Event) => {
      // A stage swipe (layout change) must NOT pop the bars up — onStageSwipeUp reveals on a tap instead.
      if (swipeActiveRef.current) return
      // A tap on an AGENT MENU (the stage pill, its chips, etc.) is an interaction with the agent — not a
      // request to reveal the call chrome. Don't pop the top/bottom bars for it. (composedPath pierces the
      // shadow root; an explicit tap-to-reveal calls show() with no event, so it still works.)
      if (
        e?.composedPath?.().some((n) => {
          const cl = (n as HTMLElement)?.classList
          return !!cl && (cl.contains('kw-agentbar') || cl.contains('kw-agentbar-ctrlwrap') || cl.contains('kw-agentsmenu-wrap'))
        })
      )
        return
      // Chatsplit (stage + chat): the control bar is pinned in the chat column, so ONLY the top bar auto-hides.
      // Typing — or any interaction with the chat column — must NOT pop the top bar back up (it would cover the
      // stage). Reveal the top bar only from a stage/rail tap, never from the keyboard or the chat.
      if (
        chatSplit &&
        e &&
        (e.type === 'keydown' || e.composedPath?.().some((n) => (n as HTMLElement)?.classList?.contains('kw-chat')))
      )
        return
      setChromeHidden(false)
      clearTimeout(t)
      t = window.setTimeout(() => setChromeHidden(true), 3000)
    }
    revealChromeRef.current = show // so a TAP (vs swipe) on the stage can trigger the reveal explicitly
    // Pointer/key activity ANYWHERE in the panel reveals the chrome and re-arms the idle timer;
    // listen on the shadow host so events from inside the shadow root bubble up to us. In ghost mode
    // the tiles are click-through (pointer-events:none) so only a tap on the title strip reaches us —
    // which is exactly the intent: touch the top bar to bring the buttons back.
    host.addEventListener('pointermove', show)
    host.addEventListener('pointerdown', show)
    host.addEventListener('keydown', show)
    show() // visible now, and ARM the idle-hide immediately so the chrome fades a few seconds after
    // join even with no interaction (Zoom-style) — not only after the first pointer move.
    return () => {
      clearTimeout(t)
      revealChromeRef.current = null
      host.removeEventListener('pointermove', show)
      host.removeEventListener('pointerdown', show)
      host.removeEventListener('keydown', show)
    }
  }, [autoHideChrome, host, chatSplit])
  return { chromeHidden }
}
