// Transactional mailer strategy for the email-code verification backend.
//
// Cloudflare Workers can't open SMTP, so every provider here is an HTTP send API. The FREE path
// is a ROTATION: try each configured provider in order, falling through when one fails (quota
// exhausted / transient error), so the free tiers of several providers ADD UP instead of any one
// cap killing the feature. A provider joins the rotation only when its API key is bound — set
// one or several. The seam is provider-agnostic: a future sponsor/premium path can reorder the
// list (paid provider first, metered to a grant) without touching the call sites.
//
// Pure + injectable (providers are data; `sendWithRotation` takes the list) so the rotation logic
// is unit-tested with fakes — no real network. The provider `send`s use `fetch`, available in both
// the Workers runtime and the vitest node env.

/** Just the mailer-relevant slice of the backend Env — structural, so the Pages `Env` satisfies it. */
export interface MailerEnv {
  RESEND_API_KEY?: string
  BREVO_API_KEY?: string
  MAILERSEND_API_KEY?: string
}

export interface MailMessage {
  to: string
  /** `Name <email@domain>` or a bare `email@domain`. */
  from: string
  subject: string
  text: string
}

export interface Provider {
  name: string
  isConfigured(env: MailerEnv): boolean
  /** Send the message; THROW on any non-success so the rotation falls through to the next. */
  send(env: MailerEnv, msg: MailMessage): Promise<void>
}

/** Parse a `Name <email>` (or bare `email`) From into a structured sender (Brevo/MailerSend want it). */
export function parseFrom(from: string): { name: string; email: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from)
  if (m) return { name: m[1] || '', email: m[2].trim() }
  return { name: '', email: from.trim() }
}

export const resendProvider: Provider = {
  name: 'resend',
  isConfigured: (env) => !!env.RESEND_API_KEY,
  async send(env, msg) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: msg.from, to: [msg.to], subject: msg.subject, text: msg.text }),
    })
    if (!res.ok) throw new Error(`resend ${res.status}`)
  },
}

export const brevoProvider: Provider = {
  name: 'brevo',
  isConfigured: (env) => !!env.BREVO_API_KEY,
  async send(env, msg) {
    const s = parseFrom(msg.from)
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'api-key': env.BREVO_API_KEY! },
      body: JSON.stringify({
        sender: { email: s.email, ...(s.name ? { name: s.name } : {}) },
        to: [{ email: msg.to }],
        subject: msg.subject,
        textContent: msg.text,
      }),
    })
    if (!res.ok) throw new Error(`brevo ${res.status}`)
  },
}

export const mailersendProvider: Provider = {
  name: 'mailersend',
  isConfigured: (env) => !!env.MAILERSEND_API_KEY,
  async send(env, msg) {
    const s = parseFrom(msg.from)
    const res = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.MAILERSEND_API_KEY}` },
      body: JSON.stringify({
        from: { email: s.email, ...(s.name ? { name: s.name } : {}) },
        to: [{ email: msg.to }],
        subject: msg.subject,
        text: msg.text,
      }),
    })
    if (!res.ok) throw new Error(`mailersend ${res.status}`)
  },
}

/** Default rotation order: Resend first (best free-tier deliverability), then fallbacks once a
 *  daily/monthly cap is hit. Only the ones with a key bound are actually used. */
export const PROVIDERS: Provider[] = [resendProvider, brevoProvider, mailersendProvider]

/** The configured providers, in rotation order. */
export function configuredMailers(env: MailerEnv, providers: Provider[] = PROVIDERS): Provider[] {
  return providers.filter((p) => p.isConfigured(env))
}

/**
 * Try each provider in order; resolve with the NAME of the first that succeeds. Throws only if
 * EVERY provider failed — so a single exhausted/erroring provider just falls through to the next.
 */
export async function sendWithRotation(env: MailerEnv, msg: MailMessage, providers: Provider[]): Promise<string> {
  if (!providers.length) throw new Error('no mailer configured')
  let lastErr: unknown
  for (const p of providers) {
    try {
      await p.send(env, msg)
      return p.name
    } catch (e) {
      lastErr = e // quota / transient — fall through
    }
  }
  throw new Error(`all ${providers.length} mailer(s) failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
}
