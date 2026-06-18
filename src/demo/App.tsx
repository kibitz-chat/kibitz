import { useEffect, useState } from 'react'
import { normalizeRoom } from '../core/transport'
import { parseRoomTarget } from '../core/roomInput'
import { clearHandoffRoom, consumeHandoffRoom, stashHandoffRoom } from '../core/handoff'
import { decodeGateParams, gateParamsFrom, splitRoomHash, type GateDescriptor } from '../core/joinGateLink'
import { buildInviteBundle } from '../core/joinGateRuntime'
import { hasGalaxy } from '../core/galaxyHub'
import { getLicenseKey } from '../core/license'
import { getRelayOnly } from '../core/relayPref'
import { setGrant, grantFromUrl, linkWithGrant, requestRoomGrant } from '../core/grant'
import { mount } from '../widget'
import { brand } from '../brand'
import { INSTALLED_DISPLAY_MODES, isInstalled, isStandalone, onInstallChange } from '../core/install'
import { Landing } from './Landing'
import { InstallPage } from './InstallPage'
import { UninstallPage } from './UninstallPage'
import { HelpPage } from './HelpPage'
import { CreatePage } from './CreatePage'
import { RoomPreview } from './RoomPreview'
import { PassphraseGate } from './PassphraseGate'
import { VerifyPopup } from './VerifyPopup'
import { WakeSetup } from './WakeSetup'

// A cross-origin sign-in surface for embedders whose own origin can't run GIS / our backend
// (the extension's chrome-extension:// side panel opens this on kibitz.chat). Detected FIRST so
// it never touches the room machinery — it just signs in and posts the token back. See VerifyPopup.
const isVerifyPopup = typeof location !== 'undefined' && new URLSearchParams(location.search).has('kibitzVerify')

// WhatsApp-friendly /j/<room> share link → re-home onto the fragment room. Normally the Cloudflare
// Function (functions/j) 302s this to /#room for us, but the service worker's navigateFallback can
// serve the SPA shell for the /j/ path FIRST (especially an installed PWA), so the app boots at
// /j/<room> and — since the room lives in the hash — lands on the homepage. Catch it on the client:
// convert the path form ourselves (parseRoomTarget handles /j/ + any ?grant) and reload into the
// room. Runs before the grant handling below so the reload carries the query through.
if (typeof location !== 'undefined' && /^\/j\//i.test(location.pathname)) {
  const target = parseRoomTarget(location.href, location.origin)
  if (target && target !== location.href) location.replace(target)
}

// "Opener pays" (the SAFE path): a signed room-grant in the link sponsors this
// joiner's TURN via kibitz.chat's OWN /api/turn (see core/grant). Adopt it before
// any room connects, then strip it from the address bar — a credential shouldn't
// linger in the URL / history / a re-shared link.
//
// We deliberately do NOT honour a `?turn=<host>` link param: a crafted link could
// silently route a joiner's relay through a third party that then harvests their IP
// + connection metadata without consent. Pointing TURN at an independent provider
// stays a code-set mount option (turnHost), never something a link can do.
if (typeof location !== 'undefined') {
  const linkGrant = grantFromUrl(location.href)
  if (linkGrant) {
    setGrant(linkGrant)
    try {
      history.replaceState(null, '', linkWithGrant(location.href, null))
    } catch {
      /* history unavailable */
    }
  }
}

// Old in-app hash routes are now real, crawlable static pages (public/*/index.html).
// Bridge any links that were shared before the switch.
const HASH_REDIRECTS: Record<string, string> = {
  '#relay': '/relay',
  '#setup': '/relay',
  '#privacy': '/privacy',
  '#terms': '/terms',
}

