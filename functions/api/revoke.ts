/**
 * Cloudflare Pages Function — POST /api/revoke   { "identifier": "<tag>" }
 *
 * Kill switch. Every gated credential is minted with a `customIdentifier` (the
 * metering tag — a license key's hash, or `r:<sponsor>` for a room). This revokes
 * all live credentials under that tag via Cloudflare's TURN API, so a leaked or
 * abusive key/room stops relaying NOW instead of waiting out the TTL.
 *
 * Auth: `Authorization: Bearer <ADMIN_SECRET>` (an operator-only secret).
 *
 * SCAFFOLDED, DORMANT: returns {configured:false} until TURN_KEY_ID,
 * TURN_KEY_API_TOKEN, and ADMIN_SECRET are all set.
 *
 * ⚠️ VERIFY THE ENDPOINT before relying on this: Cloudflare's revoke-by-identifier
 * path is set in REVOKE_PATH below — confirm it against current Realtime TURN docs
 * (the generate path is stable; the revoke path should be double-checked).
 */
import { timingSafeEqual } from './_turn'

interface Env {
  TURN_KEY_ID?: string
  TURN_KEY_API_TOKEN?: string
  ADMIN_SECRET?: string
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

// ⚠️ Confirm against Cloudflare Realtime TURN docs before going live.
const REVOKE_PATH = (keyId: string, id: string) =>
  `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/${encodeURIComponent(id)}/revoke`

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN || !env.ADMIN_SECRET) return json({ configured: false })

  const auth = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!timingSafeEqual(auth, env.ADMIN_SECRET)) return json({ error: 'unauthorized' }, 401)

  let identifier = ''
  try {
    identifier = String(((await request.json()) as { identifier?: unknown })?.identifier ?? '').trim()
  } catch {
    /* no/!json body */
  }
  if (!identifier) return json({ error: 'missing identifier' }, 400)

  const res = await fetch(REVOKE_PATH(env.TURN_KEY_ID, identifier), {
    method: 'POST',
    headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}` },
  })
  return json({ ok: res.ok, status: res.status }, res.ok ? 200 : 502)
}
