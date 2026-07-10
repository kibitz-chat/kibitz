import { useEffect } from 'react'
import { markUninstalled, platform, type Platform } from '../core/install'
import { brand } from '../brand'

// How to remove the installed web app, per platform. Removal is the same on iOS regardless of which
// browser added it (it's just a Home-Screen icon), so — unlike install — there's no per-iOS-browser
// branching here.
const GUIDE: Partial<Record<Platform, { label: string; steps: string[] }>> = {
  ios: {
    label: 'iPhone / iPad',
    steps: [
      `Touch and hold the ${brand.name} icon on your Home Screen.`,
      'Tap “Remove App”.',
      'Tap “Delete App”, then confirm.',
    ],
  },
  android: {
    label: 'Android',
    steps: [
      `Touch and hold the ${brand.name} icon.`,
      'Drag it to “Uninstall” (or tap App info → Uninstall).',
      'Confirm.',
    ],
  },
  'desktop-chromium': {
    label: 'Desktop — Chrome / Edge',
    steps: [
      `Open ${brand.name}, then use the ⋮ menu in its window → “Uninstall ${brand.name}…”.`,
      `Or visit chrome://apps, right-click ${brand.name} → “Remove from Chrome”.`,
      'Confirm “Remove”.',
    ],
  },
  'macos-safari': {
    label: 'Mac — Safari',
    steps: ['Open Launchpad.', `Click and hold ${brand.name} until the icons jiggle.`, `Click the ✕ on ${brand.name} to delete it.`],
  },
}

/** The uninstall page (route `#uninstall`) — the mirror of InstallPage: per-platform removal steps
 *  plus a manual "✓ I've removed it" confirm. iOS / Mac Safari fire no event when you delete a
 *  Home-Screen / Dock app, so this is how the home page learns it's gone (markUninstalled clears the
 *  persisted flag). On Chromium it's belt-and-suspenders — a real uninstall is also auto-detected. */
export function UninstallPage({ onBack }: { onBack: () => void }) {
  const plat = platform()
  const guide = GUIDE[plat]

  useEffect(() => {
    document.body.classList.add('paper')
    return () => document.body.classList.remove('paper')
  }, [])

  return (
    <main className="installpage">
      <button className="back-link" type="button" onClick={onBack}>
        ← Back
      </button>
      <h1>Remove {brand.name}</h1>
      <p className="sub">
        {brand.name} is a web app, so removing it is just deleting the icon — nothing is left behind on your device. Here’s how
        on yours.
      </p>

      <section className="install-steps">
        <h2>{guide?.label ?? 'Your device'}</h2>
        <ol>
          {(guide?.steps ?? [`Remove the ${brand.name} icon / app the way you remove any app on your device.`]).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        {/* iOS / Mac Safari can't tell the page you deleted it — confirm so the home page stops
            showing you as installed. */}
        <button
          className="install-added"
          type="button"
          onClick={() => {
            markUninstalled()
            onBack()
          }}
        >
          ✓ I’ve removed it
        </button>
      </section>

      <footer className="fine">
        <p className="fine-links">
          <a href="/privacy">Privacy</a> · <a href="/security">Security</a> · <a href="/docs">Engine</a>
        </p>
      </footer>
    </main>
  )
}
