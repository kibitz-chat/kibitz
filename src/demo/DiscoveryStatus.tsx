import { useEffect, useState } from 'react'
import { onDiscoveryStatus } from '../core/hubDiscover'

/**
 * A small banner over the offline room that says what zero-input LAN discovery is doing — otherwise the probe is
 * SILENT, so a guest can't tell "still searching" from "found" from "nothing here" (which made the desktop test
 * impossible to read). Mounted only on the offline route. Tap to dismiss.
 */
export function DiscoveryStatus() {
  const [status, setStatus] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  useEffect(
    () =>
      onDiscoveryStatus((s) => {
        setStatus(s)
        setDismissed(false)
      }),
    [],
  )
  if (!status || dismissed) return null
  return (
    <div
      role="status"
      onClick={() => setDismissed(true)}
      style={{
        position: 'fixed',
        top: 'calc(env(safe-area-inset-top, 0px) + 8px)',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2147483600,
        maxWidth: '92vw',
        padding: '9px 15px',
        borderRadius: 999,
        background: 'rgba(20,20,22,0.92)',
        color: '#fff',
        font: '500 13px/1.35 system-ui, -apple-system, sans-serif',
        boxShadow: '0 2px 14px rgba(0,0,0,0.35)',
        textAlign: 'center',
        cursor: 'pointer',
        WebkitBackdropFilter: 'blur(6px)',
        backdropFilter: 'blur(6px)',
      }}
    >
      📡 {status}
    </div>
  )
}
