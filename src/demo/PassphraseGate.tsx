import { useEffect, useState } from 'react'
import { unlockGate } from '../core/joinGateRuntime'
import type { GateDescriptor } from '../core/joinGateLink'

/**
 * Pre-entry screen for a passphrase-LOCKED verified room (Layer 2). The roster is sealed in the
 * link (`encManifest`), so the host and anyone who merely has the link see only ciphertext. We ask
 * for the out-of-band group secret, decrypt locally (unlockGate), and hand the unlocked descriptor
 * (with the plaintext manifest) up so the normal verified-roster flow can run. Reuses the create
 * card's warm paper theme. Fails closed: a wrong secret never reveals the roster.
 */
export function PassphraseGate({
  descriptor,
  roomDesc,
  onUnlock,
  onCancel,
}: {
  descriptor: GateDescriptor
  roomDesc?: string
  onUnlock: (gate: GateDescriptor) => void
  onCancel: () => void
}) {
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    document.body.classList.add('paper')
    return () => document.body.classList.remove('paper')
  }, [])

  const submit = async () => {
    const p = pass.trim()
    if (!p || busy) return
    setBusy(true)
    setErr(null)
    const opened = await unlockGate(descriptor, p)
    if (opened?.manifest) onUnlock(opened)
    else {
      setErr('That secret didn’t unlock this room. Check it and try again.')
      setBusy(false)
    }
  }

  return (
    <main className="createpage">
      <div className="cp-card">
        <button type="button" className="cp-back" onClick={onCancel}>
          ← Back
        </button>
        <h1 className="cp-h">🔒 Locked room</h1>
        <p className="cg-blurb">
          {roomDesc ? (
            <>
              <strong>{roomDesc}</strong> is{' '}
            </>
          ) : (
            'This room is '
          )}
          protected by a shared secret. Enter the passphrase your group sent you — separately from the link — to unlock
          who’s invited and join.
        </p>
        <input
          className="cp-name"
          type="password"
          value={pass}
          onChange={(e) => {
            setPass(e.target.value)
            setErr(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          placeholder="shared passphrase"
          autoFocus
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Room passphrase"
        />
        <button type="button" className="cp-go" disabled={busy || !pass.trim()} onClick={() => void submit()}>
          {busy ? 'Unlocking…' : 'Unlock →'}
        </button>
        {err && <p className="cg-err">{err}</p>}
      </div>
    </main>
  )
}
