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
  return (
    <div className={`kw-agentbar-row ${themeClass(menu)}`} style={themeStyle(menu)}>
      <span className="kw-agentbar-name">
        {menu.theme.icon || '🤖'} {menu.agent}
      </span>
      {menu.actions.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`kw-agentbar-chip${sent === a.id ? ' kw-agentbar-chip--sent' : ''}`}
          title={a.desc || a.label}
          onClick={() => fire(a.id)}
        >
          {a.label}
        </button>
      ))}
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
          className={`kw-ic kw-agentbar-ctrlbtn${open ? ' active' : ''}${labeled ? ' labeled' : ''}`}
          onClick={() => setOpen((o) => !o)}
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
