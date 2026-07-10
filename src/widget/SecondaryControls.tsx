import { type Dispatch, type SetStateAction } from 'react'
import { ShieldIcon, CheckIcon, LinkIcon, HostIcon } from './icons'
import type { HostLobby } from '../react/useLobby'

// The secondary control row in the call bar: verify, copy-invite, QR (on big surfaces), host-tools, and the
// claim-host buttons (password / soft-name / OIDC tiers). Purely presentational — all state + handlers live in
// the parent (Widget). Extracted from Widget.tsx (it was a render-time `const secondaryControls = ...` JSX var).
// kw-ic / kw-badge classes are global; keep them verbatim. The `!preview` gate stays at the call site.
export function SecondaryControls({
  hidePrivacyChrome,
  verifyOpen,
  setVerifyOpen,
  safetyAlarm,
  setChatOpen,
  copied,
  copyInvite,
  bigSurface,
  inviteOpen,
  toggleInvite,
  hostLobby,
  hostMenuOpen,
  setHostMenuOpen,
  roomHasHost,
  isVerifiedHost,
  hostKeyTier,
  claimOpen,
  setClaimOpen,
  softHostName,
  doClaimByName,
  oidcHostEmail,
}: {
  hidePrivacyChrome?: boolean
  verifyOpen: boolean
  setVerifyOpen: Dispatch<SetStateAction<boolean>>
  safetyAlarm: boolean
  setChatOpen: Dispatch<SetStateAction<boolean>>
  copied: boolean
  copyInvite: () => void | Promise<void>
  bigSurface: boolean
  inviteOpen: boolean
  toggleInvite: () => void
  hostLobby: HostLobby
  hostMenuOpen: boolean
  setHostMenuOpen: Dispatch<SetStateAction<boolean>>
  roomHasHost: boolean
  isVerifiedHost: boolean
  hostKeyTier: boolean
  claimOpen: boolean
  setClaimOpen: Dispatch<SetStateAction<boolean>>
  softHostName: string | undefined
  doClaimByName: () => void
  oidcHostEmail: string | undefined
}) {
  return (
    <>
      {/* Verify (safety-code) shield. Hidden for a less-technical brand (hidePrivacyChrome) — the call stays E2EE,
          this is just the optional verification UI. NOTE: this also hides the mid-call key-change alarm. */}
      {!hidePrivacyChrome && (
        <button
          className={`kw-ic${verifyOpen ? ' active' : ''}${safetyAlarm ? ' warn' : ''}`}
          onClick={() => {
            setVerifyOpen((o) => !o)
            setChatOpen(false)
          }}
          aria-label="Verify this call is private"
          title={
            safetyAlarm
              ? "A peer's security key changed — check the safety code"
              : 'Verify your call is private (safety code)'
          }
        >
          <ShieldIcon />
          {safetyAlarm && <span className="kw-badge kw-badge-knock kw-badge-sm">!</span>}
        </button>
      )}
      {/* Invite — ONE button (the old separate QR button is merged in). On big surfaces (fullscreen / the
          dedicated room window), where a QR is big enough to scan, it opens the invite panel: copy link,
          WhatsApp, share, AND the QR. On the cramped corner panel — no room for a scannable QR — it stays a
          one-tap copy, exactly as before. */}
      <button
        className={`kw-ic${copied || inviteOpen ? ' active' : ''}`}
        onClick={() => (bigSurface ? toggleInvite() : void copyInvite())}
        aria-label={bigSurface ? 'Invite others — copy the link or show a QR' : 'Copy invite link'}
        aria-expanded={bigSurface ? inviteOpen : undefined}
        title={
          bigSurface
            ? 'Invite others — copy the link or show a QR to scan'
            : copied
              ? 'Invite link copied!'
              : 'Copy the invite link — one tap'
        }
      >
        {!bigSurface && copied ? <CheckIcon /> : <LinkIcon />}
      </button>
      {/* Host tools — only the room authority. One icon opens the waiting-room + lock (+ verified
          gate) menu, so those controls aren't a permanent row in the bar. A badge flags anyone
          waiting to be let in. */}
      {hostLobby.canGate && (
        <button
          className={`kw-ic${hostMenuOpen ? ' active' : ''}`}
          onClick={() => setHostMenuOpen((o) => !o)}
          aria-label="Host tools"
          aria-expanded={hostMenuOpen}
          title="Host tools — waiting room, lock the room"
        >
          <HostIcon />
          {hostLobby.knocks.length > 0 && (
            <span className="kw-badge kw-badge-knock kw-badge-sm">{hostLobby.knocks.length}</span>
          )}
        </button>
      )}
      {/* Claim admin — the room committed a host and we haven't claimed it. PASSWORD tier opens a prompt;
          SOFT (name) tier claims in one tap (adopt the host name + re-announce). */}
      {roomHasHost && !isVerifiedHost && hostKeyTier && (
        <button
          className={`kw-ic${claimOpen ? ' active' : ''}`}
          onClick={() => setClaimOpen((o) => !o)}
          aria-label="Claim admin"
          aria-expanded={claimOpen}
          title="Claim admin — enter the host password"
        >
          🔑
        </button>
      )}
      {roomHasHost && !isVerifiedHost && !hostKeyTier && softHostName && (
        <button
          className="kw-ic"
          onClick={() => doClaimByName()}
          aria-label="I'm the host"
          title={`Claim host — join as “${softHostName}”`}
        >
          🪪
        </button>
      )}
      {/* OIDC tier: signing in IS claiming — the button opens the Verify panel where you sign in. Once
          your verified email matches, the authority marks you host (the effect above) and this hides. */}
      {roomHasHost && !isVerifiedHost && oidcHostEmail && (
        <button
          className="kw-ic"
          onClick={() => setVerifyOpen(true)}
          aria-label="Sign in to claim host"
          title={`Claim host — sign in as ${oidcHostEmail}`}
        >
          🔐
        </button>
      )}
    </>
  )
}
