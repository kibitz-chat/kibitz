import { useEffect, useState } from 'react'
import type { GateDescriptor } from '../core/joinGateLink'
import type { Invitee } from '../core/roomManifest'

// Shown BEFORE entering a verified-roster room (docs/verification.md §7): a joiner presses the
// link and first sees the PUBLISHED ROSTER — who's invited and how each person verifies — picks
// which one they are, and approves to proceed (then verifies for real). The roster is read from
// the SIGNED manifest in the link (tamper-proof: verified against the creator's public key, also
// in the link). Heavy crypto is lazy-imported so this stays out of any prerender graph.

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; invitees: Invitee[] }
  | { kind: 'bad'; reason: string }

const badge = (m: Invitee['method']) => (m === 'mail' ? '✉️ Email code' : '🪪 Google sign-in')
const shownParam = (p: Invitee): string | null => (p.show ? (p.id ?? (p.domain ? `@${p.domain}` : null)) : null)

export function RoomPreview({
  descriptor,
  roomKey,
  roomDesc,
  onEnter,
  onCancel,
}: {
  descriptor: GateDescriptor
  roomKey: string
  roomDesc?: string
  onEnter: () => void
  onCancel: () => void
}) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [meIdx, setMeIdx] = useState<number | null>(null)

  // Match the landing's warm paper theme (palette vars live under body.paper).
  useEffect(() => {
    document.body.classList.add('paper')
    return () => document.body.classList.remove('paper')
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [{ importInvitePublicKey }, { verifyManifest }] = await Promise.all([
          import('../core/inviteToken'),
          import('../core/roomManifest'),
        ])
        if (!descriptor.manifest || !descriptor.pubKey) {
          if (alive) setState({ kind: 'bad', reason: 'no roster in this link' })
          return
        }
        const pub = await importInvitePublicKey(descriptor.pubKey)
        const mv = await verifyManifest(descriptor.manifest, pub, { room: roomKey, now: Math.floor(Date.now() / 1000), mode: 'google' })
        if (!alive) return
        if (!mv.ok) {
          setState({ kind: 'bad', reason: mv.reason })
          return
        }
        // Prefer the published per-invitee roster; fall back to bare emails (all sign-in).
        const invitees: Invitee[] =
          mv.manifest.invitees && mv.manifest.invitees.length > 0
            ? mv.manifest.invitees
            : [
                ...mv.manifest.members.map((id) => ({ method: 'signin' as const, id })),
                ...(mv.manifest.domains ?? []).map((domain) => ({ method: 'oidc' as const, domain })),
              ]
        setState({ kind: 'ok', invitees })
      } catch {
        if (alive) setState({ kind: 'bad', reason: 'could not read the roster' })
      }
    })()
    return () => {
      alive = false
    }
  }, [descriptor, roomKey])

  const me = state.kind === 'ok' && meIdx != null ? state.invitees[meIdx] : null

  return (
    <main className="createpage">
      <div className="cp-card">
        <button type="button" className="cp-back" onClick={onCancel}>
          ← Back
        </button>
        <h1 className="cp-h">Who’s in this room</h1>
        {roomDesc && <p className="rp-desc">“{roomDesc}”</p>}
        <p className="rp-sub">
          This is a <strong>verified room</strong>. Everyone must prove a listed identity before entering — pick which
          one is you, then continue to verify.
        </p>

        {state.kind === 'loading' && <p className="rp-load">Reading the roster…</p>}

        {state.kind === 'bad' && (
          <div className="rp-bad">
            <p>
              This link’s roster didn’t check out (<code>{state.reason}</code>). It may be tampered, expired, or for a
              different room — don’t trust it.
            </p>
          </div>
        )}

        {state.kind === 'ok' && (
          <>
            <ul className="rp-list">
              {state.invitees.map((p, i) => {
                const param = shownParam(p)
                const sub = p.method === 'oidc' && p.domain && !param ? 'a verified address' : param
                return (
                  <li key={i}>
                    <button
                      type="button"
                      className={`rp-row rp-pick${meIdx === i ? ' on' : ''}`}
                      aria-pressed={meIdx === i}
                      onClick={() => setMeIdx(i)}
                    >
                      <span className="rp-who">
                        <span className="rp-name">{p.name || param || (p.method === 'oidc' ? `Anyone @${p.domain}` : 'A verified person')}</span>
                        {sub && p.name && <span className="rp-email">{sub}</span>}
                      </span>
                      <span className="rp-method">{badge(p.method)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>

            <button type="button" className="cp-go" onClick={onEnter}>
              {me ? `Continue as ${me.name || shownParam(me) || 'this person'} →` : 'I’m one of these — continue →'}
            </button>
            <p className="cg-fine">
              You’ll verify next — sign in with Google, or enter a code we email you, depending on how you’re listed.
              Content stays blocked until you and everyone present has proven a listed identity.
            </p>
          </>
        )}
      </div>
    </main>
  )
}
