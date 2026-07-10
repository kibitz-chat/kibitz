import { type Dispatch, type SetStateAction } from 'react'

export type HostTier = 'none' | 'name' | 'oidc' | 'password'

// The "Room admin (host)" section of the create-room page: pick a host tier (no admin / host-by-name / host-by-Google
// OIDC / host-password) and fill its fields. Lifted from CreatePage.tsx. clientId is shared with the create logic +
// the sign-in section, so it stays in the page and passes through here. Purely presentational over the host-tier form
// state. cp-/cg- classes are global (the paper theme).
export function HostAdminSection({
  hostTier,
  setHostTier,
  setErr,
  hostName,
  setHostName,
  hostLobbyStart,
  setHostLobbyStart,
  hostEmail,
  setHostEmail,
  clientId,
  setClientId,
  hostPassword,
  setHostPassword,
}: {
  hostTier: HostTier
  setHostTier: Dispatch<SetStateAction<HostTier>>
  setErr: Dispatch<SetStateAction<string | null>>
  hostName: string
  setHostName: Dispatch<SetStateAction<string>>
  hostLobbyStart: boolean
  setHostLobbyStart: Dispatch<SetStateAction<boolean>>
  hostEmail: string
  setHostEmail: Dispatch<SetStateAction<string>>
  clientId: string
  setClientId: Dispatch<SetStateAction<string>>
  hostPassword: string
  setHostPassword: Dispatch<SetStateAction<string>>
}) {
  return (
    <>
      <p className="cp-q">Room admin (host)?</p>
      <div className="cg-methods">
        {(['none', 'name', 'oidc', 'password'] as const).map((id) => (
          <button
            type="button"
            key={id}
            className={`cg-chip${hostTier === id ? ' on' : ''}`}
            aria-pressed={hostTier === id}
            onClick={() => {
              setHostTier(id)
              setErr(null)
            }}
          >
            {id === 'none' ? 'No admin' : id === 'name' ? 'Host by name' : id === 'oidc' ? 'Host by Google' : 'Host password'}
          </button>
        ))}
      </div>
      <p className="cg-blurb">
        {hostTier === 'none'
          ? 'No one can moderate — a fully open room.'
          : hostTier === 'name'
            ? 'You declare yourself host by name. Whoever joins under that name is the host (no password). Anyone with the link could claim it, so it’s for trust-friendly rooms — ideal for letting an AI agent in first, then admitting everyone.'
            : hostTier === 'oidc'
              ? 'You’re host by your verified Google email — sign in to claim admin. Can’t be spoofed, and works on any device (just sign in again). The room itself stays open; only admin is gated to your email. Needs a Google OAuth client id.'
              : 'A host password unlocks moderation and can’t be spoofed. Whoever knows it can claim admin from any seat. It rides the public link, so use a strong passphrase.'}
      </p>

      {hostTier === 'name' && (
        <>
          <label className="cp-label" htmlFor="cp-hostname">
            Your name <span>(as host)</span>
          </label>
          <input
            id="cp-hostname"
            className="cp-name"
            value={hostName}
            onChange={(e) => setHostName(e.target.value)}
            placeholder="e.g. Alex"
            autoCapitalize="words"
            spellCheck={false}
          />
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginTop: 10,
              fontSize: '0.95rem',
              color: 'var(--pdim)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={hostLobbyStart}
              onChange={(e) => setHostLobbyStart(e.target.checked)}
              style={{ width: 18, height: 18, flex: 'none' }}
            />
            <span>Start with a waiting room (admit the agent first, then everyone)</span>
          </label>
        </>
      )}

      {hostTier === 'oidc' && (
        <>
          <label className="cp-label" htmlFor="cp-hostemail">
            Your verified email <span>(host)</span>
          </label>
          <input
            id="cp-hostemail"
            className="cp-name"
            type="email"
            value={hostEmail}
            onChange={(e) => setHostEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <label className="cp-label" htmlFor="cp-hostcid">
            Google client id <span>(public — rides the link)</span>
          </label>
          <input
            id="cp-hostcid"
            className="cp-name"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="723848163510-…apps.googleusercontent.com"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <p className="cg-fine">
            You become host by signing in with Google as that exact email — <strong>un-spoofable</strong> and works on
            any device. The room stays open to everyone; only admin is gated to you. Needs a Google OAuth client id
            (it’s public).{' '}
            <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
              Get one →
            </a>
          </p>
        </>
      )}

      {hostTier === 'password' && (
        <>
          <label className="cp-label" htmlFor="cp-hostpw">
            Host password
          </label>
          <input
            id="cp-hostpw"
            className="cp-name"
            type="password"
            value={hostPassword}
            onChange={(e) => setHostPassword(e.target.value)}
            placeholder="a passphrase that claims admin (kick · lock · lobby)"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <p className="cg-fine">
            Whoever knows it can <strong>claim admin</strong> — admit/deny at the door, lock the room, remove someone,
            reset. It rides the public link, so a weak one can be guessed offline — use a strong{' '}
            <strong>passphrase</strong>.
          </p>
        </>
      )}
    </>
  )
}
