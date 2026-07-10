import type { ReactNode } from 'react'

// Small, recognizable glyphs for the install steps — drawn to read at chip/toolbar size.
const ShareGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12" />
    <path d="M8 7l4-4 4 4" />
    <path d="M7 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1" />
  </svg>
)
const InstallGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
)
const MenuGlyph = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="5" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="12" cy="19" r="1.7" />
  </svg>
)
const AddHomeGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <path d="M12 8v8M8 12h8" />
  </svg>
)
// iOS share sheet "View More" — a downward chevron; tapping it reveals "Add to Home Screen".
const ViewMoreGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
)
const BackGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
)
const FwdGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
)
const BookGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
)
const TabsGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="6" width="13" height="13" rx="2" /><rect x="8" y="3" width="13" height="13" rx="2" /></svg>
)

const Chip = ({ glyph, label }: { glyph: ReactNode; label: string }) => (
  <span className="ih-chip">{glyph}{label}</span>
)

// A mockup of Safari's BOTTOM bar with the Share button ringed (center) — matches what's on screen.
const SafariBottomBar = () => (
  <div className="ih-bar">
    <div className="ih-barlabel">Safari bottom bar</div>
    <div className="ih-toolbar">
      <span className="ih-ti"><BackGlyph /></span>
      <span className="ih-ti"><FwdGlyph /></span>
      <span className="ih-sp" />
      <span className="ih-target">
        <ShareGlyph />
        <span className="ih-ptr ih-ptr--below">Tap here</span>
      </span>
      <span className="ih-sp" />
      <span className="ih-ti"><BookGlyph /></span>
      <span className="ih-ti"><TabsGlyph /></span>
    </div>
  </div>
)

// A mockup of the browser TOP bar with a target control ringed (top-right). Used for Chrome-on-iOS
// (the Share button) and Android (the ⋮ menu).
const TopBar = ({ target, label }: { target: ReactNode; label: string }) => (
  <div className="ih-bar">
    <div className="ih-barlabel">{label}</div>
    <div className="ih-toolbar ih-toolbar--top">
      <span className="ih-ti"><BackGlyph /></span>
      <span className="ih-url">example.com</span>
      <span className="ih-target">
        {target}
        <span className="ih-ptr ih-ptr--above-r">Tap here</span>
      </span>
    </div>
  </div>
)

export type InstallKind = 'ios-safari' | 'ios-chrome' | 'android'

/**
 * The visual "how to install" body: numbered steps with the real glyph inline (in a chip) AND a mockup of the
 * actual browser bar with the target highlighted — so it's unmistakable what to press and where. iOS Safari has
 * Share at the BOTTOM; iOS Chrome puts it at the TOP-RIGHT; both then need the "View More" chevron in the share
 * sheet before "Add to Home Screen". Android uses the ⋮ menu.
 */
export function InstallSteps({ kind }: { kind: InstallKind }) {
  if (kind === 'android') {
    return (
      <div className="ih-body">
        <TopBar target={<MenuGlyph />} label="Browser top bar" />
        <ol className="ih-steps">
          <li>
            <span className="ih-n">1</span>
            <span>Tap the <Chip glyph={<MenuGlyph />} label="menu" /> — <b>top-right</b>.</span>
          </li>
          <li>
            <span className="ih-n">2</span>
            <span>Tap <Chip glyph={<InstallGlyph />} label="Install app" /> <span className="ih-dim">(or &ldquo;Add to Home screen&rdquo;)</span></span>
          </li>
        </ol>
      </div>
    )
  }

  // iOS — same 3 steps; only the Share button's location (and the bar mockup) differ by browser.
  const shareTop = kind === 'ios-chrome'
  const steps = (
    <ol className="ih-steps">
      <li>
        <span className="ih-n">1</span>
        <span>Tap <Chip glyph={<ShareGlyph />} label="Share" /> — it&rsquo;s at the <b>{shareTop ? 'top-right' : 'bottom of your screen'}</b>.</span>
      </li>
      <li>
        <span className="ih-n">2</span>
        <span>Tap <Chip glyph={<ViewMoreGlyph />} label="View More" /> <span className="ih-dim">(or scroll down)</span></span>
      </li>
      <li>
        <span className="ih-n">3</span>
        <span>Choose <Chip glyph={<AddHomeGlyph />} label="Add to Home Screen" /></span>
      </li>
    </ol>
  )
  // The bar mockup sits where the real bar is: Chrome's Share is up top, Safari's is at the bottom.
  return (
    <div className="ih-body">
      {shareTop && <TopBar target={<ShareGlyph />} label="Browser top bar" />}
      {steps}
      {!shareTop && <SafariBottomBar />}
    </div>
  )
}
