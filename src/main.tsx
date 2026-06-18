import { createRoot } from 'react-dom/client'
import './core/install' // register the beforeinstallprompt capture at load (before any chunk-split could delay it)
import { App } from './demo/App'
import { UpdateBanner } from './pwa'
import { isOidcCallback, parseOidcFragment } from './core/oidcPopup'
import { setSignalHost } from './core/signalConfig'
import { brand } from './brand'
import './demo/styles.css'

// White-label: a build-time accent (VITE_BRAND_ACCENT) recolours the paper theme via a single var the
// CSS reads (--brand-accent); the call widget is themed separately via the `accent` mount option. The
// default brand sets no accent, so this is a no-op and the build is byte-for-byte unchanged.
if (brand.accent) {
  document.documentElement.style.setProperty('--brand-accent', brand.accent)
  document.documentElement.classList.add('brand-rebrand') // lets CSS swap accent-incompatible defaults (e.g. the green update pill)
  document.title = `${brand.name} — ${brand.taglineLanding[0]}`
}

// OIDC sign-in popup callback (generic provider, e.g. Microsoft): the provider redirected THIS
// popup back to our origin with `#id_token=…&state=…`. Post the result up to the opener (same-origin
// only) and close — BEFORE the app mounts, so the fragment is never mistaken for a room id and no
// call machinery spins up in the throwaway popup. The opener validates `state` (oidcProvider.ts).
if (typeof window !== 'undefined' && window.opener && window.opener !== window && isOidcCallback(location.hash)) {
  const { idToken, state, error } = parseOidcFragment(location.hash)
  // Scrub the id_token out of the popup's URL/history immediately — defense-in-depth in case the
  // browser refuses the close() below (then the token isn't sitting in the address bar/history).
  try {
    history.replaceState(null, '', location.pathname + location.search)
  } catch {
    /* sandboxed history — ignore */
  }
  try {
    window.opener.postMessage({ type: 'kibitz-oidc', idToken, state, error }, location.origin)
  } catch {
    /* opener gone / blocked — the opener side will time out */
  }
  window.close()
  throw new Error('oidc-callback: handled in the popup, not rendering the app')
}

// Dev-only signaling override: `vite dev` (plain, no Pages Functions) has no
// /api/signal endpoint, so peer discovery falls back to the flaky PUBLIC PeerJS
// broker — two same-machine tabs often never find each other (only your own
// tile shows). Set VITE_SIGNAL_HOST (e.g. in .env.local or `VITE_SIGNAL_HOST=
// signal.kibitz.chat npm run dev`) to point plain dev at the LIVE broker, so
// two-tab testing works without the full `npm run mirror` build. No-op when
// unset, so production builds are unaffected. The extension uses the same seam.
const devSignalHost = import.meta.env.VITE_SIGNAL_HOST
if (devSignalHost) {
  setSignalHost(devSignalHost)
  console.info(`Kibitz: signaling forced to ${devSignalHost} (VITE_SIGNAL_HOST)`)
}

// Log the running build so it's visible in the console on any page (the footer
// shows it too) — the quick "what version am I actually on?" check.
console.info(`Kibitz build ${__BUILD_ID__}`)

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root not found')

createRoot(root).render(
  <>
    <App />
    <UpdateBanner />
  </>,
)
