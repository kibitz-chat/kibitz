import { createRoot } from 'react-dom/client'
import './core/install' // register the beforeinstallprompt capture at load (before any chunk-split could delay it)
import { installStaleChunkGuard } from './core/staleChunk'
import { installConnDebug, installDebugToggle } from './core/connDebug'
import { App } from './demo/App'
import { UpdateBanner } from './pwa'
import { isOidcCallback, parseOidcFragment } from './core/oidcPopup'
import { setSignalHost } from './core/signalConfig'
import { setTurnHost } from './core/turnConfig'
import { warmIceServers } from './core/iceConfig'
import { brand } from './brand'
import './demo/styles.css'

// Recover from a deploy that replaced the hashed chunks under an open tab: a failed lazy import reloads
// once (guarded) instead of dumping the user back at the landing page. Installed before the app mounts.
installStaleChunkGuard()

// WebRTC connectivity overlay — capture is ALWAYS on, installed BEFORE any call machinery so it sees every
// connection from the start; the PANEL stays hidden until the cheat reveals it (tap the bottom-left corner 5× fast,
// persists across reloads). Capture is cheap (read-only listeners; the getStats poll runs only while visible), so
// revealing it mid-call shows the full picture instead of pcs:0.
installConnDebug()
installDebugToggle()

// Per-device relay-policy test override: `?relay=0` (direct-first) / `?relay=1` (force) → sticky in localStorage
// (kbz.forceRelay), read by forceRelay() at connect time. Persisted at boot so the flag survives the room
// navigation stripping the query. A test tool for the 4G↔WiFi direct-first trial; unset ⇒ the global default.
try {
  const rp = new URLSearchParams(location.search).get('relay')
  if (rp === '0' || rp === '1') localStorage.setItem('kbz.forceRelay', rp)
} catch {
  /* ignore */
}

// Staged-clip audio (2nd audio m-line) is DEFAULT ON (testing whether it still breaks Chrome↔Safari). Sticky
// escape hatch: ?shareaudio=0 disables it on this device (persisted so it survives the room navigation), ?shareaudio=1
// forces it on. See shareAudioOn() in useCall.ts.
try {
  const sa = new URLSearchParams(location.search).get('shareaudio')
  if (sa === '0' || sa === '1') localStorage.setItem('kbz.shareAudio', sa)
} catch {
  /* ignore */
}

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

// White-label: a sibling hosted OFF the platform (e.g. a branded sibling on S3/CloudFront — no same-origin
// /api/signal or /api/turn Pages Functions) must borrow the platform's broker + TURN. Apply the brand's
// hosts HERE, at load — BEFORE any chooseSignal() probe — so peer discovery can NEVER fall back to the
// flaky public PeerJS broker. (Doing it only at mount left a window where an early probe hit the missing
// /api/signal, sent that peer to the public broker, and two peers ended up on DIFFERENT brokers — unable to
// see each other.) No-op for the default brand (which sets no host → same-origin /api/* as before).
if (brand.signalHost) setSignalHost(brand.signalHost)
if (brand.turnHost) setTurnHost(brand.turnHost)

// Unified room sync (docs/unified-room-sync.md): set the app default the flag reads, at load, before any mount.
// ON by default now (brand.roomSyncV2 defaults true — verified fixed), for BOTH kibitz.chat and kibitz.chat; a
// rebrand ships it off with VITE_BRAND_ROOM_SYNC_V2=0, and a user can still override per device
// (localStorage['kbz.roomSyncV2'], which roomSyncV2On() checks first). Coexists with the legacy paths (dedup by mid).
;(globalThis as Record<string, unknown>).__kbzRoomSyncV2 = brand.roomSyncV2

// Pre-warm TURN at load (after the brand turnHost is applied), so the credentials are cached BEFORE a call
// connects. The presence PeerJS peer carries the ROSTER over a single connect-time-fetched DataConnection; a slow
// first fetch otherwise left it STUN-only and the cross-network roster channel failed ("joined but 0 participants").
void warmIceServers()

// ?debug persists per device: set the flag HERE (runs on every page incl. the landing), so visiting
// `?debug` once sticks even though the room you later join has no ?debug in its URL. The widget reads it.
try {
  if (new URLSearchParams(location.search).has('debug')) localStorage.setItem('kbzdebug', '1')
} catch {
  /* storage blocked — ?debug still works inline via the URL */
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
