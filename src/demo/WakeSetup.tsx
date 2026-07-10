import { useState } from 'react'
import { pairWithHub } from '../core/wake'

/**
 * DEV wake-pairing screen (hidden #wake route). Connects this installed PWA to a "Hub" so
 * the Hub can ring it — the minimal end-to-end demo of the wake seam (docs/wake-seam.md).
 * The hardened production pairing (QR + nonce + Hub-origin allowlist + consent) is a later
 * phase; this is reachable only by knowing the route and only gates HTTPS.
 */
export function WakeSetup({ onBack }: { onBack: () => void }) {
  const [hub, setHub] = useState(() => {
    try {
      return localStorage.getItem('kbz-wake-hub') || ''
    } catch {
      return ''
    }
  })
  const [status, setStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'err'; msg: string }>({ kind: 'idle', msg: '' })

  const connect = async () => {
    setStatus({ kind: 'busy', msg: 'Connecting…' })
    try {
      try {
        localStorage.setItem('kbz-wake-hub', hub.trim())
      } catch {
        /* private mode */
      }
      const { endpoint } = await pairWithHub(hub)
      setStatus({ kind: 'ok', msg: `Connected — this device can now be rung.\n${new URL(endpoint).host}` })
    } catch (e) {
      setStatus({ kind: 'err', msg: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="wake-setup">
      <div className="wake-card">
        <h1>Connect a wake sender</h1>
        <p className="wake-sub">
          Developer preview. Pair this <b>installed</b> app to a Hub so it can ring you and drop you into a room.
          On iOS this must run in the installed app (not a Safari tab).
        </p>
        <p className="wake-warn">
          ⚠️ A connected Hub can ring this device and send it into <b>any room</b> until you remove it. Only connect
          a Hub you control or fully trust.
        </p>
        <label className="wake-label" htmlFor="wake-hub">
          Hub URL (https)
        </label>
        <input
          id="wake-hub"
          className="wake-input"
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://…trycloudflare.com"
          value={hub}
          onChange={(e) => setHub(e.target.value)}
        />
        <button className="wake-go" type="button" onClick={connect} disabled={status.kind === 'busy' || !hub.trim()}>
          {status.kind === 'busy' ? 'Connecting…' : 'Connect & subscribe'}
        </button>
        {status.msg && <pre className={`wake-status wake-${status.kind}`}>{status.msg}</pre>}
        <button className="wake-back linklike" type="button" onClick={onBack}>
          ← Back
        </button>
      </div>
    </div>
  )
}
