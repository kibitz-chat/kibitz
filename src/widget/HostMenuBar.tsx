// Renders the trigger for any present agent that ENABLED a brand host menu (`hostMenu` in its
// `agent-actions@1` manifest), at the surface it asked for. Clicking opens the brand's OWN page in a
// sandboxed <iframe> whose origin is locked to the build's `menuOrigin` (hostMenu.ts) — Kibitz never sees
// what the page does, it just hosts the frame and passes room/agent in the URL. The brand page can
// `postMessage({type:'kibitz:hostmenu', action:'close'})` (origin-checked) to dismiss itself, e.g. after a
// rating is submitted. Renders nothing unless a present agent asked for THIS placement AND a menuOrigin is
// configured. This is the generic in-call host-menu seam; rating is its first consumer.
import { useEffect, useState } from 'react'
import type { CallController } from '../react/useCall'
import { liveHostMenus, hostMenusFor, type HostMenu } from './hostMenu'
import { DEFAULT_PLACEMENT, type Placement } from './agentActions'

export function HostMenuBar({
  call,
  placement = DEFAULT_PLACEMENT,
  menuOrigin,
  room,
}: {
  call: CallController
  placement?: Placement
  menuOrigin?: string
  room?: string
}) {
  // Re-render when a peer (re)publishes a schema; participant changes already re-render via `call`.
  const [, bump] = useState(0)
  const [open, setOpen] = useState<HostMenu | null>(null)
  useEffect(() => call.onSchema(() => bump((n) => n + 1)), [call])

  // While a menu is open: let the brand page dismiss itself (only honoring messages from the LOCKED origin),
  // and close on Escape. Hooks stay unconditional — declared before any early return.
  useEffect(() => {
    if (!open || !menuOrigin) return
    let lockedOrigin = ''
    try {
      lockedOrigin = new URL(menuOrigin).origin
    } catch {
      return
    }
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== lockedOrigin) return
      const d = e.data as { type?: unknown; action?: unknown } | null
      if (d && typeof d === 'object' && d.type === 'kibitz:hostmenu' && d.action === 'close') setOpen(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null)
    }
    window.addEventListener('message', onMsg)
    document.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('message', onMsg)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, menuOrigin])

  const present = new Set(call.participants.map((p) => p.id))
  const menus = hostMenusFor(liveHostMenus(call.getSchemas(), present, menuOrigin, { room }), placement)
  if (!menus.length) return null

  return (
    <div className="kw-hostmenu-row">
      {menus.map((m) => (
        <button key={m.from} type="button" className="kw-hostmenu-btn" title={m.label} onClick={() => setOpen(m)}>
          {m.label}
        </button>
      ))}
      {open && (
        <div className="kw-hostmenu-overlay" onClick={(e) => e.target === e.currentTarget && setOpen(null)}>
          <div className="kw-hostmenu-panel">
            <button type="button" className="kw-hostmenu-close" aria-label="Close" onClick={() => setOpen(null)}>
              ✕
            </button>
            {/* Origin is build-locked; allow-same-origin lets the brand page read its OWN storage (the coupon)
                and call its own backend. allow-scripts/forms for the page itself. */}
            <iframe className="kw-hostmenu-frame" src={open.url} title={open.label} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" />
          </div>
        </div>
      )}
    </div>
  )
}
