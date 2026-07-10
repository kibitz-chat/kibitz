import { useEffect, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'
import { brand } from './brand'

let registered = false
let swCleanup: (() => void) | null = null
let updating = false // once we commit to applying an update, don't stack reloads (per page load)

// HARD CAP on reloads: if a new build won't "take" after this many tries, STOP auto-reloading so the page can
// NEVER blink forever. The current build still works; a cold launch (new tab / relaunch) picks up the new one.
const MAX_RELOADS = 3

/**
 * Apply a detected update: activate the NEW service worker's precache (skipWaiting), then reload — so the reload
 * is served the new app shell, not the old precached one. We reload on a TIMER, NOT the SW 'controllerchange'
 * event: that event is unreliable in the iPhone Safari BROWSER (the reported bug — the tab stayed stuck on the
 * old build).
 *
 * INFINITE-BLINK GUARD (2026-07-05): `reg.waiting` is usually still null right after `reg.update()` (the new SW is
 * still INSTALLING), so `SKIP_WAITING` hits nothing, the precache never swaps, and every poll reloads to the SAME
 * old shell → the page blinks forever. So: try the clean skipWaiting ONCE; on the next attempt, NUKE the SW's
 * caches + unregister so the reload bypasses the wedged precache and pulls the new shell straight from the network;
 * and after MAX_RELOADS with no convergence, give up (no reload) rather than blink. sessionStorage counts attempts;
 * a successful update (version matches) clears it in check() below, so the normal path resets cleanly.
 */
async function applyUpdate(reg?: ServiceWorkerRegistration) {
  if (updating) return
  updating = true // stays true for the rest of this page load → at most one reload scheduled per load
  let attempts = 0
  try {
    attempts = Number(sessionStorage.getItem('kbz:swreload') || 0)
  } catch {
    /* sessionStorage can throw in private mode */
  }
  if (attempts >= MAX_RELOADS) return // wedged deploy → STOP (no reload); the current build keeps working
  try {
    sessionStorage.setItem('kbz:swreload', String(attempts + 1))
  } catch {
    /* ignore */
  }
  try {
    if (reg) {
      await reg.update().catch(() => {}) // pull the new SW (its precache = the NEW shell)
      // Activate the new worker so its precache (the new shell) takes over. `reg.waiting` is usually still null
      // right after update() (the new SW is still INSTALLING) — posting SKIP_WAITING to nothing is exactly why the
      // old build kept sticking. So WAIT for it to install, then claim; resolve on controllerchange (it took over)
      // or a timeout. While the SW controls this page EVERY navigation is served the precached shell, so a plain
      // (or even cache-busted) reload can't escape a stale precache — only activating the new SW, or dropping it, can.
      const worker = reg.waiting || reg.installing
      // Give the clean skipWaiting hand-off ONE shot (attempt 0); if the reload after it still shows the old build,
      // every subsequent attempt DROPS the SW instead — the uncontrolled network reload is the reliable path.
      if (worker && worker.state !== 'activated' && attempts < 1) {
        // Fast path: activate the new SW so its precache (the new shell) takes over. `reg.waiting` is usually null
        // right after update() (still INSTALLING) — posting SKIP_WAITING to nothing is exactly why the old build
        // stuck — so WAIT for 'installed', then claim; resolve on controllerchange (it took over) or a timeout.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 3500) // don't hang if it never installs
          navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); resolve() }, { once: true })
          const claim = () => {
            if (worker.state === 'installed') worker.postMessage({ type: 'SKIP_WAITING' })
          }
          worker.addEventListener('statechange', claim)
          claim()
        })
      } else {
        // No new worker to activate, OR the skipWaiting shot already failed once (attempts >= 1) → DROP the SW so
        // the (cache-busted) reload is UNCONTROLLED and pulls the fresh shell from the network. Bonus: once we cap,
        // the SW is gone, so a plain manual refresh always lands the new build. (We don't nuke the precache while
        // the SW still controls this page — the nav handler needs it; nuking it would break the reload.)
        await reg.unregister().catch(() => {})
      }
    }
  } finally {
    // Reload to pick up the new build. With the network-first service worker (src/sw.ts) a plain reload is already
    // served a FRESH index.html + new assets, so no cache-busting query is needed. We deliberately DON'T add one:
    // a ?_rv= param polluted the URL, which an installed desktop PWA then PERSISTED as its restore target and, on a
    // later relaunch to that ?_rv= URL, showed "This site can't be reached / ERR_FAILED" until the app was reopened.
    // A normal reload revalidates the top-level document, so it lands the new build without touching the URL.
    setTimeout(() => window.location.reload(), 1500)
  }
}

