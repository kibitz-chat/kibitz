/**
 * Cloudflare Pages Function — POST /api/room-grant   { "room": "<room>" }
 *
 * The "opener pays" primitive, done safely. A license holder (the sponsor) calls
 * this to mint a SHORT-LIVED, ROOM-SCOPED, signed grant. They broadcast it to the
 * room; each joiner presents it to /api/turn (header `X-Kibitz-Grant`), which
 * verifies it and mints TURN metered to the sponsor — without the sponsor's
 * endpoint ever being an open relay, and without leaking the sponsor's key.
 *
 * Why a grant instead of the raw `?turn=host` link: that pointed joiners at the
 * sponsor's endpoint unauthenticated (open-relay-or-broken). A grant carries a
 * verifiable, time-boxed, room-bound authorization instead.
 *
 * SCAFFOLDED, DORMANT: returns {configured:false} until BOTH the ENTITLEMENTS KV
 * is bound AND ROOM_GRANT_SECRET is set. Mirrors api/turn.ts's on-switch.
 */
import { type KV, tagOf, signGrant, intEnv } from './_turn'

interface Env {
  ENTITLEMENTS?: KV
  ROOM_GRANT_SECRET?: string
  ROOM_GRANT_TTL_SECONDS?: string // grant lifetime (default 600 = 10 min)
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } })

export const onRequestOptions = (): Response => new Response(null, { status: 204, headers: CORS })

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context
  if (!env.ENTITLEMENTS || !env.ROOM_GRANT_SECRET) return json({ configured: false })

  // Sponsor must present an active license key.
  const key = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '') || null
  if (!key) return json({ error: 'missing license key' }, 401)
  const rec = (await env.ENTITLEMENTS.get(`lic:${key}`, 'json')) as { status?: string; exp?: number } | null
  if (!rec || rec.status !== 'active' || (rec.exp && Date.now() >= rec.exp)) {
    return json({ error: 'inactive license' }, 403)
  }

  let room = ''
  try {
    room = String(((await request.json()) as { room?: unknown })?.room ?? '').trim()
  } catch {
    /* no/!json body */
  }
  if (!room) return json({ error: 'missing room' }, 400)
  // Bound + sanitize: `room` rides into the signed grant AND into a Cloudflare KV metering key
  // (`issued:room:<room>:<period>` in api/turn — KV keys cap at 512 bytes). An unbounded or exotic
  // value would bloat the grant and could break the per-room cost cap. Real room ids are short slugs.
  if (room.length > 200) return json({ error: 'room too long' }, 400)
  if (!/^[\w.:-]{1,200}$/.test(room)) return json({ error: 'invalid room' }, 400)

  const ttl = intEnv(env.ROOM_GRANT_TTL_SECONDS, 600)
  const exp = Math.floor(Date.now() / 1000) + ttl
  // sub = the sponsor's metering tag (a hash of the key) — so /api/turn meters the
  // sponsor and the raw key never travels in the grant.
  const grant = await signGrant(env.ROOM_GRANT_SECRET, { room, sub: await tagOf(key), exp })
  return json({ grant, exp })
}