// The room-setup page is a real (hash) ROUTE — so it's directly reachable (kibitz.chat/#new),
// survives a reload, and the browser Back button returns to the landing. `#new` is reserved: it
// never resolves to a room (room ids are always fresh `room-…` codes, so there's no collision).
const CREATE_ROUTE = '#new'
// The install page is also a reserved (hash) route — directly reachable, reload-safe, Back
// returns to the landing. Never resolves to a room (room ids are always fresh `room-…` codes).
const INSTALL_ROUTE = '#install'
// The uninstall page — the mirror of #install: removal instructions + a manual "I've removed it"
// confirm (the only way iOS / Mac Safari learn the app is gone). Also a reserved hash route.
const UNINSTALL_ROUTE = '#uninstall'
// The wake-pairing screen (dev): connect this installed app to a push "Hub" so it can be
// rung into a room. Reserved hash route, reachable from Settings → "Wake setup". See
// docs/wake-seam.md / src/demo/WakeSetup.tsx. Never resolves to a room.
const WAKE_ROUTE = '#wake'
// The help / support page — a copyable "ask any AI about Kibitz" prompt. Reserved hash route,
// reachable from the landing + launcher; never resolves to a room. See src/demo/HelpPage.tsx.
const HELP_ROUTE = '#help'
const RESERVED_HASH = new Set<string>([CREATE_ROUTE, INSTALL_ROUTE, UNINSTALL_ROUTE, WAKE_ROUTE, HELP_ROUTE])
// The dev unlock (set by tapping the build line 5× in Settings) gates the #wake pairing
// screen at the ROUTE level — not just the nav button — so navigating straight to
// kibitz.chat/#wake doesn't expose the pairing UI to a normal/socially-engineered user.
const wakeDevUnlocked = (): boolean => {
  try {
    return localStorage.getItem('kbz-wake-dev') === '1'
  } catch {
    return false
  }
}

const hashRoom = (): string =>
  // The room is the fragment up to any `?gate…` params (which a fragment-form link carries
  // host-privately after the room — see gateParamsFrom). splitRoomHash strips them off.
  RESERVED_HASH.has(location.hash.toLowerCase())
    ? ''
    : normalizeRoom(decodeURIComponent(splitRoomHash(location.hash).room))

// Local TEST HOOK for the opt-in verified-identity feature. Append to the URL (query
// string, separate from the hash room — e.g. `http://localhost:4173/?idclient=XXXX&idrequire#standup`):
//   ?idclient=<google client_id>   turn it on
//   ?idrequire                     "verified only" — authority gate: unverified joiners are denied at the door
//   ?iddomain=acme.com,foo.com     restrict to these email domains
//   ?idemail=alice@acme.com,bob@x.com   restrict to these exact verified emails (guest list)
// Demo-only — kibitz.chat ships account-free; embedders opt in via the `verifyIdentity`
// mount option. Read once.
const idCfg = (() => {
  try {
    const p = new URLSearchParams(location.search)
    const clientId = p.get('idclient')?.trim()
    if (!clientId) return undefined
    const domains = p.get('iddomain')?.split(',').map((s) => s.trim()).filter(Boolean)
    const emails = p.get('idemail')?.split(',').map((s) => s.trim()).filter(Boolean)
    return {
      provider: 'google' as const,
      clientId,
      ...(p.has('idrequire') ? { require: true } : {}),
      ...(domains?.length ? { allowedDomains: domains } : {}),
      ...(emails?.length ? { allowedEmails: emails } : {}),
    }
  } catch {
    return undefined
  }
})()

