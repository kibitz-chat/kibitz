// Client side of the email-code method: an IdentityProvider whose sign-in renders a tiny two-step
// form (email → code), talks to /api/email/start + /api/email/verify, and resolves with the signed
// token — which slots into the SAME identity machinery as Google (broadcast + verifyPeerMulti).
// The cert-binding `nonce` is passed straight through to /start, so the issued token is bound to
// this connection exactly like an OIDC one. No DOM framework — plain elements into the container.

import type { IdentityProvider } from './identity'

interface StartResult {
  ok?: boolean
  configured?: boolean
  ticket?: string
  reason?: string
}
interface VerifyResult {
  ok?: boolean
  jwt?: string
  reason?: string
}

const postJson = async <T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return (await r.json()) as T
}

/** POST /api/email/start — mail a code; returns a ticket. A sponsor room-grant (`grant`) rides as
 *  `X-Kibitz-Grant`, so the SAME premium key that pays for the room's relay pays for this send. */
export function startEmailVerify(
  base: string,
  body: { email: string; room: string; nonce: string },
  grant?: string,
): Promise<StartResult> {
  return postJson<StartResult>(`${base}/api/email/start`, body, grant ? { 'x-kibitz-grant': grant } : {}).catch(() => ({
    ok: false,
    reason: 'network',
  }))
}
/** POST /api/email/verify — exchange a code for the signed token. */
export function submitEmailCode(base: string, body: { ticket: string; code: string }): Promise<VerifyResult> {
  return postJson<VerifyResult>(`${base}/api/email/verify`, body).catch(() => ({ ok: false, reason: 'network' }))
}

export interface EmailProviderConfig {
  /** Backend base URL (default '' = same origin → /api/email/*). */
  baseUrl?: string
  /** Room id for OTP scoping (the normalized room — matches the nonce's salt). */
  room: string
  /** Optional sponsor room-grant (opener-pays) — sent to /start so the send is billed to the
   *  room's premium key instead of the free pool. Usually `getGrant()` from the adopted link. */
  grant?: string
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  n.className = cls
  if (text) n.textContent = text
  return n
}

/** An IdentityProvider that verifies an email by a mailed code (our own backend). */
export function emailCodeProvider(cfg: EmailProviderConfig): IdentityProvider {
  const base = (cfg.baseUrl ?? '').replace(/\/$/, '')
  return {
    signIn: ({ nonce, container }) =>
      new Promise((resolve) => {
        container.innerHTML = ''
        const form = el('div', 'kw-email')
        const msg = el('div', 'kw-email-msg')
        const emailInput = el('input', 'kw-email-in')
        emailInput.type = 'email'
        emailInput.placeholder = 'you@example.com'
        emailInput.autocomplete = 'email'
        const sendBtn = el('button', 'kw-email-btn', 'Email me a code')
        const codeInput = el('input', 'kw-email-in')
        codeInput.type = 'text'
        codeInput.inputMode = 'numeric'
        codeInput.placeholder = '6-digit code'
        codeInput.style.display = 'none'
        const verifyBtn = el('button', 'kw-email-btn', 'Verify')
        verifyBtn.style.display = 'none'

        let ticket = ''
        let busy = false
        const setMsg = (t: string) => {
          msg.textContent = t
        }

        const send = async () => {
          const email = emailInput.value.trim().toLowerCase()
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || busy) return setMsg('Enter a valid email.')
          busy = true
          setMsg('Sending…')
          const r = await startEmailVerify(base, { email, room: cfg.room, nonce }, cfg.grant)
          busy = false
          if (r.configured === false) return setMsg('Email verification isn’t set up for this site.')
          if (!r.ok || !r.ticket) return setMsg(r.reason === 'too many requests' ? 'Too many requests — wait a bit.' : 'Couldn’t send the code.')
          ticket = r.ticket
          setMsg(`Code sent to ${email}. Check your inbox.`)
          emailInput.disabled = true
          sendBtn.style.display = 'none'
          codeInput.style.display = ''
          verifyBtn.style.display = ''
          codeInput.focus()
        }
        const verify = async () => {
          const code = codeInput.value.trim()
          if (!/^\d{4,8}$/.test(code) || busy) return setMsg('Enter the code from the email.')
          busy = true
          setMsg('Verifying…')
          const r = await submitEmailCode(base, { ticket, code })
          busy = false
          if (r.ok && r.jwt) {
            setMsg('Verified ✓')
            resolve({ jwt: r.jwt })
            return
          }
          setMsg(r.reason === 'locked' ? 'Too many tries — request a new code.' : r.reason === 'expired' ? 'That code expired — request a new one.' : 'Wrong code, try again.')
        }

        sendBtn.onclick = send
        verifyBtn.onclick = verify
        emailInput.onkeydown = (e) => e.key === 'Enter' && send()
        codeInput.onkeydown = (e) => e.key === 'Enter' && verify()

        form.append(emailInput, sendBtn, codeInput, verifyBtn, msg)
        container.append(form)
      }),
  }
}
