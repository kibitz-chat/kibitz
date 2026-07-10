/**
 * POST /api/email/start — begin email-code verification.
 *
 * Body: { email, room, nonce }  (nonce = the cert-binding nonce the client computed:
 *        hash(its DTLS fingerprint, room) — embedded in the eventual token, so the code can't be
 *        verified for a different connection).
 * Mails a 6-digit code, stores ONLY its hash in KV under a random ticket, and returns the ticket.
 * Returns { configured:false } until the backend bindings exist (see _email.ts).
 */
import { hashOtp, newOtpCode, newSalt, OTP_TTL_SEC, type OtpRecord } from '../../../src/core/emailOtp'
import {
  configured,
  json,
  mailQuotaOk,
  meterSend,
  onRequestOptions,
  randomId,
  rateOk,
  sendCode,
  sponsorOf,
  validEmail,
  type Env,
} from './_email'

export { onRequestOptions }

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context
  if (!configured(env)) return json({ configured: false })

  let body: { email?: unknown; room?: unknown; nonce?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, reason: 'bad request' }, 400)
  }
  const email = String(body.email ?? '').trim().toLowerCase()
  const room = String(body.room ?? '').trim()
  const nonce = String(body.nonce ?? '').trim()
  if (!validEmail(email)) return json({ ok: false, reason: 'invalid email' }, 400)
  if (!room || room.length > 200) return json({ ok: false, reason: 'invalid room' }, 400)
  if (!nonce || nonce.length > 200) return json({ ok: false, reason: 'invalid nonce' }, 400)

  // Soft rate limits: per email+room, and per client IP — so the codes can't be used to spam an
  // inbox or to fan out mail through us.
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const emailHash = (await hashOtp(email, room)).slice(0, 24)
  if (!(await rateOk(env, `e:${emailHash}`, 5, OTP_TTL_SEC))) return json({ ok: false, reason: 'too many requests' }, 429)
  if (!(await rateOk(env, `ip:${ip}`, 20, OTP_TTL_SEC))) return json({ ok: false, reason: 'too many requests' }, 429)

  // Premium / opener-pays: a sponsor room-grant (the SAME one that pays for TURN) covers this send.
  // Unsponsored sends are free, but bounded by the DORMANT MAIL_FREE_MAX backstop when the operator
  // enables it — then an over-quota free send is refused and the joiner is pointed at a sponsored link.
  const sponsor = await sponsorOf(env, request, room)
  if (!(await mailQuotaOk(env, sponsor)))
    return json({ ok: false, reason: 'email verification is at capacity — ask the room owner for a sponsored link' }, 429)

  const code = newOtpCode()
  const salt = newSalt()
  const ticket = randomId()
  const now = Math.floor(Date.now() / 1000)
  const record: OtpRecord = {
    codeHash: await hashOtp(code, salt),
    salt,
    email,
    room,
    nonce,
    exp: now + OTP_TTL_SEC,
    attempts: 0,
  }
  await env.OTP_KV!.put(`otp:${ticket}`, JSON.stringify(record), { expirationTtl: OTP_TTL_SEC })

  try {
    await sendCode(env, email, code)
  } catch {
    return json({ ok: false, reason: 'could not send the code' }, 502)
  }
  await meterSend(env, sponsor) // count it against the sponsor's quota (or the free pool)
  return json({ ok: true, ticket })
}
