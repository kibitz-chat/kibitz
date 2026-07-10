import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { googleProvider } from '../core/googleSignin'
import { emailCodeProvider } from '../core/emailProvider'
import { brand } from '../brand'

// The cross-origin verify popup. The extension's side panel is a chrome-extension:// page, where
// Google's GIS button and our /api/email backend can't run (both need a registered https origin).
// So the panel opens THIS page on the kibitz.chat https origin, passing the engine's cert-bound
// `nonce`. We run the SAME sign-in providers here, then postMessage the resulting cert-bound token
// back to the opener, which injects it via the engine's `provideIdentityToken`. The cert-binding
// scheme is built for exactly this: the signer and the verifier needn't be one page — the nonce
// ties the token to the OPENER's connection, re-checked peer-to-peer (docs/cert-binding.md).
//
// Reached via `https://kibitz.chat/?kibitzVerify=1&nonce=…&client=…&room=…&methods=google,email&opener=…`.

type Method = 'google' | 'email'
const isMethod = (s: string): s is Method => s === 'google' || s === 'email'
// This popup exists ONLY for the extension (a chrome-extension:// page that can't run GIS / our
// backend). The token carries a verified email, so we post it back ONLY to a chrome-extension
// origin — never an arbitrary https opener, which a phishing page could supply to harvest it.
const okOrigin = (o: string): boolean => /^chrome-extension:\/\/[a-z]{32}$/.test(o)

export function VerifyPopup() {
  const params = new URLSearchParams(location.search)
  const nonce = params.get('nonce') ?? ''
  const clientId = (params.get('client') ?? '').trim()
  const room = (params.get('room') ?? '').trim()
  const opener = params.get('opener') ?? ''
  const grant = params.get('grant') ?? undefined // opener-pays: bills an email send to the room's key
  const methods = (params.get('methods') ?? 'google').split(',').map((s) => s.trim()).filter(isMethod)
  const desc = (params.get('d') ?? '').slice(0, 80)

  const [stage, setStage] = useState<'pick' | Method>(methods.length === 1 ? methods[0] : 'pick')
  const [status, setStatus] = useState('')
  const slot = useRef<HTMLDivElement>(null)
  const sent = useRef(false)

  const send = (jwt: string) => {
    if (sent.current) return
    sent.current = true
    if (window.opener && okOrigin(opener)) {
      try {
        window.opener.postMessage({ kibitzVerify: true, jwt }, opener)
      } catch {
        /* opener gone — fall through to the manual note */
      }
    }
    setStatus(`Verified ✓ — returning to ${brand.name}…`)
    setTimeout(() => window.close(), 500)
  }

  // Render the chosen provider's sign-in into the slot. Re-runs if the user switches method.
  useEffect(() => {
    if (stage === 'pick' || !slot.current) return
    if (!nonce) {
      setStatus('This verify link is missing its security nonce — reopen it from the panel.')
      return
    }
    if (stage === 'google' && !clientId) {
      setStatus('This room has no sign-in app configured for Google.')
      return
    }
    const provider = stage === 'email' ? emailCodeProvider({ room, grant }) : googleProvider(clientId)
    let alive = true
    slot.current.innerHTML = ''
    provider
      .signIn({ nonce, container: slot.current })
      .then((res) => {
        if (alive && res?.jwt) send(res.jwt)
      })
      .catch(() => {
        if (alive) setStatus('Sign-in failed — close this window and try again.')
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage])

  const wrap: CSSProperties = {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0b241c',
    color: '#e7f3ec',
    font: "15px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    padding: 20,
  }
  const card: CSSProperties = {
    width: '100%',
    maxWidth: 360,
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 14,
    padding: 22,
  }
  const btn: CSSProperties = {
    display: 'block',
    width: '100%',
    margin: '8px 0',
    padding: '11px 14px',
    fontSize: 15,
    fontWeight: 600,
    color: '#fff',
    background: '#18794e',
    border: 0,
    borderRadius: 10,
    cursor: 'pointer',
  }

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontWeight: 800, color: '#8fd3b0', marginBottom: 4 }}>Kibitz — verify to join</div>
        <p style={{ margin: '0 0 16px', color: '#9fc4b3', fontSize: 13 }}>
          Prove who you are for{' '}
          <strong style={{ color: '#cfe6da' }}>{desc || (room ? `room ${room}` : 'this room')}</strong>. Your
          verification is bound to your call’s encrypted connection and checked by the other people directly — no
          server vouches for you.
        </p>

        {stage === 'pick' ? (
          <>
            {methods.includes('google') && (
              <button style={btn} onClick={() => setStage('google')}>
                Continue with Google
              </button>
            )}
            {methods.includes('email') && (
              <button style={{ ...btn, background: 'rgba(255,255,255,0.1)' }} onClick={() => setStage('email')}>
                ✉️ Verify by email code
              </button>
            )}
          </>
        ) : (
          <>
            <div ref={slot} style={{ minHeight: 44 }} />
            {methods.length > 1 && !sent.current && (
              <button
                style={{ ...btn, background: 'transparent', color: '#8fd3b0', marginTop: 12 }}
                onClick={() => setStage('pick')}
              >
                ← Use another method
              </button>
            )}
          </>
        )}

        <p style={{ margin: '14px 0 0', minHeight: 18, fontSize: 13, color: '#8fd3b0' }}>{status}</p>
      </div>
    </div>
  )
}
