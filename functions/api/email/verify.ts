/**
 * POST /api/email/verify — finish email-code verification.
 *
 * Body: { ticket, code }. Checks the code against the stored hash (constant-time, expiry +
 * attempt cap). On success, mints the RS256 token — email/room/nonce come from the SERVER record,
 * never the client, so the caller can't swap identity at this step — deletes the one-time record,
 * and returns { ok:true, jwt }. The client then presents that jwt exactly like a Google token.
 */
import { checkOtp, type OtpRecord } from '../../../src/core/emailOtp'
import { importSigningKey, signEmailToken } from '../../../src/core/emailToken'
import { audienceOf, configured, issuerOf, json, onRequestOptions, type Env } from './_email'

export { onRequestOptions }

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context
  if (!configured(env)) return json({ configured: false })

  let body: { ticket?: unknown; code?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, reason: 'bad request' }, 400)
  }
  const ticket = String(body.ticket ?? '').trim()
  const code = String(body.code ?? '').trim()
  if (!/^[0-9a-f]{8,80}$/.test(ticket)) return json({ ok: false, reason: 'bad ticket' }, 400)
  if (!/^\d{4,8}$/.test(code)) return json({ ok: false, reason: 'mismatch' }, 401)

  const key = `otp:${ticket}`
  const rec = (await env.OTP_KV!.get(key, 'json')) as OtpRecord | null
  if (!rec) return json({ ok: false, reason: 'expired' }, 401)

  const now = Math.floor(Date.now() / 1000)
  const r = await checkOtp(code, rec, now)
  if (!r.ok) {
    if (r.reason === 'mismatch') {
      // Count the wrong guess; the cap (checked in checkOtp) then locks further tries. KV's
      // minimum expirationTtl is 60s — the record's own `exp` is what actually bounds validity.
      await env.OTP_KV!.put(key, JSON.stringify({ ...rec, attempts: rec.attempts + 1 }), {
        expirationTtl: Math.max(60, rec.exp - now),
      })
    }
    return json({ ok: false, reason: r.reason }, 401)
  }

  // Correct code → one-time use: delete the record, then mint the token.
  await env.OTP_KV!.delete(key)
  let jwt: string
  try {
    const priv = JSON.parse(env.EMAIL_SIGNING_JWK!) as JsonWebKey
    const { key: signingKey, kid } = await importSigningKey(priv)
    jwt = await signEmailToken(
      signingKey,
      {
        iss: issuerOf(env),
        aud: audienceOf(env),
        email: rec.email,
        nonce: rec.nonce, // cert binding — from the start record, not the client
        sub: rec.email,
        iat: now,
        exp: now + 600,
      },
      kid,
    )
  } catch {
    return json({ ok: false, reason: 'signing unavailable' }, 500)
  }
  return json({ ok: true, jwt })
}
