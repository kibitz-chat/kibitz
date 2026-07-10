// A single "Agents" control in the call: a checklist of every agent present (each published an
// agent-actions@1 manifest), with a per-viewer checkbox (default on) that locally shows/hides that
// agent's on-call menu. View-only — toggling never leaves this browser, never changes the agent, and
// never affects what anyone else sees. A checked row also exposes the agent's actions inline, so even
// a hidden-from-the-stage agent is still reachable here.
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { CallController } from '../react/useCall'
import { liveAgentMenus, actionMessage, agentsHubVisible, type AgentMenu } from './agentActions'

const themeStyle = (m: AgentMenu): CSSProperties | undefined => (m.theme.accent ? ({ '--kw-agent-accent': m.theme.accent } as CSSProperties) : undefined)

export function AgentsMenu({ call, hidden, onToggle, onOpenChange }: { call: CallController; hidden: ReadonlySet<string>; onToggle: (id: string) => void; onOpenChange?: (open: boolean) => void }) {
  const [, bump] = useState(0)
  const [open, setOpen] = useState(false)
  useEffect(() => call.onSchema(() => bump((n) => n + 1)), [call])
  // Lift the open state so the call chrome can PIN itself open while this menu is up. Without this the
  // auto-hide-chrome idle timer flips chromeHidden after ~3s and yanks the whole control bar — and this
  // open menu with it — out from under the user mid-interaction (the "agent menu auto-hides" bug).
  useEffect(() => onOpenChange?.(open), [open, onOpenChange])
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      // The widget is in an OPEN shadow root, so a document-level listener sees e.target RETARGETED to
      // the shadow host — closest() then never finds the wrap, the click reads as "outside" (close),
      // and the button's onClick reopens it → the toggle never closes. composedPath() pierces the shadow.
      const path = e.composedPath?.() || []
      if (!path.some((n) => (n as HTMLElement)?.classList?.contains?.('kw-agentsmenu-wrap'))) setOpen(false)
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
  const menus = liveAgentMenus(call.getSchemas(), present) // ALL agents — this is the master list
  const shownCount = menus.filter((m) => !hidden.has(m.from)).length
  // With ONE agent the 🤖 hub just duplicates that agent's own actions button (same command chips) — hide it.
  // Keep it for 2+ agents (manage several / count badge), OR when the lone agent is hidden (the only way back).
  if (!agentsHubVisible(menus.length, shownCount)) return null

  return (
    <div className="kw-agentsmenu-wrap">
      <button
        type="button"
        className={`kw-ic kw-agentsmenu-btn${open ? ' active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Agents in this call"
        aria-label={`Agents in this call (${shownCount} of ${menus.length} shown)`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        🤖
        {menus.length > 1 && <span className="kw-badge kw-badge-sm">{menus.length}</span>}
      </button>
      {open && (
        <div className="kw-agentsmenu" role="menu">
          <div className="kw-agentsmenu-head">Agents — show on my screen</div>
          {menus.map((m) => {
            const shown = !hidden.has(m.from)
            return (
              <div key={m.from} className="kw-agentsmenu-row" style={themeStyle(m)}>
                <label className="kw-agentsmenu-check">
                  <input type="checkbox" checked={shown} onChange={() => onToggle(m.from)} />
                  <span className="kw-agentsmenu-name">
                    {m.theme.icon || '🤖'} {m.agent}
                  </span>
                </label>
                {shown ? (
                  <div className={`kw-agentbar-row kw-agentbar--chip-${m.theme.chip} kw-agentbar--size-${m.theme.size}`}>
                    {(() => {
                      // WORKING (busy on a task — NOT the 'listening' follow-up window): gray out task actions so a
                      // re-tap can't pile on another job; leave (last action) stays live. The activity!=='listening'
                      // gate keeps the ear/your-turn state fully tappable.
                      const meta = call.participants.find((p) => p.id === m.from)?.meta as { busy?: unknown; activity?: unknown } | undefined
                      const working = !!meta?.busy && meta?.activity !== 'listening'
                      return (
                        <>
                          {m.actions.map((a, i) => {
                            const disabled = working && i !== m.actions.length - 1
                            return (
                              <button
                                key={a.id}
                                type="button"
                                className={`kw-agentbar-chip${disabled ? ' kw-agentbar-chip--disabled' : ''}`}
                                title={disabled ? 'Working… one moment' : a.desc || a.label}
                                disabled={disabled}
                                onClick={() => call.sendAppTo(m.from, actionMessage(a.id))}
                              >
                                {a.label}
                              </button>
                            )
                          })}
                          <button
                            type="button"
                            className="kw-agentbar-chip kw-agentbar-chip--thanks"
                            title="Thanks — that’s all (ends the back-and-forth)"
                            onClick={() => call.sendChat('thank you friend', m.from)}
                          >
                            🙏 Thanks
                          </button>
                        </>
                      )
                    })()}
                  </div>
                ) : (
                  <span className="kw-agentsmenu-hidden">hidden — still active</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
