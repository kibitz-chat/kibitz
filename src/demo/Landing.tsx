import { useEffect, useRef, useState, lazy, Suspense } from 'react'
import { getRelayOnly, setRelayOnly } from '../core/relayPref'
import { brand } from '../brand'
import { parseRoomTarget } from '../core/roomInput'
import { RecentRooms } from './RecentRooms'
import { ClipboardIcon, QrIcon } from '../widget/icons'

// The QR scanner (camera + jsQR) loads only when the user taps "Scan", as its own chunk —
// so it never weighs down the landing/entry bundle and the prerender never pulls in jsQR.
const QrScanner = lazy(() => import('../react/QrScanner').then((m) => ({ default: m.QrScanner })))

/**
 * Personal settings, reachable from the launcher / entry page so BOTH a room creator and someone just
 * opening a link can set them. Today: "hide my IP" (relay-only), a per-browser preference applied to
 * every call you join or start. The relay state is read AFTER hydration (localStorage throws during the
 * prerender), so the static HTML and the client agree — no SSR mismatch.
 */
function Settings() {
  const [open, setOpen] = useState(false)
  const [relay, setRelay] = useState(false)
  // The wake-pairing entry is a DEV preview — kept out of normal Settings (and so out of a
  // normal user's reach) behind a deliberate unlock: tap the build line 5×. Persists once
  // unlocked. See docs/wake-seam.md.
  const [taps, setTaps] = useState(0)
  const [wakeDev, setWakeDev] = useState(false)
  useEffect(() => setRelay(getRelayOnly()), [])
  useEffect(() => {
    try {
      setWakeDev(localStorage.getItem('kbz-wake-dev') === '1')
    } catch {
      /* private mode */
    }
  }, [])
  const bumpDev = () => {
    const n = taps + 1
    setTaps(n)
    if (n >= 5) {
      setWakeDev(true)
      try {
        localStorage.setItem('kbz-wake-dev', '1')
      } catch {
        /* private mode */
      }
    }
  }
  return (
    <div className="settings">
      <button
        className="settings-btn"
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Settings"
      >
        ⚙️ Settings
      </button>
      {open && (
        // Full-screen backdrop: a large, offset-tolerant dismiss target (tap anywhere outside to
        // close) — so the panel is closeable even when the small ✕ is fiddly (iOS landscape).
        <div className="settings-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
      )}
      {open && (
        <div className="settings-panel" role="dialog" aria-label="Settings">
          <div className="settings-head">
            <span>Settings</span>
            <button className="settings-x" type="button" onClick={() => setOpen(false)} aria-label="Close">
              ✕
            </button>
          </div>
          <label className="settings-row">
            <input
              type="checkbox"
              checked={relay}
              onChange={(e) => {
                setRelayOnly(e.target.checked)
                setRelay(e.target.checked)
              }}
            />
            <span className="settings-txt">
              🛡️ Hide my IP from other people <em>(route through the relay)</em>
            </span>
          </label>
          <p className="settings-fine">
            Personal to this browser, applied to every call you join or start. Your media + data go through the TURN
            relay, so others see the relay’s IP — not yours. The relay (and the room host) still see your IP, and it
            can add a little latency, but it can’t read your end-to-end-encrypted media or messages.
          </p>
          {/* The running build — so you can confirm you're on the latest deploy without the landing
              page (the installed app launches straight past it). Selectable, to quote when reporting. */}
          {/* Dev: connect a push "Hub" so this installed app can be rung into a room. The only
              way to reach #wake inside the installed iOS PWA (no address bar) — gated behind the
              5-tap unlock so it isn't a normal-user surface. See docs/wake-seam.md. */}
          {wakeDev && (
            <button className="settings-wake linklike" type="button" onClick={() => (location.hash = 'wake')}>
              📟 Wake setup <em>(developer preview)</em>
            </button>
          )}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the build
              line doubles as the dev unlock (tap 5×); harmless to anyone who isn't looking for it. */}
          <p
            className="settings-build"
            title="The build this app is running — quote it when reporting an issue"
            onClick={bumpDev}
          >
            build {__BUILD_ID__}
          </p>
        </div>
      )}
    </div>
  )
}

