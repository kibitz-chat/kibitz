// PWA install state + the native install prompt. The kibitz.chat home page has two
// modes keyed on this: a browser visitor is nudged to INSTALL; the installed app
// (running standalone) is a clean launcher (start a room / paste a link).

// The `beforeinstallprompt` event (Chromium: Android + desktop Chrome/Edge) lets us
// trigger the native install. It fires EARLY — register at module load and stash it so
// the install page can offer a real button. iOS/Safari/Firefox never fire it (those get
// manual steps instead). Import this module early (main.tsx) so the capture is in place.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((cb) => cb())

// Persisted install state — the reliable way to know if OUR PWA is installed across
// sessions. `appinstalled` records it; `beforeinstallprompt` clears it (Chrome only fires
// that when the app is installABLE, i.e. NOT installed — which also covers an uninstall, so
// the CTA can't get stuck on "Open in app"). Far more dependable than getInstalledRelatedApps().
const INSTALLED_KEY = 'kibitz.installed'
const setInstalledFlag = (v: boolean) => {
  try {
    if (v) localStorage.setItem(INSTALLED_KEY, '1')
    else localStorage.removeItem(INSTALLED_KEY)
  } catch {
    /* storage blocked */
  }
}
const installedFlag = (): boolean => {
  try {
    return localStorage.getItem(INSTALLED_KEY) === '1'
  } catch {
    return false
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // keep OUR button in control of when the prompt shows
    deferred = e as BeforeInstallPromptEvent
    setInstalledFlag(false) // installable ⇒ not installed (also un-sticks after an uninstall)
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    setInstalledFlag(true)
    notify()
  })
}

/** Manually record that the app was installed — for iOS, where Safari fires NO `appinstalled`
 *  event and exposes no install-state API, so the user confirms ("I've added it") after the
 *  Add-to-Home-Screen steps. Persists the flag + notifies so the home page reflects it. */
export function markInstalled(): void {
  setInstalledFlag(true)
  notify()
}

/** Manually record that the app was UNINSTALLED — the counterpart to markInstalled() for iOS /
 *  Mac Safari, which fire no event when you delete a Home-Screen / Dock app. Clears the flag +
 *  notifies so the home page drops back to the Install state. (No effect on Chromium, where
 *  getInstalledRelatedApps would just re-detect a genuinely-installed app.) */
export function markUninstalled(): void {
  setInstalledFlag(false)
  notify()
}

/** A real, one-tap native install is available right now (Chromium only). */
export function canInstallNatively(): boolean {
  return !!deferred
}

/** Subscribe to native-installability changes (the event can arrive after first paint). */
export function onInstallChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Fire the captured native prompt. Returns true if the user accepted. No-op (false)
 *  when no prompt is available (iOS/Safari/Firefox, or already installed). */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false
  const e = deferred
  deferred = null
  notify()
  try {
    await e.prompt()
    const { outcome } = await e.userChoice
    return outcome === 'accepted'
  } catch {
    return false
  }
}

// Every display mode an INSTALLED app can run in. Checking only 'standalone' is too narrow:
// desktop Chrome PWAs can run 'minimal-ui' or 'window-controls-overlay', and a fullscreen app
// reports 'fullscreen' — all of which mean "installed app", not a browser tab.
export const INSTALLED_DISPLAY_MODES = ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay'] as const

/** Running as an installed app (home-screen / standalone window), not a browser tab. Matches ANY
 *  installed display mode (not just 'standalone') plus iOS Safari's navigator.standalone. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const installedMode = INSTALLED_DISPLAY_MODES.some(
      (m) => window.matchMedia?.(`(display-mode: ${m})`).matches === true,
    )
    // iOS Safari home-screen apps don't report display-mode; they set navigator.standalone.
    return installedMode || (window.navigator as unknown as { standalone?: boolean }).standalone === true
  } catch {
    return false
  }
}

/** Best-effort "is this PWA already installed?" — for swapping the home page's "Install"
 *  CTA to "Open in app". True if we ARE the installed app (standalone), if it was installed
 *  in this tab (appinstalled), or if `getInstalledRelatedApps()` reports our webapp (Chromium;
 *  needs `related_applications` in the manifest). Resolves false where unknown — never claims
 *  installed when it isn't. */
export async function isInstalled(): Promise<boolean> {
  if (isStandalone()) return true // we ARE the installed app
  if (canInstallNatively()) return false // Chrome is actively offering install ⇒ NOT installed
  if (installedFlag()) return true // recorded install, persisted; cleared by the next beforeinstallprompt
  // Best-effort bonus (a fresh browser that never saw OUR appinstalled, e.g. a synced profile):
  try {
    const nav = navigator as Navigator & {
      getInstalledRelatedApps?: () => Promise<Array<{ platform?: string }>>
    }
    if (nav.getInstalledRelatedApps) {
      const apps = await nav.getInstalledRelatedApps()
      return apps.some((a) => a.platform === 'webapp')
    }
  } catch {
    /* unsupported / blocked */
  }
  return false
}

// Note: there is deliberately NO openApp() helper. No web API can launch an installed PWA
// from a browser tab — window.open(start_url) just spawns another browser tab (Chromium only
// redirects it into the app if the user turned on link-capturing). So the home page shows an
// honest "✓ Installed" note instead of a button that would mislead by opening a junk tab.

export type Platform = 'ios' | 'android' | 'desktop-chromium' | 'macos-safari' | 'firefox' | 'other'

/** Best-effort platform bucket for showing the right install instructions. */
export function platform(): Platform {
  if (typeof navigator === 'undefined') return 'other'
  const ua = navigator.userAgent
  const iOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (iOS) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/Firefox\//.test(ua)) return 'firefox'
  // Chromium desktop (Chrome / Edge / Brave) exposes the native prompt.
  const chromium = /Chrome\//.test(ua) || /Edg\//.test(ua) || /Chromium\//.test(ua)
  if (chromium) return 'desktop-chromium'
  if (/Safari\//.test(ua) && /Macintosh/.test(ua)) return 'macos-safari'
  return 'other'
}
