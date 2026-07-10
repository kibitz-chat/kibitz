// Renders the in-call menu for any agent that published an `agent-actions@1` manifest, at the surface
// the agent asked for (manifest ui.placement) and in the look it asked for (ui.theme). Clicking a chip
// sends the chosen action to that agent over the data mesh. Renders nothing when no present agent asked
// for THIS placement — so the same component can be dropped at every surface and only the right one shows.
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { CallController } from '../react/useCall'
import { liveAgentMenus, menusFor, visibleMenus, actionMessage, DEFAULT_PLACEMENT, type AgentMenu, type Placement } from './agentActions'

// Per-agent theme → a CSS custom property (accent, strictly validated upstream) + variant classes.
const themeStyle = (m: AgentMenu): CSSProperties | undefined => (m.theme.accent ? ({ '--kw-agent-accent': m.theme.accent } as CSSProperties) : undefined)
const themeClass = (m: AgentMenu) => `kw-agentbar--chip-${m.theme.chip} kw-agentbar--size-${m.theme.size}`

function MenuRow({ call, menu }: { call: CallController; menu: AgentMenu }) {
  // Brief "sent" highlight on the tapped chip — clear confirmation the action reached the agent (the
  // action is fire-and-forget over the data channel, so without this a tap gives no visible feedback).
  const [sent, setSent] = useState<string | null>(null)
  const sentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(sentTimer.current), [])
  const fire = (id: string) => {
    call.sendAppTo(menu.from, actionMessage(id))
    setSent(id)
    clearTimeout(sentTimer.current)
    sentTimer.current = setTimeout(() => setSent(null), 700)
  }
  // WORKING = the agent is busy on a TASK (compose/paint/reason) — distinct from the 'listening' follow-up window
  // (the cyan "your turn" ear, when tapping is exactly the point). While working, GRAY OUT its task actions so a
  // re-tap can't pile on another job; leave-the-call (the last action, manifest convention) stays live, as does the
  // 🙏 Thanks closer. Gating on activity!=='listening' is what lets us re-enable this without graying the ear.
  const meta = call.participants.find((p) => p.id === menu.from)?.meta as { busy?: unknown; activity?: unknown } | undefined
  const working = !!meta?.busy && meta?.activity !== 'listening'
  const thank = () => {
    call.sendChat('thank you friend', menu.from)
    setSent('__thanks')
    clearTimeout(sentTimer.current)
    sentTimer.current = setTimeout(() => setSent(null), 700)
  }
  return (
    <div className={`kw-agentbar-row ${themeClass(menu)}${working ? ' kw-agentbar-row--busy' : ''}`} style={themeStyle(menu)}>
      <span className="kw-agentbar-name">
        {menu.theme.icon || '🤖'} {menu.agent}
        {working && <span className="kw-agentbar-working" title="Working… (actions are paused)"> ⏳</span>}
      </span>
      {menu.actions.map((a, i) => {
        const isLeave = i === menu.actions.length - 1 // leave-the-call is last — never disabled
        const disabled = working && !isLeave
        return (
          <button
            key={a.id}
            type="button"
            className={`kw-agentbar-chip${sent === a.id ? ' kw-agentbar-chip--sent' : ''}${disabled ? ' kw-agentbar-chip--disabled' : ''}`}
            title={disabled ? 'Working… one moment' : a.desc || a.label}
            disabled={disabled}
            onClick={() => fire(a.id)}
          >
            {a.label}
          </button>
        )
      })}
      <button
        type="button"
        className={`kw-agentbar-chip kw-agentbar-chip--thanks${sent === '__thanks' ? ' kw-agentbar-chip--sent' : ''}`}
        title="Thanks — that’s all (ends the back-and-forth)"
        onClick={thank}
      >
        🙏 Thanks
      </button>
      {menu.wake && menu.wake.length > 0 && (
        <span className="kw-agentbar-wake" title="Say this out loud to talk to the agent by voice">
          💬 or say “{menu.wake[0]}”
        </span>
      )}
    </div>
  )
}

