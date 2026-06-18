// A single "Agents" control in the call: a checklist of every agent present (each published an
// agent-actions@1 manifest), with a per-viewer checkbox (default on) that locally shows/hides that
// agent's on-call menu. View-only — toggling never leaves this browser, never changes the agent, and
// never affects what anyone else sees. A checked row also exposes the agent's actions inline, so even
// a hidden-from-the-stage agent is still reachable here.
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { CallController } from '../react/useCall'
import { liveAgentMenus, actionMessage, type AgentMenu } from './agentActions'

const themeStyle = (m: AgentMenu): CSSProperties | undefined => (m.theme.accent ? ({ '--kw-agent-accent': m.theme.accent } as CSSProperties) : undefined)

export function AgentsMenu({ call, hidden, onToggle }: { call: CallController; hidden: ReadonlySet<string>; onToggle: (id: string) => void }) {
  const [, bump] = useState(0)
  const [open, setOpen] = useState(false)
  useEffect(() => call.onSchema(() => bump((n) => n + 1)), [call])
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
  if (!menus.length) return null
  const shownCount = menus.filter((m) => !hidden.has(m.from)).length

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
                    {m.actions.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        className="kw-agentbar-chip"
                        title={a.desc || a.label}
                        onClick={() => call.sendAppTo(m.from, actionMessage(a.id))}
                      >
                        {a.label}
                      </button>
                    ))}
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
