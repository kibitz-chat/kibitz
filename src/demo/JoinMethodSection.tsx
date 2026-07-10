import { type Dispatch, type SetStateAction } from 'react'
import { type HostTier } from './HostAdminSection'

export type RoomMethod = 'open' | 'verified' | 'declare'

// The "Who can join?" method selector + its declare / sign-in-app sub-fields, lifted from CreatePage.tsx. Picks
// open / verified / declare; the declare list (invited emails + allow-guests) and the Google sign-in client id show
// under the matching method. The verified ROSTER itself stays in the page (it leans on a renderRow helper).
// Purely presentational. cp-/cg- classes are global (the paper theme).
export function JoinMethodSection({
  method,
  setMethod,
  setErr,
  declareEmails,
  setDeclareEmails,
  allowGuest,
  setAllowGuest,
  clientId,
  setClientId,
  googleClientId,
  hostTier,
}: {
  method: RoomMethod
  setMethod: Dispatch<SetStateAction<RoomMethod>>
  setErr: Dispatch<SetStateAction<string | null>>
  declareEmails: string
  setDeclareEmails: Dispatch<SetStateAction<string>>
  allowGuest: boolean
  setAllowGuest: Dispatch<SetStateAction<boolean>>
  clientId: string
  setClientId: Dispatch<SetStateAction<string>>
  googleClientId: string | undefined
  hostTier: HostTier
}) {
  return (
    <>
      <p className="cp-q">Who can join?</p>
      <div className="cg-methods">
        {(['open', 'verified', 'declare'] as RoomMethod[]).map((id) => (
          <button
            type="button"
            key={id}
            className={`cg-chip${method === id ? ' on' : ''}`}
            aria-pressed={method === id}
            onClick={() => {
              setMethod(id)
              setErr(null)
            }}
          >
            {id === 'open' ? 'Anyone with the link' : id === 'verified' ? 'Verified participants' : 'Declare (unverified)'}
          </button>
        ))}
      </div>
      <p className="cg-blurb">
        {method === 'open'
          ? 'Whoever opens the link is in. The link itself is the key, so keep it private.'
          : method === 'declare'
            ? 'Open room — anyone with the link is in, but everyone picks who they are from your list (or “Guest”), shown UNVERIFIED. Each person can sign in to add a verified ✓.'
            : 'One link commits a roster; each participant (you included) verifies by their own method before entering. Only listed, verified participants get in — people or AI agents.'}
      </p>

      {method === 'declare' && (
        <div className="cp-declare">
          <label className="cp-label" htmlFor="cp-declare">
            Invited emails <span>(one per line — people pick who they are)</span>
          </label>
          <textarea
            id="cp-declare"
            className="cp-name"
            rows={4}
            value={declareEmails}
            onChange={(e) => setDeclareEmails(e.target.value)}
            placeholder={'alice@acme.com\nbob@acme.com'}
            autoCapitalize="off"
            spellCheck={false}
          />
          <label className="cp-declare-guest">
            <input type="checkbox" checked={allowGuest} onChange={(e) => setAllowGuest(e.target.checked)} /> Allow guests (adds a “Guest” option
            anyone can pick)
          </label>
          <p className="cg-fine">
            Unverified — picking a name proves nothing (anyone with the link can pick any one). It’s for “who’s who”, not
            access control; the verified&nbsp;✓ is the real proof.
          </p>
        </div>
      )}

      {method === 'verified' && !googleClientId && hostTier !== 'oidc' && (
        <div className="cp-signapp">
          <label className="cp-label" htmlFor="cp-cid">
            Sign-in app <span>(Google client id — paste once)</span>
          </label>
          <input
            id="cp-cid"
            className="cp-name"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="723848163510-…apps.googleusercontent.com"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <p className="cg-fine">
            Verification runs through Google sign-in. Paste your Google app’s client id — it’s public, rides safely in
            the link, and you only do this once.{' '}
            <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
              Get one →
            </a>
          </p>
        </div>
      )}

      {method === 'verified' && !googleClientId && hostTier === 'oidc' && (
        <p className="cg-fine">
          Verified participants sign in with the <strong>same Google client id</strong> you set for the host above —
          no need to enter it twice.
        </p>
      )}
    </>
  )
}