export function AgentActionsBar({
  call,
  placement = DEFAULT_PLACEMENT,
  hidden,
}: {
  call: CallController
  placement?: Placement
  hidden?: ReadonlySet<string> // agents the local viewer hid via the Agents menu (per-viewer, not broadcast)
}) {
  // Re-render when a peer (re)publishes a schema; participant changes already re-render via `call`.
  const [, bump] = useState(0)
  const [open, setOpen] = useState(false)
  useEffect(() => call.onSchema(() => bump((n) => n + 1)), [call])
  // Dismiss the 'controls' popover on Escape or a click outside it (no-op for other placements,
  // which never set `open`). Hooks stay unconditional — declared before any early return.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      // OPEN shadow root: a document listener sees e.target RETARGETED to the shadow host, so closest()
      // never finds the wrap and the toggle-button click reads as "outside" (closes, then onClick
      // reopens → never closes). composedPath() pierces the shadow DOM to find the real target.
      const path = e.composedPath?.() || []
      if (!path.some((n) => (n as HTMLElement)?.classList?.contains?.('kw-agentbar-ctrlwrap'))) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDoc, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const present = new Set(call.participants.map((p) => p.id))
  const menus = visibleMenus(menusFor(liveAgentMenus(call.getSchemas(), present), placement), hidden)
  const fromsKey = menus.map((m) => m.from).sort().join(',')
  // One-time join coachmark (controls surface only): a bubble by the agent button that points a
  // first-timer at the menu (the no-wake-word path) and shows the voice cue. Shown once per agent set,
  // then remembered; dismissed on open / Got-it / a timeout. These hooks stay before the early return.
  const coachSeen = useRef<Set<string>>(new Set())
  const [coachKey, setCoachKey] = useState<string | null>(null)
  useEffect(() => {
    if (placement !== 'controls' || !fromsKey || open || coachSeen.current.has(fromsKey)) return
    setCoachKey(fromsKey)
    const t = setTimeout(() => {
      coachSeen.current.add(fromsKey)
      setCoachKey(null)
    }, 14000)
    return () => clearTimeout(t)
  }, [fromsKey, placement, open])
  const dismissCoach = () => {
    if (fromsKey) coachSeen.current.add(fromsKey)
    setCoachKey(null)
  }
  if (!menus.length) return null

  // 'controls' is a compact button in the control bar that toggles a popover (the bar is dense). With
  // one agent the button takes its theme (accent + icon + label); with several it shows the first in
  // the menu list (icon-only) and the popover rows each self-theme.
  if (placement === 'controls') {
    const t0 = menus[0].theme
    const labeled = menus.length === 1 && t0.button === 'labeled'
    const count = menus.reduce((n, m) => n + m.actions.length, 0)
    return (
      <div
        className={`kw-agentbar-ctrlwrap kw-agentbar--size-${t0.size}`}
        style={t0.accent ? ({ '--kw-agent-accent': t0.accent } as CSSProperties) : undefined}
      >
        <button
          type="button"
          className={`kw-ic kw-agentbar-ctrlbtn${open ? ' active' : ''}${labeled ? ' labeled' : ''}${coachKey === fromsKey && !open ? ' kw-agentbar-ctrlbtn--coach' : ''}`}
          onClick={() => {
            setOpen((o) => !o)
            dismissCoach()
          }}
          title={`Agent actions (${count})`}
          aria-label="Agent actions"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className="kw-agentbar-ctrlicon">{t0.icon || '🤖'}</span>
          {labeled && (
            <>
              <span className="kw-agentbar-ctrllabel">{menus[0].agent}</span>
              <span className="kw-agentbar-caret" aria-hidden="true">
                ▾
              </span>
            </>
          )}
        </button>
        {coachKey === fromsKey && !open && (
          <div className="kw-agentbar-coach" role="status">
            <button type="button" className="kw-agentbar-coach-x" onClick={dismissCoach} aria-label="Dismiss">
              ×
            </button>
            <strong>
              {t0.icon || '🤖'} {menus.length === 1 ? menus[0].agent : `${menus.length} agents`} {menus.length === 1 ? 'is' : 'are'} here
            </strong>
            <span>
              Tap to ask
              {menus[0].wake && menus[0].wake.length > 0 ? (
                <>
                  {' '}
                  — or say <b>“{menus[0].wake[0]}”</b>
                </>
              ) : null}
              .
            </span>
            <button type="button" className="kw-agentbar-coach-ok" onClick={dismissCoach}>
              Got it
            </button>
          </div>
        )}
        {open && (
          <div className="kw-agentbar kw-agentbar--controls" role="menu" onClick={() => setOpen(false)}>
            {menus.map((m) => (
              <MenuRow key={m.from} call={call} menu={m} />
            ))}
          </div>
        )}
      </div>
    )
  }

  // stage / tile / chat: a chip row (CSS positions it per placement via the modifier class).
  return (
    <div className={`kw-agentbar kw-agentbar--${placement}`}>
      {menus.map((m) => (
        <MenuRow key={m.from} call={call} menu={m} />
      ))}
    </div>
  )
}