// Link-driven join gate ("link is everything"): the gate descriptor + this peer's own
// invite token (`gt`) ride the URL. Read ONCE — the link IS the room's admission policy.
// Prefer the FRAGMENT (host-private; new links) and fall back to the query string (legacy links).
const gateParams = gateParamsFrom(location.hash, location.search)
const gateCfg = decodeGateParams(gateParams)
const selfCred = gateParams.get('gt') ?? undefined
// Display-only link params — room description (`d`), consent notice (`n`), agent-call type (`ag`). UNLIKE
// the gate params above (read ONCE), these are recomputed from the CURRENT hash on every render (via
// readDisplayParams(), called inside App) — so creating a room IN-APP (CreatePage → a SAME-DOCUMENT hash
// change, no reload) still flows them to the pre-join, not only opening a fresh link.
//   d  = room description (friendly label shown to joiners; the room id is always a fresh un-guessable code)
//   n  = consent notice shown on the pre-join (joining = agreeing); Kibitz renders it verbatim
//   ag = AI-assisted call → Kibitz's generic recording/third-party warning. `av` = audio+video (camera /
//        shared screen), `a` (or legacy `1`, or any `n` present) = audio only, absent = not an agent call.
function readDisplayParams(): { roomDesc: string; roomNotice: string; agentCall: 'audio' | 'audiovideo' | undefined } {
  const p = gateParamsFrom(location.hash, location.search)
  const roomDesc = (p.get('d') ?? '').slice(0, 80)
  const roomNotice = (p.get('n') ?? '').slice(0, 400)
  const ag = p.get('ag')
  const agentCall: 'audio' | 'audiovideo' | undefined =
    ag === 'av' ? 'audiovideo' : ag === 'a' || ag === '1' || roomNotice ? 'audio' : undefined
  return { roomDesc, roomNotice, agentCall }
}

// A verified-roster link carries the OAuth client id (`gc`) AND the signed roster, so the gate
// can run from the LINK ALONE. When the embedder didn't set `?idclient`, derive the identity
// config from the link's client id (it's public; tokens are still audience-checked against it,
// and the roster's emails come from the signed manifest). `require:true` — it's a gated room.
const effectiveIdCfg =
  idCfg ??
  (gateCfg.mode === 'google' && gateCfg.clientId
    ? { provider: 'google' as const, clientId: gateCfg.clientId, require: true }
    : // OIDC HOST on an otherwise-OPEN room: enable sign-in (so the host can prove their email) WITHOUT
      // `require`, so the room stays open to everyone — only admin is gated to the verified host email.
      gateCfg.hostEmail && gateCfg.clientId
      ? { provider: 'google' as const, clientId: gateCfg.clientId }
      : undefined)

