import { ShieldIcon } from './icons'
import { EmojiAvatar } from '../react/CallSurface'
import { readClaim } from '../core/claim'
import type { VerifiedIdentity } from '../core/identity'
import type { CallParticipant } from '../react/useCall'
import type { PeerSafety } from '../react/safety'
import type { IdentityMap } from '../react/useIdentity'

// The in-call "Verify your call is private" panel: the safety-code emoji ritual + per-peer identity rows (a ✓ for
// Google-verified peers, the emoji compare for the rest). Purely presentational — it reads safety/identity state
// and calls verify/unverify; the parent (Widget) owns all of it. Extracted from Widget.tsx. The kw-verify* /
// kw-id-* classes are global (shadow-rooted), so keep them verbatim.
export function VerifyPanel({
  identityEnabled,
  selfIdentity,
  verifyPeers,
  safety,
  identities,
  verify,
  unverify,
  mountSignin,
}: {
  identityEnabled: boolean
  selfIdentity: VerifiedIdentity | null
  verifyPeers: readonly CallParticipant[]
  safety: Record<string, PeerSafety>
  identities: IdentityMap
  verify: (id: string) => void
  unverify: (id: string) => void
  mountSignin: (el: HTMLDivElement | null) => void
}) {
  return (
    <div className="kw-verify">
      <div className="kw-verify-head">
        <ShieldIcon /> Verify your call is private
      </div>
      <p className="kw-verify-intro">
        {identityEnabled
          ? 'A ✓ with someone’s email means Google confirmed who they are AND that no one is in the middle — nothing more to do for them. For anyone who hasn’t signed in, compare the emoji aloud: if they match on both screens, your call is private.'
          : 'Read these emoji aloud to each other. If they match on both screens, your video and voice are end-to-end encrypted directly between you — no one is listening in the middle.'}
      </p>
      <p className="kw-verify-scope">
        This code verifies the <strong>media</strong> connection (your video and voice). Per-message
        verification of the data channel (chat, co-browse) is a planned follow-up.
      </p>
      {identityEnabled &&
        (selfIdentity ? (
          <p className="kw-verify-self">
            <span className="kw-id-check" aria-hidden="true">
              ✓
            </span>{' '}
            You're verified as <strong>{selfIdentity.email}</strong>
          </p>
        ) : (
          <div className="kw-verify-signin">
            <div ref={mountSignin} className="kw-id-gbtn" />
            <p className="kw-id-hint">Sign in to prove who you are — others see a verified ✓.</p>
          </div>
        ))}
      {verifyPeers.length === 0 ? (
        <p className="kw-verify-empty">No one else is here yet — the code appears once someone joins.</p>
      ) : (
        verifyPeers.map((p) => {
          const s = safety[p.id]
          const vid = identities[p.id]
          const claim = vid ? null : readClaim(p.meta) // an unverified claim — shown only without a ✓ (proof wins)
          return (
            <div
              key={p.id}
              className={`kw-verify-row${vid ? ' idok' : s?.changed ? ' changed' : s?.verified ? ' ok' : ''}`}
            >
              <div className="kw-verify-who">
                <span aria-hidden="true"><EmojiAvatar value={p.avatar || '🙂'} /></span> {p.name}
                {/* The emoji "✓ verified" tag is only meaningful when we're showing the
                    emoji — a verified IDENTITY makes its own (stronger) statement below. */}
                {!vid && s?.verified && !s.changed && (
                  <span className="kw-verify-tag" title="You confirmed this person's code">
                    ✓ verified
                  </span>
                )}
              </div>
              {vid ? (
                // Identity verified → the strong, combined guarantee. The binding can't
                // succeed through a man-in-the-middle, so the emoji ritual is redundant
                // and we drop it entirely for this person.
                <>
                  <p className="kw-verify-id ok">
                    <span aria-hidden="true">✓</span> Verified as <strong>{vid.email}</strong>
                  </p>
                  <p className="kw-verify-idsub">
                    Google confirmed who they are, and it's bound to this encrypted connection — so no
                    one is in the middle. No need to compare emoji for them.
                  </p>
                </>
              ) : (
                // Not identity-verified → the emoji ritual is the man-in-the-middle check.
                <>
                  {identityEnabled && (
                    <p className="kw-verify-id">
                      Identity not proven (they haven't signed in) — compare the emoji to be sure:
                    </p>
                  )}
                  {claim?.kind === 'email' && (
                    <p className="kw-verify-claim">
                      Claims to be <strong>{claim.email}</strong> — <em>not verified</em>. Anyone with the link can pick any name; signing in is the
                      only proof.
                    </p>
                  )}
                  {s?.changed && (
                    <p className="kw-verify-warn">
                      ⚠️ This person's security key is different from the one you verified before. It may be a
                      new device — or someone impersonating them. Re-read the emoji with them before you trust
                      the call again.
                    </p>
                  )}
                  {s?.code ? (
                    <>
                      <div className="kw-verify-code">{s.code}</div>
                      {s.verified && !s.changed ? (
                        <button className="kw-verify-btn ok" onClick={() => unverify(p.id)}>
                          Verified — tap to clear
                        </button>
                      ) : (
                        <button className="kw-verify-btn" onClick={() => verify(p.id)}>
                          They match — mark verified
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="kw-verify-pending">Establishing a direct secure link…</div>
                  )}
                </>
              )}
            </div>
          )
        })
      )}
      <p className="kw-verify-fine">
        These emoji verify the live video &amp; voice. Chat, links and co-browse also travel directly
        between browsers (encrypted in transit, no one in the middle relaying them).
      </p>
    </div>
  )
}
