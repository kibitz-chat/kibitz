import { useEffect, useState } from 'react'
import { QrBox } from '../react/QrBox'
import { PeopleIcon, WhatsAppIcon, ShareIcon, LinkIcon, CheckIcon, QrIcon } from './icons'

// The in-call / pre-join "Scan to join" panel: a QR of the resolved room-invite link, plus send-the-link options
// (WhatsApp, the native share sheet, copy). Purely presentational — the parent (Widget) resolves the invite URL and
// owns the open/copied state; this just renders it. Uses the shadow-rooted panel's global kw-invite* classes — keep
// them verbatim (styles are injected, not CSS-modules).
export function InvitePanel({
  inviteUrl,
  copied,
  onClose,
  onCopy,
}: {
  inviteUrl: string
  copied: boolean
  onClose: () => void
  onCopy: () => void | Promise<void>
}) {
  // Feature-detect the OS share sheet (mobile + some desktop). Set in an effect so a prerender never diverges.
  const [canShare, setCanShare] = useState(false)
  useEffect(() => setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function'), [])
  // The QR is now just one share option among the others — hidden until asked for, not shown by default.
  const [showQr, setShowQr] = useState(false)

  const msg = 'Join my call:' // names the link that follows (WhatsApp/native put the URL right after)
  const waHref = `https://wa.me/?text=${encodeURIComponent(`${msg}\n${inviteUrl}`)}`
  const share = () => {
    void navigator.share?.({ title: 'Join my call', text: msg, url: inviteUrl }).catch(() => {})
  }

  return (
    <div className="kw-invitepanel">
      <div className="kw-invite-head">
        <span className="kw-invite-title">
          <PeopleIcon /> Invite others
        </span>
        <button className="kw-invite-x" onClick={onClose} aria-label="Close" title="Close">
          ✕
        </button>
      </div>
      {inviteUrl ? (
        <>
          <p className="kw-invite-hint">Send the link — or show a QR to scan:</p>
          <div className="kw-invite-share">
            <a className="kw-invite-copy wa" href={waHref} target="_blank" rel="noreferrer" title="Send on WhatsApp">
              <WhatsAppIcon /> WhatsApp
            </a>
            {canShare && (
              <button className="kw-invite-copy" onClick={share} title="Share the link">
                <ShareIcon /> Share…
              </button>
            )}
            <button className={`kw-invite-copy${copied ? ' done' : ''}`} onClick={() => void onCopy()} title="Copy the invite link">
              {copied ? (
                <>
                  <CheckIcon /> Copied
                </>
              ) : (
                <>
                  <LinkIcon /> Copy
                </>
              )}
            </button>
            <button className={`kw-invite-copy${showQr ? ' done' : ''}`} onClick={() => setShowQr((v) => !v)} aria-pressed={showQr} title="Show a QR code to scan">
              <QrIcon /> QR code
            </button>
          </div>
          {showQr && <QrBox text={inviteUrl} className="kw-invite-qr" />}
        </>
      ) : (
        <p className="kw-invite-hint">Preparing your invite…</p>
      )}
    </div>
  )
}