/**
 * Registers the service worker and applies new deploys.
 *
 * DETECTION is version.json polling (fetch cache-disabled, compare to the baked-in __BUILD_ID__) — reliable on
 * iOS Safari, where the SW update lifecycle (updatefound / controllerchange) is flaky. APPLICATION is
 * applyUpdate() above (skipWaiting + timed reload).
 *
 * Silent brands (brand.silentUpdate, e.g. kibitz) apply immediately — INCLUDING during a live call. A reload
 * ends the call, but the product choice is to always run the latest build. Default (kibitz) surfaces a "reload"
 * button instead, so the user chooses when.
 *
 * Polls on a slow interval while the tab is visible, on return-to-tab (visibilitychange), and on an iOS bfcache
 * restore (pageshow persisted) — so a long-lived tab or a returning iPhone notices a deploy promptly.
 */
export function UpdateBanner() {
  const [reload, setReload] = useState<(() => void) | null>(null)

  useEffect(() => {
    if (registered) return // StrictMode / remount guard — register exactly once
    registered = true
    let swReg: ServiceWorkerRegistration | undefined

    // A newer build is live → silent brands apply now (even mid-call); prompt brands show a reload button.
    const onUpdate = () => {
      if (brand.silentUpdate) return void applyUpdate(swReg)
      setReload(() => () => void applyUpdate(swReg))
    }

    registerSW({
      onNeedRefresh() {
        onUpdate() // the SW lifecycle also saw a waiting worker — a bonus trigger to the version poll
      },
      onRegisteredSW(_swUrl, reg) {
        if (!reg) return
        swReg = reg
        const check = async () => {
          reg.update().catch(() => {}) // fetch a changed SW so its new precache is ready to activate
          try {
            const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
            if (!r.ok) return
            const latest = (await r.json())?.version
            if (typeof latest !== 'string' || !latest) return
            if (latest !== __BUILD_ID__) {
              // Reset the reload counter when the TARGET version changes (a NEW deploy) — otherwise a tab that used
              // up its MAX_RELOADS on one wedged build would NEVER retry the next one (the "exhausts 3 tries then
              // never reloads again" bug). Keyed to `latest`, so every new build gets its own fresh set of attempts.
              try {
                if (sessionStorage.getItem('kbz:swtarget') !== latest) {
                  sessionStorage.setItem('kbz:swtarget', latest)
                  sessionStorage.setItem('kbz:swreload', '0')
                }
              } catch {
                /* ignore */
              }
              onUpdate()
            } else {
              try {
                sessionStorage.removeItem('kbz:swreload') // up to date → reset the loop guard
                sessionStorage.removeItem('kbz:swtarget')
                // We're on the fresh build → strip the cache-buster back out so the URL stays clean.
                const u = new URL(window.location.href)
                if (u.searchParams.has('_rv')) {
                  u.searchParams.delete('_rv')
                  window.history.replaceState(null, '', u.toString())
                }
              } catch {
                /* ignore */
              }
            }
          } catch {
            /* offline, or version.json not deployed yet — ignore */
          }
        }
        const id = window.setInterval(() => {
          if (document.visibilityState === 'visible') void check()
        }, 60_000)
        const onVis = () => {
          if (document.visibilityState === 'visible') void check()
        }
        const onShow = (e: PageTransitionEvent) => {
          if (e.persisted) void check() // iOS restores a backgrounded tab via pageshow, not always visibilitychange
        }
        document.addEventListener('visibilitychange', onVis)
        window.addEventListener('pageshow', onShow)
        void check() // check once on register too
        swCleanup = () => {
          clearInterval(id)
          document.removeEventListener('visibilitychange', onVis)
          window.removeEventListener('pageshow', onShow)
        }
      },
    })
    return () => swCleanup?.()
  }, [])

  if (!reload) return null
  return (
    <div className="kbz-update" role="status">
      <span>A new version of {brand.name} is ready.</span>
      <button onClick={reload}>Reload</button>
    </div>
  )
}