export function App() {
  const [roomName, setRoomName] = useState(hashRoom)
  const [route, setRoute] = useState(() => location.hash.toLowerCase())
  // The create flow: "Start a room" opens the "Set up your room" page BEFORE the room exists
  // (default: anyone with the link). It's the reserved `#new` hash route (see CREATE_ROUTE), so
  // it's directly reachable, reload-safe, and Back returns to the landing. `pendingDesc` carries
  // an in-session description into the page (optional, and editable there).
  const creating = route === CREATE_ROUTE
  // Installed PWA (home-screen / standalone) vs a browser tab → the landing shows the clean
  // launcher vs the marketing page with an Install CTA. NOT read just once: at PWA launch the
  // display-mode can report 'browser' for a beat before settling to standalone, and a single
  // early read would strand the app on the marketing page. So re-check on every display-mode
  // change (see INSTALLED_DISPLAY_MODES) and self-correct.
  const [standalone, setStandalone] = useState(isStandalone)
  useEffect(() => {
    const recheck = () => setStandalone(isStandalone())
    recheck() // a beat after first paint, in case the initial read was too early
    const mqs = INSTALLED_DISPLAY_MODES.map((m) => window.matchMedia(`(display-mode: ${m})`))
    mqs.forEach((mq) => mq.addEventListener('change', recheck))
    return () => mqs.forEach((mq) => mq.removeEventListener('change', recheck))
  }, [])
  // Browser tab but the app is ALREADY installed → the marketing CTA becomes the paste-a-link.
  // Async (getInstalledRelatedApps); re-checked when an install lands this session (appinstalled).
  const [installed, setInstalled] = useState(false)
  // The "how to install" page is only for a browser that doesn't yet have the app. Once it's
  // installed it must never show — neither in the standalone app window (Chrome can open the
  // freshly-installed app straight onto #install) nor in the browser tab that just finished
  // installing (its route is still #install). Either signal bails it to the clean home; the
  // effect below also drops the stale #install hash so the URL is tidy.
  const installing = route === INSTALL_ROUTE && !standalone && !installed
  const uninstalling = route === UNINSTALL_ROUTE
  const helping = route === HELP_ROUTE
  useEffect(() => {
    let alive = true
    const check = () => void isInstalled().then((v) => alive && setInstalled(v))
    check()
    const off = onInstallChange(check)
    // There's no "uninstalled" event, so re-check when the tab regains focus — coming back
    // after removing the app flips "Open in app" back to "Install" instead of getting stuck.
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      alive = false
      off()
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])
  const [pendingDesc, setPendingDesc] = useState('')
  // Layer 2 (privacy): a passphrase-LOCKED room carries its roster sealed (`encManifest`). We hold a
  // passphrase screen before anything mounts; once unlocked, `gate` is the decrypted descriptor
  // (with the plaintext manifest) that drives the rest. `gate` is gateCfg until then.
  const [unlockedGate, setUnlockedGate] = useState<GateDescriptor | null>(null)
  const gate = unlockedGate ?? gateCfg
  const lockedNeedsPass = !!gateCfg.encManifest && !unlockedGate
  // Reactive display params from the LIVE hash — App re-renders on hashchange (roomName/route state), so
  // these stay fresh when you create a room in-app (vs. the read-once gate consts above). Fixes the room
  // description / consent notice not flowing to the creator's pre-join after "Create room".
  const { roomDesc, roomNotice, agentCall } = readDisplayParams()
  // A verified-roster link shows the PUBLISHED ROSTER before letting you in (docs §7); the
  // joiner approves it, then we mount the room. A google manifest (decrypted, if locked) triggers it.
  const hasRosterPreview = !!gate.manifest && !!gate.pubKey && gate.mode === 'google'
  const [approvedRoster, setApprovedRoster] = useState(false)
  // Offline mode (LAN): a LAN hub is configured via ?galaxy= — go straight into the
  // call (the hub IS the room; no broker namespace, no link to share).
  const [offline] = useState(() => hasGalaxy())

  // The room name lives in the URL hash — the link IS the room. Back/forward
  // and the header logo (which clears the hash) navigate naturally.
  useEffect(() => {
    const onHash = () => {
      setRoomName(hashRoom())
      setRoute(location.hash.toLowerCase())
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // The service worker (notificationclick) messages an ALREADY-OPEN app to go to a rung room
  // — setting the hash fires the handler above and joins. (A fresh launch routes via the hash
  // directly; this covers the app-already-open case, where SW navigate() doesn't route on iOS.)
  useEffect(() => {
    const sw = navigator.serviceWorker
    if (!sw) return
    const onMsg = (e: MessageEvent) => {
      const d = e.data
      if (d && d.type === 'kbz-wake-join' && typeof d.roomId === 'string' && /^[a-z0-9-]{3,64}$/.test(d.roomId)) {
        location.hash = d.roomId
      }
    }
    sw.addEventListener('message', onMsg)
    return () => sw.removeEventListener('message', onMsg)
  }, [])

  // Bridge old hash links (#privacy/#terms/#relay) to the real static pages.
  useEffect(() => {
    const dest = HASH_REDIRECTS[route]
    if (dest) location.replace(dest)
  }, [route])

  // "Open in app" room HANDOFF: when a standalone app launches and a browser tab handed off the
  // room it was viewing, resume into that room (the browser launches a PWA at its bare start_url,
  // dropping the room; this puts it back). Full-doc navigation so the module-load gate/grant
  // parsing re-runs for the joined room — the exact paste-a-link path (onOpen below): assign sets
  // the hash but won't reload on a same-doc change (the app launches at the bare start_url ⇒
  // same-doc), so we force the reload. Guarded by !hashRoom() so a deep-link launch isn't
  // disturbed. With NO handoff the app just falls through to its Launcher home (start a room /
  // paste a link / scan a QR) — install, homepage open-in-app and a cold launch all land there.
  useEffect(() => {
    if (!standalone || hashRoom() || route === CREATE_ROUTE) return
    const handoff = consumeHandoffRoom()
    const target = handoff ? parseRoomTarget(handoff, location.origin) : null
    if (target) {
      const sameDoc = target.split('#')[0] === location.href.split('#')[0]
      location.assign(target)
      if (sameDoc) location.reload()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- launch-only; route/hashRoom read once, not triggers
  }, [standalone])

  // Once installed (standalone window, or the tab that just finished installing), drop a stale
  // #install hash so we land on the clean home. A not-yet-installed tab keeps #install (the
  // instructions live there). Separate from the launch effect so it can react to `installed`.
  useEffect(() => {
    if ((standalone || installed) && location.hash.toLowerCase() === INSTALL_ROUTE) location.hash = ''
  }, [standalone, installed])

  // "Open in app" handoff (writer side): while a BROWSER tab sits in a room, remember it so the
  // installed app can resume straight into it. Stash only origin+path+hash — NOT the query string,
  // which can carry one-time grant/identity credentials we don't want lingering in storage (new-
  // style gate params ride the hash, so the room still reconstructs). Refresh as the tab is
  // backgrounded (the moment you switch to the app) so it's fresh at handoff time; clear it when
  // not in a room (homepage / elsewhere ⇒ nothing to resume, the app opens its Launcher home). The
  // app itself (standalone) never stashes — only a browser tab hands off TO it.
  useEffect(() => {
    if (standalone) return
    const save = () => (hashRoom() ? stashHandoffRoom(location.origin + location.pathname + location.hash) : clearHandoffRoom())
    save()
    document.addEventListener('visibilitychange', save)
    window.addEventListener('pagehide', save)
    return () => {
      document.removeEventListener('visibilitychange', save)
      window.removeEventListener('pagehide', save)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs on route change to re-stash/clear
  }, [standalone, route])

  // DEV hook for the link-driven invite gate, until the create-screen UI lands. In the
  // console: `await kibitzInvite('Alice','Bob')` → logs the host room link + per-guest
  // invite links (signed, stateless — nothing saved). Open them in separate windows.
  useEffect(() => {
    ;(window as unknown as { kibitzInvite?: unknown }).kibitzInvite = async (...names: string[]) => {
      const room = normalizeRoom(roomName || 'test')
      const base = `${location.origin}/#${room}`
      const bundle = await buildInviteBundle(base, room, names, Math.floor(Date.now() / 1000) + 7 * 86400)
      console.log(
        '%c⚠️ OPEN THE HOST LINK IN THIS TAB FIRST%c — the room is gated only when its AUTHORITY holds the gate. ' +
          'Your current bare tab is UNGATED and would admit anyone. Paste this into the address bar:',
        'font-weight:bold;color:#b35900',
        'color:inherit',
      )
      console.log('%cHOST link →', 'font-weight:bold;color:#1a7f4e', bundle.roomLink)
      console.log('— then open each guest link in OTHER windows: —')
      for (const g of bundle.guests) console.log(`🎟️ ${g.name}:`, g.link)
      return bundle
    }
  }, [roomName])

  // iOS standalone PWA: rotating to landscape can leave a PHANTOM document scroll + a stale hit map, so
  // taps land offset on app pages. Reset the document scroll and force a root reflow after the rotation
  // settles, app-wide. Touch devices only (the bug is mobile; desktop has no rotation).
  useEffect(() => {
    if (!(navigator.maxTouchPoints > 0)) return
    // Only the orientation FLIP needs the reflow. `resize` also fires for the on-screen
    // keyboard and browser-chrome collapse — blipping the layout on those just causes a
    // needless flush (and a jump while typing in chat), so skip when the aspect ratio is
    // unchanged. Measured inside fix(), after the settle delay, when dimensions are final.
    let wasLandscape = window.innerWidth > window.innerHeight
    const fix = () => {
      const landscape = window.innerWidth > window.innerHeight
      if (landscape === wasLandscape) return // a resize that isn't a rotation — leave layout alone
      wasLandscape = landscape
      try {
        window.scrollTo(0, 0)
      } catch {
        /* ignore */
      }
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0
      const el = document.documentElement
      const prev = el.style.minHeight
      el.style.minHeight = '100.01%' // a real (imperceptible) size change → forces a re-layout + re-hit-test
      void el.offsetHeight
      el.style.minHeight = prev
    }
    let t = 0
    const onRotate = () => {
      clearTimeout(t)
      t = window.setTimeout(fix, 250) // iOS settles the new orientation a beat after the event
    }
    window.addEventListener('orientationchange', onRotate)
    window.addEventListener('resize', onRotate)
    return () => {
      clearTimeout(t)
      window.removeEventListener('orientationchange', onRotate)
      window.removeEventListener('resize', onRotate)
    }
  }, [])

  if (isVerifyPopup) return <VerifyPopup />
  if (offline) return <RoomPage key="lan" roomName={roomName || 'lan'} gate={gate} offline />
  if (HASH_REDIRECTS[route]) return null // redirect effect below navigates to the static page
  // Layer 2: a passphrase-locked room — unlock (decrypt the roster) before anything mounts.
  if (roomName && lockedNeedsPass)
    return (
      <PassphraseGate
        descriptor={gateCfg}
        roomDesc={roomDesc}
        onUnlock={setUnlockedGate}
        onCancel={() => (location.hash = '')}
      />
    )
  if (roomName && hasRosterPreview && !approvedRoster)
    return (
      <RoomPreview
        descriptor={gate}
        roomKey={roomName}
        roomDesc={roomDesc}
        onEnter={() => setApprovedRoster(true)}
        onCancel={() => (location.hash = '')}
      />
    )
  if (roomName) return <RoomPage key={roomName} roomName={roomName} roomDesc={roomDesc} notice={roomNotice} agentCall={agentCall} gate={gate} />
  if (creating)
    return (
      <CreatePage
        initialDesc={pendingDesc}
        googleClientId={idCfg?.clientId}
        onCancel={() => {
          location.hash = '' // back to the landing (reload-safe; Back also works since #new is in history)
        }}
      />
    )
  if (installing)
    return <InstallPage onBack={() => (location.hash = '')} onStart={() => (location.hash = 'new')} />
  if (uninstalling) return <UninstallPage onBack={() => (location.hash = '')} />
  if (helping) return <HelpPage onBack={() => (location.hash = '')} />
  // Only when dev-unlocked; otherwise fall through to the normal landing (the route is inert).
  if (route === WAKE_ROUTE && wakeDevUnlocked()) return <WakeSetup onBack={() => (location.hash = '')} />
  return (
    <Landing
      standalone={standalone}
      installed={installed}
      onInstall={() => (location.hash = 'install')}
      onUninstall={() => (location.hash = 'uninstall')}
      onStart={(desc) => {
        setPendingDesc(desc ?? '')
        location.hash = 'new' // navigate to the #new route — directly linkable + survives reload
      }}
      onOpen={(input) => {
        // JOIN a room from a pasted link/code — the installed-PWA path (no address bar). We re-home
        // the room + admission params onto OUR origin (stays in standalone scope) and hard-load it so
        // App's once-at-module-load gate/grant parsing runs fresh for the joined room.
        const target = parseRoomTarget(input, location.origin)
        if (!target) return false
        const sameDoc = target.split('#')[0] === location.href.split('#')[0]
        location.assign(target)
        if (sameDoc) location.reload() // a hash-only change won't reload on its own — force it so the gate parses
        return true
      }}
    />
  )
}

// --- Room --------------------------------------------------------------------

/**
 * The room page IS the widget — the same shadow-rooted floating panel any
 * third-party site embeds, mounted over a light share-this-link page. The site
 * dogfoods its own embed product.
 */
function RoomPage({
  roomName,
  roomDesc,
  notice,
  agentCall,
  gate,
  offline,
}: {
  roomName: string
  roomDesc?: string
  /** Optional specific disclosure shown on the pre-join screen (from the link's `n` param). */
  notice?: string
  /** AI-assisted call (link `ag=av`/`ag=a` or a notice present) → Kibitz's generic pre-join warning,
   *  worded for what the agent perceives (audio, or audio+video). */
  agentCall?: 'audio' | 'audiovideo'
  /** The effective gate descriptor — decrypted if the room was passphrase-locked (Layer 2). */
  gate: GateDescriptor
  offline?: boolean
}) {
  // The room IS the mounted full-window widget (black). This page is just its backdrop — visible only
  // when the call pops out (Document PiP) or for a frame as the resize margin — so keep it black and
  // empty (the invite link + QR live in the widget now), never white "paper" that flashes on resize.
  // Paint the <html> element (not just <body>) black + color-scheme:dark too: when you drag the
  // desktop-app window's edge, the browser repaints the bare document background before the content
  // reflows — a white margin flash unless the root is black. (Same fix as the pop-out window.)
  // Are we IN the call yet (vs. the pre-join screen)? Drives the page colour below — set from the
  // widget's `state` event in the mount effect.
  const [joined, setJoined] = useState(false)

  // Lock browser pinch-zoom WHILE IN A ROOM only (the marketing/docs pages stay zoomable). The room is
  // a fixed app surface: a stray two-finger zoom drifts the controls off-screen. Android/Chrome honours
  // the viewport `maximum-scale`; iOS Safari ignores it, so we also preventDefault its `gesture*` events.
  useEffect(() => {
    const viewMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const prevView = viewMeta?.getAttribute('content') ?? null
    viewMeta?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    const blockGesture = (e: Event) => e.preventDefault()
    document.addEventListener('gesturestart', blockGesture, { passive: false })
    document.addEventListener('gesturechange', blockGesture, { passive: false })
    document.addEventListener('gestureend', blockGesture, { passive: false })
    return () => {
      if (viewMeta && prevView !== null) viewMeta.setAttribute('content', prevView)
      document.removeEventListener('gesturestart', blockGesture)
      document.removeEventListener('gesturechange', blockGesture)
      document.removeEventListener('gestureend', blockGesture)
    }
  }, [])

  // The PRE-JOIN screen is a light "paper" page (the SAME palette as the create-room page), painted at
  // the DOCUMENT level (body class + <html> bg + theme-color) so iOS repaints the safe-area / notch
  // correctly — otherwise a fixed full-window panel's bg change leaves a stale white band under the notch
  // after joining. Once IN the call (or offline/LAN, which joins straight away) the whole surface goes
  // black. Paint <html> too: a drag-resize repaints the bare root before the content reflows.
  useEffect(() => {
    const dark = joined || !!offline
    const html = document.documentElement
    const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    const prevBg = html.style.background
    const prevScheme = html.style.colorScheme
    const prevTheme = themeMeta?.getAttribute('content') ?? null
    document.body.classList.toggle('roomdark', dark)
    document.body.classList.toggle('paper', !dark)
    html.style.background = dark ? '#000' : '#faf6ef'
    html.style.colorScheme = dark ? 'dark' : 'light'
    themeMeta?.setAttribute('content', dark ? '#000000' : '#faf6ef')
    return () => {
      document.body.classList.remove('roomdark')
      document.body.classList.remove('paper')
      html.style.background = prevBg
      html.style.colorScheme = prevScheme
      if (themeMeta && prevTheme !== null) themeMeta.setAttribute('content', prevTheme)
    }
  }, [joined, offline])

  // Build the invite link to copy/share. For an OPEN, online room → the WhatsApp-friendly PATH link
  // (/j/room: functions/j returns nothing to preview crawlers so the raw URL stays visible, and
  // redirects people/agents into the room). Gated/verified or offline rooms keep the full URL, which
  // carries the admission params (gate descriptor / credential / ?galaxy) the /j hop can't preserve.
  // A licensed opener mints a fresh short-lived TURN grant baked into the link (?k=). Shared by the
  // page's "Copy invite" button AND the widget's own copy button (passed via `inviteLink` below).
  const buildInvite = async (): Promise<string> => {
    const key = getLicenseKey()
    const grant = key ? (await requestRoomGrant(roomName, key))?.grant : null
    if (!offline && gate.mode === 'open') {
      let link = `${location.origin}/j/${encodeURIComponent(roomName)}`
      // Carry the agent-call consent through the /j hop so a re-shared link STILL shows the pre-join
      // consent: the /j function forwards the query string, and the app reads gate params from the
      // query when the fragment has none (gateParamsFrom). The notice/type aren't secret.
      const cp = new URLSearchParams()
      if (agentCall) cp.set('ag', agentCall === 'audiovideo' ? 'av' : 'a')
      if (notice) cp.set('n', notice)
      if (roomDesc) cp.set('d', roomDesc) // friendly room title (shown on the pre-join) survives the /j hop
      const q = cp.toString()
      if (q) link += `?${q}`
      return grant ? linkWithGrant(link, grant) : link
    }
    return grant ? linkWithGrant(location.href, grant) : location.href
  }

  // The way OUT of a full-window room (no browser back button in an installed PWA). Online: clear the
  // hash → App re-renders the Landing (browser) or launcher (installed app). Offline (LAN): the room
  // rides a ?galaxy= query, so navigate to the clean origin to drop it and land home. Used both by the
  // widget's explicit exit (onExit) AND when you hang up the call (the in-call → left transition below),
  // so leaving the room window always returns you to the page before — never the pre-join lobby.
  const goHome = () => {
    if (offline) location.href = location.origin + location.pathname
    else location.hash = ''
  }

  // Mount the real widget (panel open — this is a deliberate room visit). With
  // `?idclient=`, turn on verified identity for local testing (see idClient above).
  useEffect(() => {
    const w = mount({
      room: roomName,
      startOpen: true,
      fill: true, // the dedicated room window: fill it, opaque, edge-resize (no ghost)
      ...(brand.accent ? { accent: brand.accent } : {}), // white-label: recolour the call to the brand accent
      brandName: brand.name, // white-label: the product name shown in the call chrome (default 'Kibitz')
      // white-label: a sibling served off-platform (no same-origin /api/*) borrows the platform's
      // signaling + TURN. Omitted on the platform itself → same-origin default.
      ...(brand.signalHost ? { signalHost: brand.signalHost } : {}),
      ...(brand.turnHost ? { turnHost: brand.turnHost } : {}),
      ...(brand.apiBase ? { apiBase: brand.apiBase } : {}),
      inviteLink: buildInvite, // the widget's "Copy invite link" uses our WhatsApp-friendly builder
      ...(agentCall ? { agentCall } : {}),
      ...(notice ? { notice } : {}),
      ...(roomDesc ? { roomDesc } : {}),
      onExit: goHome,
      ...(effectiveIdCfg ? { verifyIdentity: effectiveIdCfg } : {}),
      ...(gate.mode !== 'open' || gate.hostPubKey || gate.hostName || gate.hostEmail ? { joinGate: gate } : {}), // also pass it for an OPEN room that has a host (key / name / OIDC-email tier)
      ...(selfCred ? { joinCredential: selfCred } : {}),
      ...(!offline && getRelayOnly() ? { relayOnly: true } : {}),
    })
    // Follow call state so the page can switch from the light pre-join to the black call. AND: leaving
    // the call (hang up) in this dedicated room window returns you to the page before — not the pre-join
    // lobby, which has no other way out. Fire goHome ONLY on the in-call → left transition, so the
    // initial pre-join and the post-reload "↻ Rejoin" screen (both inCall:false from the start) are
    // unaffected. The listener is removed before unmount, so teardown can't trigger a navigation.
    let wasInCall = false
    const off = w.on('state', (s: { inCall: boolean }) => {
      setJoined(s.inCall)
      if (wasInCall && !s.inCall) goHome()
      wasInCall = s.inCall
    })
    return () => {
      off()
      w.unmount()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gate is stable per room visit
  }, [roomName])


  // Intentionally empty: the call is the full-window widget mounted above; this is just a black backdrop
  // (seen only when the call pops out, or for a frame at a resize margin) — nothing on it, not even a build
  // stamp (it would show through the pop-out window / resize margin). The build id lives in About instead.
  return <main className="roompage roompage-empty" />
}
