import { useEffect, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'
import { brand } from './brand'

let registered = false

/**
 * Registers the service worker and surfaces an "update available" banner when a
 * newer deploy is detected. The SW is in 'prompt' mode, so the page you're using
 * is never swapped out from under you — you reload when you choose, and you can
 * always trust that what's on screen is what's running.
 *
 * It also polls for a new version every minute and whenever the tab regains focus
 * (or an installed PWA is reopened), so a long-lived tab notices deploys promptly
 * instead of only at a cold start.
 */
export function UpdateBanner() {
  const [reload, setReload] = useState<(() => void) | null>(null)

  useEffect(() => {
    if (registered) return // StrictMode / remount guard — register exactly once
    registered = true
    const updateSW = registerSW({
      onNeedRefresh() {
        setReload(() => () => void updateSW(true)) // updateSW(true) activates + reloads
      },
      onRegisteredSW(_swUrl, reg) {
        if (!reg) return
        const check = () => void reg.update().catch(() => {})
        setInterval(check, 60_000)
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') check()
        })
      },
    })
  }, [])

  if (!reload) return null
  return (
    <div className="kbz-update" role="status">
      <span>A new version of {brand.name} is ready.</span>
      <button onClick={reload}>Reload</button>
    </div>
  )
}