// The marketing landing, in its OWN module with a minimal import graph so it can be
// rendered to static HTML at build time (react-dom/server, plain Node — no browser).
// It mounts NO call widget (the page is pure content), so prerendering never pulls in the
// WebRTC engine and the markup is produced + shipped cleanly as static HTML.
// See scripts/prerender.mjs + src/prerender.tsx.
export function Landing({
  onStart,
  onOpen,
  standalone,
  installed,
  onInstall,
  onUninstall,
}: {
  onStart: (desc?: string) => void
  /** Join a room from a pasted link/code. Returns false if the input names no room (show an inline hint). */
  onOpen?: (input: string) => boolean
  /** Running as an installed PWA → show the clean launcher instead of the marketing page. */
  standalone?: boolean
  /** Browser tab, but the app is already installed → the Install CTA becomes an honest
   *  "✓ Installed" note (no web API can launch a PWA from a tab — the user opens it themselves). */
  installed?: boolean
  /** Browser only: open the install page. The paste-link is replaced by an Install CTA here —
   *  a browser visitor just opens an invite link directly; pasting only matters in the installed app. */
  onInstall?: () => void
  /** Installed state only: open the uninstall page (removal steps + a manual "I've removed it"
   *  confirm — the mirror of the Install flow, for iOS/Mac Safari which fire no uninstall event). */
  onUninstall?: () => void
}) {
  // Paper background behind the overlay too (iOS rubber-band would flash dark).
  useEffect(() => {
    document.body.classList.add('paper')
    return () => document.body.classList.remove('paper')
  }, [])
  // A rebrand (a sibling product, signalled by its own accent) gets a MINIMAL landing — its hero +
  // its own `points` + the footer — and the default's product-specific marketing below is hidden, so
  // a sibling never shows this product's copy. Default brand → the full marketing. Sibling copy lives
  // in the sibling's repo (brand env), never here.
  const rebrand = !!brand.accent
  // Installed app: a clean launcher (start a room / paste a link) — no marketing.
  if (standalone) return <Launcher onStart={onStart} onOpen={onOpen} />
  return (
    <main className="landing">
      <section className="hero">
        <h1>{brand.name}</h1>
        <p className="tagline">
          {brand.taglineLanding.map((line, i) => (
            <span key={i}>{line}</span>
          ))}
        </p>
        {brand.heroSub ? (
          brand.heroSub.map((p, i) => (
            <p key={i} className="sub">
              {p}
            </p>
          ))
        ) : (
          <p className="sub">
          No accounts. A room is just a link — open it and you’re instantly together: video, voice and chat, straight
          between browsers and end-to-end encrypted, so no server can see or hear you. Then look at something together —
          <strong> share your screen</strong> in a click, right from the browser.{' '}
          <a className="demo-link" href="/security">How security works{'\u00A0'}→</a>
          </p>
        )}
        <div className="start-row">
          {/* When a brand offers a second CTA (its AI-agent flow), THAT becomes the accent/primary and
              "Start a room" steps back to the secondary look — the colour swap the brand asked for. With no
              second CTA (default), "Start a room" stays primary. */}
          <button className={`start${brand.secondaryCta ? ' start-secondary' : ''}`} type="button" onClick={() => onStart()}>
            Start a room
          </button>
          {brand.secondaryCta && (
            <a className="start" href={brand.secondaryCta.href}>
              {brand.secondaryCta.label}
            </a>
          )}
        </div>
        {/* "free" only for the default product — a rebrand (e.g. metered AI agents) isn't free. */}
        <p className="hint">{brand.accent ? 'no signup · works on phones' : 'free · no signup · works on phones'}</p>
        {onOpen && <RecentRooms />}
        {installed && onOpen ? (
          // Already installed, but viewing in a browser tab: no "open the app" button can work
          // (no web API launches a PWA from a tab), so offer the genuinely useful action — paste
          // an invite link to join a room right here. ⚙️ Settings sits beside it.
          <OpenRoom onOpen={onOpen} extra={brand.accent ? undefined : <Settings />} />
        ) : (
          // Not installed yet (browser): the Install CTA + ⚙️ Settings, AND a collapsed "Open a room"
          // so a browser visitor who was given a link — or just a bare room CODE — can join right here
          // without having to install first. Collapsed by default so it doesn't crowd the two CTAs.
          <>
            <div className="entry-row">
              {onInstall && (
                <button className="install-cta" type="button" onClick={onInstall}>
                  📲 Install {brand.name}
                </button>
              )}
              {!brand.accent && <Settings />}
            </div>
            {onOpen && <OpenRoom onOpen={onOpen} />}
          </>
        )}
        <p className="hint hint-room">
          {installed
            ? 'You’ve got the app installed — invite links open right in it. '
            : 'Add it to your home screen so invite links open right in the app. '}
          Every room gets a private, un-guessable link — you choose who can join: anyone with the link, or only{' '}
          <strong>verified people or AI agents</strong>.
        </p>
        {installed && onUninstall && (
          <button className="install-uninstall linklike" type="button" onClick={onUninstall}>
            Remove {brand.name} from this device →
          </button>
        )}
      </section>

      {/* The default brand's product-specific marketing — hidden for a rebrand (which shows its own
          `points` below instead, so a sibling never displays this product's copy). */}
      {!rebrand && (
        <>
      {/* etym */}
      <blockquote className="etym">
        <strong>kibitzer</strong> <em>(n., from Yiddish)</em> — the one at the card table who isn’t playing: just
        hanging over the game, watching, chatting. Be that, anywhere on the web.
      </blockquote>

      {/* Flagship live demo: an AI agent literally BEING the kibitzer at a card table. */}
      <section className="uses demo-feature">
        <h2>🃏 Watch an AI kibitzer join your game</h2>
        <p>
          Deal yourself a hand of Whist and an <strong>AI agent joins your room</strong> — it watches your cards and
          whispers private coaching to you, over the same end-to-end-encrypted channel, acting right in a human’s place.
          It enters by its own key, sees only what you let it, and never touches the table chat. No accounts, no setup —
          it all runs on the open Kibitz engine.
        </p>
        <a className="start" href="https://whist.kibitz.chat/?demo" target="_blank" rel="noreferrer">
          Play Whist with an AI kibitzer{'\u00A0'}→
        </a>
        <p className="hint">a live, no-signup demo</p>
      </section>

      <section className="uses lead-uses">
        <h2>Made for side-by-side, not meetings</h2>
        <p>
          Pair-programming and debugging · studying together · the daily crossword or Connections · reading a
          recipe or article together · watching the match · keeping company while you both work.
        </p>
      </section>

      <ul className="privacy-strip" aria-label="Privacy at a glance">
        <li>🔒 End-to-end encrypted</li>
        <li>🙈 No media server</li>
        <li>🪪 No accounts</li>
        <li>🚫 No ads or trackers</li>
      </ul>

      <section className="why">
        <div className="card">
          <h2>🔒 Actually private</h2>
          <p>
            Calls are peer-to-peer WebRTC, encrypted end to end (DTLS-SRTP). When two networks can’t connect directly,
            an encrypted relay forwards the call — it still can’t read it, and there’s no media server that{' '}
            <em>could</em> decode or record you.
          </p>
        </div>
        <div className="card">
          <h2>🛡️ Nothing to subpoena</h2>
          <p>
            Your call is end-to-end encrypted and goes straight between browsers — no server ever holds it. So no one,
            including us, can be made to record, decrypt, or shut down a call in progress. We have nothing to hand
            over.
          </p>
        </div>
        <div className="card">
          <h2>🔗 A link is the room</h2>
          <p>
            Start a room, send the URL. First to arrive opens the table; friends join from any browser. If everyone
            leaves, the room simply stops existing.
          </p>
        </div>
        <div className="card">
          <h2>🤫 Polite by default</h2>
          <p>
            Everyone joins muted with the camera off — turn yourself on when you’re ready. Speaking lights up your
            tile, so the quiet ones stay comfortably quiet.
          </p>
        </div>
      </section>

      {/* Bold capability sections — screen sharing + human↔AI collaboration. */}
      <section className="uses">
        <h2>Show anything — share your screen</h2>
        <p>
          Share a tab or your whole screen in one click, right from the browser — no extension, nothing to install.
          Everyone in the room watches live, and anyone you invite can join from a plain link. The walkthrough, the
          spreadsheet, the recipe, the match — look at it together.
        </p>
      </section>

      <section className="uses">
        <h2>Built on an open engine — for people and AI</h2>
        <p>
          The same room a person joins, an <strong>AI agent</strong> joins too — over the same encrypted channel,
          seeing what you see and acting right beside you. It’s the same engine site owners{' '}
          <a className="demo-link" href="/docs">
            embed in one line
          </a>{' '}
          or drive headless to build their own thing.
        </p>
        <p className="hint">
          <a className="demo-link" href="/docs">
            Meet the Kibitz Engine{'\u00A0'}→
          </a>
        </p>
        <p className="hint">
          Open source under Apache 2.0 —{' '}
          <a
            className="demo-link"
            href="https://github.com/kibitz-chat/kibitz"
            target="_blank"
            rel="noreferrer"
          >
            read every line on GitHub{'\u00A0'}↗
          </a>
        </p>
      </section>

      {/* Help / support: one copyable prompt turns any AI assistant into a Kibitz support agent. */}
      <section className="uses help-cta">
        <h2>❓ Questions? Ask an AI anything about Kibitz</h2>
        <p>
          Copy a ready-made prompt and paste it into ChatGPT, Claude, or any assistant with web access — it reads the
          Kibitz manual for itself and answers whatever you ask: how to start a room, share your screen, who can join,
          how the encryption works.
        </p>
        <a className="start" href="#help">
          Get help{' '}→
        </a>
        <p className="hint">no account, no waiting — just paste &amp; ask</p>
      </section>
        </>
      )}

      {/* A rebrand's own key points (from its brand config — never this product's copy). */}
      {rebrand && brand.points && brand.points.length > 0 && (
        <section className="uses">
          {brand.pointsTitle && <h2>{brand.pointsTitle}</h2>}
          <ul className="brand-points">
            {brand.points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </section>
      )}

      <footer className="fine">
        {rebrand ? (
          <>
            {brand.footerNote && <p>{brand.footerNote}</p>}
            {brand.footerLinks && brand.footerLinks.length > 0 && (
              <p className="fine-links">
                {brand.footerLinks.map((l, i) => (
                  <span key={i}>
                    {i > 0 && ' · '}
                    <a href={l.href}>{l.label}</a>
                  </span>
                ))}
              </p>
            )}
          </>
        ) : (
          <>
            <p>Best for 2–6 people.</p>
            <p>
              Almost every call connects directly, browser to browser — free. When two networks can’t reach each other
              a relay carries the still-encrypted call; there’s a free fallback, and a room opener can optionally
              <strong> sponsor an at-cost relay</strong> (opener-pays) — just bandwidth, no markup.
            </p>
            <p className="fine-links">
              <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/security">Security</a> ·{' '}
              <a href="/docs">Engine</a> · <a href="/relay">Offline mode</a> · <a href="#help">Help</a>
            </p>
          </>
        )}
        <p className="fine-build" title="The build currently running in your browser">
          build {__BUILD_ID__}
        </p>
      </footer>
    </main>
  )
}

/**
 * The installed-app launcher: the PWA's clean home — headline, "Start a room", and a
 * paste-a-link field, no marketing (you've already installed). Leaving a room returns here
 * (the room's ← Home / onExit clears the hash). Paste-link opens EXPANDED — an installed app
 * has no address bar to type an invite link into.
 */
function Launcher({
  onStart,
  onOpen,
}: {
  onStart: (desc?: string) => void
  onOpen?: (input: string) => boolean
}) {
  return (
    <main className="launcher">
      <section className="hero">
        <h1>{brand.name}</h1>
        <p className="tagline">
          {brand.taglineLauncher.map((line, i) => (
            <span key={i}>{line}</span>
          ))}
        </p>
        <div className="start-row">
          {/* Second CTA (the AI-agent flow) is the accent/primary; "Start a room" steps back to secondary. */}
          <button className={`start${brand.secondaryCta ? ' start-secondary' : ''}`} type="button" onClick={() => onStart()}>
            Start a room
          </button>
          {brand.secondaryCta && (
            <a className="start" href={brand.secondaryCta.href}>
              {brand.secondaryCta.label}
            </a>
          )}
        </div>
        <p className="hint">{brand.accent ? 'joins muted, camera off' : 'free · joins muted, camera off'}</p>
        {onOpen && <RecentRooms />}
        {onOpen ? (
          <>
            <div className="launcher-or" aria-hidden="true">
              or join one you were sent
            </div>
            <OpenRoom onOpen={onOpen} expanded extra={brand.accent ? undefined : <Settings />} />
          </>
        ) : !brand.accent ? (
          <div className="entry-row">
            <Settings />
          </div>
        ) : null}
      </section>
    </main>
  )
}

/**
 * "Open a room" — paste a link or room code to JOIN, for when there's no address bar to type
 * one into (an installed Home-Screen PWA, especially on iOS, where a tapped link can't open the
 * app). Collapsed to a one-line link until used (unless `expanded`), so on the marketing page
 * it never competes with "Start a room"; in the launcher it's a primary action, shown open.
 */
function OpenRoom({
  onOpen,
  expanded,
  extra,
}: {
  onOpen: (input: string) => boolean
  expanded?: boolean
  /** An inline control rendered NEXT TO the primary button (the toggle when collapsed, the
   *  paste button when open) — used to sit the ⚙️ Settings pill beside it. */
  extra?: React.ReactNode
}) {
  const [open, setOpen] = useState(!!expanded)
  const [scan, setScan] = useState(false)
  const [val, setVal] = useState('')
  // '' none · 'invalid' the text isn't a room · 'clip' the clipboard read failed/was empty (a DIFFERENT
  // problem — don't blame the link). Conflating them showed "not a room link" when paste was just denied.
  const [err, setErr] = useState<'' | 'invalid' | 'clip'>('')
  const inputRef = useRef<HTMLInputElement>(null)
  // Returning from the camera scanner re-mounts this form; suppress the input's autofocus on THAT remount so
  // tapping Cancel doesn't pop the keyboard. Reset on a deliberate open so the first open still focuses.
  const fromScanRef = useRef(false)
  // Clipboard read needs a user gesture (and shows iOS's "Allow Paste") — detect availability after
  // hydration so the prerendered HTML and the client agree (no SSR mismatch).
  const [canPaste, setCanPaste] = useState(false)
  // After a first tap whose clipboard read came back empty (iOS surfaced "Allow Paste" but the grant
  // lands only after you tap it), the button flips to "Tap again to paste" — the second tap reads it.
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    setCanPaste(typeof navigator !== 'undefined' && !!navigator.clipboard?.readText)
  }, [])

  // A pasted value is "joinable" exactly when onOpen would accept it (same checks, NO navigation): a brand
  // short link (/r/<code>) when this brand runs that service, else a parseable room link/code. Drives the
  // grayed-out Join button, and pre-checks the clipboard before paste-join navigates to the prejoin page.
  const isJoinable = (s: string): boolean => {
    const t = (s ?? '').trim()
    if (!t) return false
    if (brand.shortlinkApi) {
      try {
        const u = new URL(t, location.origin)
        // Accept the shortlink on OUR origin OR the shortener's own (the apex, e.g. kibitz.chat, when the app runs
        // on www.kibitz.chat after the Cloudflare split) — MIRROR onOpen, which navigates it. Without the shortOrigin
        // check the Join button greyed out an apex /r/ link and showed "not a room link", though onOpen would open it.
        const shortOrigin = new URL(brand.shortlinkApi, location.origin).origin
        if ((u.origin === location.origin || u.origin === shortOrigin) && /^\/r\/[A-Za-z0-9]{4,16}\/?$/.test(u.pathname)) return true
      } catch {
        /* not a URL — fall through to the room parse */
      }
    }
    return !!parseRoomTarget(t, location.origin)
  }
  const valid = isJoinable(val)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    // Pre-check before navigating (the button is also disabled while invalid — this guards Enter-submit too).
    if (!valid || !onOpen(val)) setErr('invalid') // invalid → stay and hint (a valid one navigates away)
  }

  // Read the clipboard and join. The tap is the gesture iOS requires.
  // iOS QUIRK: the FIRST readText() after the "Allow Paste" prompt resolves EMPTY — the grant lands only
  // AFTER you tap "Allow", so a single tap can't read it. Rather than poll with a spinner, do an HONEST
  // two-tap: the first tap surfaces the prompt; if the read was empty we flip the button to "Tap again to
  // paste"; the second tap (now granted) reads the text and joins. No error, no spinner. A genuinely
  // empty clipboard only surfaces the "couldn't read" hint on that SECOND tap.
  const readClipboard = async (): Promise<string | null> => {
    try {
      return ((await navigator.clipboard.readText()) ?? '').trim()
    } catch {
      return null // denied / blocked / not a secure context
    }
  }
  const pasteJoin = async () => {
    const text = await readClipboard()
    if (text) {
      setArmed(false)
      setVal(text)
      // Validate the pasted text BEFORE navigating to the prejoin page — a non-room stays here with the hint.
      if (!isJoinable(text) || !onOpen(text)) {
        setErr('invalid') // came through, but it isn't a room
      }
      return
    }
    // Empty read. First tap just surfaced "Allow Paste" — arm for the second tap (no error yet).
    if (!armed) {
      setArmed(true)
      setErr('')
      return
    }
    // Second tap still empty → genuinely nothing to paste / denied. Be honest + focus the field.
    setArmed(false)
    setErr('clip')
    inputRef.current?.focus()
  }

  if (!open) {
    return (
      <div className="entry-row">
        <button className="open-toggle" type="button" onClick={() => { fromScanRef.current = false; setOpen(true) }}>
          Have a link? Open a room →
        </button>
        {extra}
      </div>
    )
  }

  // Camera scanner: onScan reuses onOpen — a real room navigates away, anything else returns
  // false so the scanner keeps looking. Lazy, so the camera/jsQR chunk loads only now.
  if (scan) {
    return (
      <div className="open-form">
        <Suspense fallback={<p className="hint">Loading scanner…</p>}>
          <QrScanner onScan={onOpen} onClose={() => { fromScanRef.current = true; setScan(false) }} />
        </Suspense>
      </div>
    )
  }

  return (
    <form className="open-form" onSubmit={submit}>
      {(canPaste || extra) && (
        <div className="entry-row">
          {canPaste && (
            <button className="open-paste" type="button" onClick={pasteJoin}>
              <ClipboardIcon /> {armed ? 'Tap again to paste' : 'Paste link & join'}
            </button>
          )}
          {extra}
        </div>
      )}
      <div className="open-row">
        <input
          ref={inputRef}
          className="open-input"
          value={val}
          onChange={(e) => {
            setVal(e.target.value)
            if (err) setErr('')
            if (armed) setArmed(false) // they're typing/pasting by hand now — drop the "tap again" state
          }}
          placeholder="Paste a room link or code"
          aria-label="Room link or code"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the user just chose to open this field — but NOT
          // when returning from the scanner, whose remount would otherwise pop the keyboard on Cancel
          autoFocus={!fromScanRef.current}
        />
        <button className="open-go" type="submit" disabled={!valid} aria-disabled={!valid}>
          Join
        </button>
      </div>
      {err === 'invalid' ? (
        <p className="open-err">That doesn’t look like a Kibitz room link or code.</p>
      ) : err === 'clip' ? (
        <p className="open-err">Couldn’t read your clipboard — paste the link in the field and tap Join.</p>
      ) : null}
      <button className="open-scan" type="button" onClick={() => setScan(true)}>
        <QrIcon /> Scan a QR code
      </button>
    </form>
  )
}
