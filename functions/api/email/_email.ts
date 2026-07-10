/**
 * Shared helpers for the email-code verification backend (Cloudflare Pages Functions). The
 * leading underscore keeps Pages from routing this file; it's bundled into start/verify/jwks.
 *
 * Email-code is "our own OIDC provider": /start mails a one-time code, /verify checks it and
 * mints an RS256 token the unchanged client verifier accepts (see src/core/emailToken.ts), and
 * /jwks publishes the key. SCAFFOLDED + DORMANT — every endpoint returns {configured:false}
 * until OTP_KV + EMAIL_SIGNING_JWK + at least ONE mailer key are bound (see functions/README.md).
 *
 * The crypto core (code lifecycle, token minting) AND the mailer strategy (free-tier rotation
 * across providers) are the SAME tested modules from src/core, not re-implemented here.
 */
import { bump, intEnv, peek, periodKey, verifyGrant, type KV } from '../_turn'
import { configuredMailers, sendWithRotation } from '../../../src/core/mailers'

export interface Env {
  /** KV namespace holding transient OTP records (auto-expiring). */
  OTP_KV?: KV
  /** The backend's RS256 PRIVATE signing key as a JWK string (secret). Generate with
   *  `node scripts/gen-email-key.mjs`. The public half is derived + served at /jwks. */
  EMAIL_SIGNING_JWK?: string
  /** Mailer API keys (secrets). Bind ANY ONE to go live; bind several and the FREE rotation
   *  falls through them as each free tier exhausts (see src/core/mailers.ts). Verify the sending
   *  domain (mail.kibitz.chat) in each provider's dashboard so its DKIM/SPF check passes. */
  RESEND_API_KEY?: string
  BREVO_API_KEY?: string
  MAILERSEND_API_KEY?: string
  /** From address — your verified domain, e.g. noreply@mail.kibitz.chat. */
  EMAIL_FROM?: string
  /** Token issuer + where /jwks is served, e.g. https://kibitz.chat. */
  EMAIL_ISSUER?: string
  /** Token audience (a fixed app id for this provider), e.g. kibitz-email. */
  EMAIL_AUDIENCE?: string
  /** Same secret as /api/turn — lets a sponsor room-grant (X-Kibitz-Grant) authorize the send,
   *  so ONE premium key covers a room's relay AND its verification emails. Unset → all unsponsored. */
  ROOM_GRANT_SECRET?: string
  /** Optional monthly cap on UNSPONSORED sends (a cost/abuse backstop). DORMANT unless set — when
   *  unset, free sends are unlimited (today's behaviour). When set, an over-cap unsponsored send is
   *  refused and the joiner is told to use a sponsored room link. Sponsored sends are never capped here. */
  MAIL_FREE_MAX?: string
}

export const CORS: Record<string, string> = {
  'access-control-allow-origin': '*', // no cookies/credentials; the token is returned in the body
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-kibitz-grant',
}

export const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS, ...extra } })

export const onRequestOptions = (): Response => new Response(null, { status: 204, headers: CORS })

/** Live once KV + the signing key + AT LEAST ONE mailer are bound. */
export const configured = (env: Env): boolean =>
  !!(env.OTP_KV && env.EMAIL_SIGNING_JWK && configuredMailers(env).length > 0)

export const issuerOf = (env: Env): string => (env.EMAIL_ISSUER || 'https://kibitz.chat').replace(/\/$/, '')
export const audienceOf = (env: Env): string => env.EMAIL_AUDIENCE || 'kibitz-email'
export const fromOf = (env: Env): string => env.EMAIL_FROM || 'noreply@mail.kibitz.chat'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
export const validEmail = (s: unknown): s is string => typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s)

/** A random ticket / KV key id. */
export function randomId(): string {
  const b = new Uint8Array(18)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * Best-effort per-key rate limit on KV (eventually consistent, so a soft guard, not a hard cap).
 * Returns false when `key` has been hit `max` times within `ttl` seconds.
 */
export async function rateOk(env: Env, key: string, max: number, ttl: number): Promise<boolean> {
  const kv = env.OTP_KV!
  const n = Number((await kv.get(`rl:${key}`, 'text')) ?? 0)
  if (n >= max) return false
  await kv.put(`rl:${key}`, String(n + 1), { expirationTtl: ttl })
  return true
}

/**
 * Mail the code, sending AS your verified domain. Uses the FREE-tier rotation (src/core/mailers):
 * tries each configured provider in order, falling through when one's quota is exhausted, so the
 * free tiers add up. Throws if EVERY provider failed, so the caller surfaces a generic failure
 * (never a provider's body).
 */
export async function sendCode(env: Env, to: string, code: string): Promise<void> {
  await sendWithRotation(
    env,
    {
      to,
      from: `Kibitz <${fromOf(env)}>`,
      subject: `Your Kibitz code: ${code}`,
      text: `Your Kibitz verification code is:\n\n    ${code}\n\nIt expires in 10 minutes. If you didn't request this, ignore this email.`,
    },
    configuredMailers(env),
  )
}

// ── Premium / opener-pays for mail ─────────────────────────────────────────────────────────────
// The SAME signed room-grant that sponsors a room's TURN (api/room-grant.ts → X-Kibitz-Grant) also
// authorizes its verification emails — one premium key, both costs, metered to the opener. Honoured
// only for the grant's OWN room. Unsponsored sends stay free; an optional MAIL_FREE_MAX backstops
// their cost/abuse but is DORMANT unless the operator sets it.

interface MailGrant {
  room: string
  sub: string // the sponsor's non-reversible tag (metering subject)
  exp?: number
}

/** The sponsor's tag if a valid room-grant for THIS room is presented, else null (unsponsored). */
export async function sponsorOf(env: Env, request: Request, room: string): Promise<string | null> {
  const tok = request.headers.get('x-kibitz-grant')
  if (!tok || !env.ROOM_GRANT_SECRET) return null
  const g = await verifyGrant<MailGrant>(env.ROOM_GRANT_SECRET, tok)
  return g && g.room === room && g.sub ? g.sub : null
}

/**
 * Free-tier backstop (DORMANT unless MAIL_FREE_MAX is set): refuse an UNSPONSORED send once the
 * month's free quota is hit, so unsponsored mail can't run up cost / be abused. Returns false to
 * deny. Sponsored sends bypass this entirely. No-op (always true) when the cap isn't configured.
 */
export async function mailQuotaOk(env: Env, sponsor: string | null): Promise<boolean> {
  if (sponsor || !env.MAIL_FREE_MAX || !env.OTP_KV) return true // sponsored, or capping not enabled
  const cap = intEnv(env.MAIL_FREE_MAX, 0)
  if (cap <= 0) return true
  return (await peek(env.OTP_KV, `mmeter:free:${periodKey()}`)) < cap
}

/** Count a successful send against the month — by sponsor tag if sponsored, else the free pool.
 *  Only meters when a cap is configured (otherwise it's pure cost with no reader). */
export async function meterSend(env: Env, sponsor: string | null): Promise<void> {
  if (!env.OTP_KV || !env.MAIL_FREE_MAX) return
  await bump(env.OTP_KV, sponsor ? `mmeter:r:${sponsor}:${periodKey()}` : `mmeter:free:${periodKey()}`)
}
