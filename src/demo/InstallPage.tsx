import { useEffect, useState } from 'react'
import { canInstallNatively, markInstalled, onInstallChange, platform, promptInstall, type Platform } from '../core/install'
import { brand } from '../brand'

// Per-platform manual steps — the fallback when there's no one-tap native prompt
// (iOS / Mac Safari always; Chromium when the browser hasn't offered it yet).
// On iOS EVERY browser is WebKit, so platform() can only say "ios" — but the Add-to-Home-Screen
// flow differs per browser (Share button location), and Firefox-iOS can't do it at all. Detect the
// actual iOS browser from the UA and tailor the steps so we don't show "Safari" steps inside Chrome.
function iosGuide(): { label: string; steps: string[] } {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/CriOS/.test(ua))
    return {
      label: 'iPhone / iPad — Chrome',
      steps: [
        'Tap the Share button (a square with an up-arrow) in Chrome’s toolbar.',
        'Scroll down and tap “Add to Home Screen”.',
        'Tap “Add” — Kibitz lands on your home screen.',
      ],
    }
  if (/EdgiOS/.test(ua))
    return {
      label: 'iPhone / iPad — Edge',
      steps: ['Tap the ⋯ menu, then “Share”.', 'Tap “Add to Home Screen”.', 'Tap “Add” — Kibitz lands on your home screen.'],
    }
  if (/FxiOS/.test(ua))
    return {
      label: 'iPhone / iPad — Firefox',
      steps: [
        'Firefox on iPhone can’t add web apps to the Home Screen.',
        'Open kibitz.chat in Safari instead.',
        'There: Share → “Add to Home Screen” → “Add”.',
      ],
    }
  return {
    label: 'iPhone / iPad — Safari',
    steps: [
      'Tap the Share button (a square with an up-arrow) in the toolbar.',
      'Scroll down and tap “Add to Home Screen”.',
      'Tap “Add” — Kibitz lands on your home screen.',
    ],
  }
}

const GUIDE: Partial<Record<Platform, { label: string; steps: string[] }>> = {
  android: {
    label: 'Android — Chrome',
    steps: ['Tap the ⋮ menu (top-right).', 'Tap “Install app” (or “Add to Home screen”).', 'Confirm — Kibitz installs like any app.'],
  },
  'desktop-chromium': {
    label: 'Desktop — Chrome / Edge',
    steps: [
      'Click the install icon (a small monitor with a ↓) at the right of the address bar.',
      `Or open the ⋮ menu → “Install ${brand.name}…”.`,
      'Confirm — it opens in its own window.',
    ],
  },
  'macos-safari': {
    label: 'Mac — Safari',
    steps: ['Open the File menu (or the Share button).', 'Choose “Add to Dock”.', 'Launch Kibitz from the Dock in its own window.'],
  },
}

/** The install page (route `#install`): environment-specific instructions, plus the
 *  one-tap native prompt where the browser offers it. */
export function InstallPage({ onBack, onStart }: { onBack: () => void; onStart: () => void }) {
  const [native, setNative] = useState(canInstallNatively())
  const [installing, setInstalling] = useState(false)
  const plat = platform()
  const guide = plat === 'ios' ? iosGuide() : GUIDE[plat]
  // A rebrand (sibling product, signalled by its own accent) gets only the legal links it has;
  // the default product also links its Security + Engine pages. Same signal Landing uses.
  const rebrand = !!brand.accent

  useEffect(() => onInstallChange(() => setNative(canInstallNatively())), [])
  useEffect(() => {
    document.body.classList.add('paper')
    return () => document.body.classList.remove('paper')
  }, [])

  const doInstall = async () => {
    setInstalling(true)
    await promptInstall() // fires onInstallChange → setNative; no need to set it again here
    setInstalling(false)
  }

  return (
    <main className="installpage">
      <button className="back-link" type="button" onClick={onBack}>
        ← Back
      </button>
      <h1>Install {brand.name}</h1>
      <p className="sub">
        Add {brand.name} to your device: it launches full-screen from your home screen, and invite links someone sends you
        open <strong>right in the app</strong> instead of bouncing to the browser. It still works without installing —
        this just makes it feel native.
      </p>

      {native ? (
        // A one-tap native install is available (Chromium) — show just the button; the
        // manual steps would only restate it.
        <div className="install-native">
          <button className="start" type="button" onClick={doInstall} disabled={installing}>
            📲 Install {brand.name}
          </button>
          <p className="hint">One tap — your browser will confirm.</p>
        </div>
      ) : guide ? (
        <section className="install-steps">
          <h2>{guide.label}</h2>
          <ol>
            {guide.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {/* iOS / Mac Safari fire NO install event and expose no install-state API, so the page
              can't auto-detect that you added it. Let the user confirm — we record it and the home
              page then shows the installed state. (Chromium platforms above auto-detect, no need.) */}
          {(plat === 'ios' || plat === 'macos-safari') && (
            <button
              className="install-added"
              type="button"
              onClick={() => {
                markInstalled()
                onBack()
              }}
            >
              ✓ I’ve added it
            </button>
          )}
        </section>
      ) : (
        <section className="install-steps">
          <h2>{plat === 'firefox' ? 'Firefox' : 'Your browser'}</h2>
          <p>
            {plat === 'firefox'
              ? 'Firefox doesn’t install web apps. Open kibitz.chat in Chrome, Edge, or Safari to install — '
              : 'Look for an “Install” or “Add to Home Screen” option in your browser’s menu — or '}
            just{' '}
            <button className="linklike" type="button" onClick={onStart}>
              start a room here
            </button>{' '}
            in the browser; everything works without installing.
          </p>
        </section>
      )}

      <footer className="fine">
        <p className="fine-links">
          <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
          {!rebrand && (
            <>
              {' '}· <a href="/security">Security</a> · <a href="/docs">Engine</a>
            </>
          )}
        </p>
      </footer>
    </main>
  )
}
