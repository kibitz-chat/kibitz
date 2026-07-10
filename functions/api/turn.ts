/**
 * Cloudflare Pages Function — GET /api/turn
 *
 * Mints short-lived TURN+STUN ICE servers (Cloudflare Realtime TURN) so online
 * calls can relay media through strict/symmetric NATs. The long-term TURN key
 * stays here, server-side; the browser only ever receives ephemeral credentials.
 *
 * Configure (Pages → Settings → Variables and Secrets), BOTH as Secrets:
 *   TURN_KEY_ID         — the Realtime TURN key id
 *   TURN_KEY_API_TOKEN  — that key's API token
 * Until both are set this returns {configured:false} → the browser uses STUN.
 *
 * ── ABUSE CONTROLS (Cloudflare-only) — SCAFFOLDED, DORMANT ──────────────────
 * With NO `ENTITLEMENTS` KV binding, gating is OFF and this behaves EXACTLY as
 * before — open to all, 24h creds, no metering, no tag. Binding the KV turns the
 * gate ON; each control below then activates only if its own config is present,
 * so you can dial in hardening incrementally:
 *   ENTITLEMENTS        KV   — the master on-switch (gate + metering store)
 *   ROOM_GRANT_SECRET   sec  — verify sponsor room-grants (see api/room-grant.ts)
 *   TURN_TTL_SECONDS    var  — credential lifetime (default 86400; lower it)
 *   PREMIUM_MAX_ISSUES  var  — per-key credential issuances / month (cost cap)
 *   ROOM_MAX_ISSUES     var  — per-room issuances / month (sponsor blast-radius)
 *   GLOBAL_MAX_ISSUES   var  — global issuances / month (hard backstop)
 * Issuance count is a precise, Cloudflare-only proxy for cost (worst-case GB =
 * issuances × TTL × max-bitrate); reconcile real GB against Cloudflare analytics.
 *
 * This file is NOT part of the Vite/tsc app build (tsconfig includes only src/);
 * Cloudflare Pages bundles functions/ separately at deploy time.
 */
import { type KV, tagOf, verifyGrant, periodKey, peek, bump, intEnv } from './_turn'

interface Env {
  TURN_KEY_ID?: string
  TURN_KEY_API_TOKEN?: string
  ENTITLEMENTS?: KV // bind to TURN ON premium gating + metering
  ROOM_GRANT_SECRET?: string
  TURN_TTL_SECONDS?: string
  PREMIUM_MAX_ISSUES?: string
  ROOM_MAX_ISSUES?: string
  GLOBAL_MAX_ISSUES?: string
}

const DEFAULT_TTL_SECONDS = 86_400 // 24h (max 48h) — unchanged default; override via TURN_TTL_SECONDS

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-kibitz-grant',
  'access-control-max-age': '86400',
}

const json = (body: unknown, cacheSeconds = 0): Response =>
  new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      'cache-control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
      ...CORS,
    },
  })

export const onRequestOptions = (): Response => new Response(null, { status: 204, headers: CORS })

interface Grant {
  room: string
  sub: string
  exp?: number
}
interface Authz {
  allowed: boolean
  tag?: string // metering subject + credential customIdentifier
  room?: string
  viaGrant?: boolean
}

/**
 * Who, if anyone, is this caller? With NO ENTITLEMENTS binding everyone is
 * allowed with no tag (today's open behaviour). With a binding, a caller must
 * present either a valid sponsor room-grant (X-Kibitz-Grant) or an active
 * license key (Authorization: Bearer).
 */
async function authorize(env: Env, request: Request): Promise<Authz> {
  if (!env.ENTITLEMENTS) return { allowed: true } // gating OFF → unchanged

  // 1) Sponsor room-grant — short-lived, room-scoped, signed (api/room-grant.ts).
  const grantTok = request.headers.get('x-kibitz-grant')
  if (grantTok && env.ROOM_GRANT_SECRET) {
    const g = await verifyGrant<Grant>(env.ROOM_GRANT_SECRET, grantTok)
    if (g && g.room && g.sub) return { allowed: true, tag: `r:${g.sub}`, room: g.room, viaGrant: true }
  }

  // 2) License key — active, unexpired entitlement.
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '') || null
  if (token) {
    const rec = (await env.ENTITLEMENTS.get(`lic:${token}`, 'json')) as { status?: string; exp?: number } | null
    if (rec && rec.status === 'active' && (!rec.exp || Date.now() < rec.exp)) {
      return { allowed: true, tag: await tagOf(token) }
    }
  }
  return { allowed: false }
}

/** The configured monthly issuance caps that apply to this caller (only those
 *  whose env var is set — absent caps are simply not enforced). */
function capsFor(env: Env, a: Authz): { key: string; cap: number }[] {
  const p = periodKey()
  const caps: { key: string; cap: number }[] = []
  if (env.GLOBAL_MAX_ISSUES) caps.push({ key: `issued:global:${p}`, cap: intEnv(env.GLOBAL_MAX_ISSUES, 0) })
  if (env.PREMIUM_MAX_ISSUES && a.tag) caps.push({ key: `issued:${a.tag}:${p}`, cap: intEnv(env.PREMIUM_MAX_ISSUES, 0) })
  if (env.ROOM_MAX_ISSUES && a.viaGrant && a.room) caps.push({ key: `issued:room:${a.room}:${p}`, cap: intEnv(env.ROOM_MAX_ISSUES, 0) })
  return caps
}

export const onRequestGet = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ iceServers: null, configured: false }, 30)

  const gated = !!env.ENTITLEMENTS
  const a = await authorize(env, request)
  if (gated && !a.allowed) {
    // Free tier → STUN only. Never public-cache a tier-dependent response.
    return json({ iceServers: null, configured: true, tier: 'free' }, 0)
  }

  // Quota backstop (gated only) — refuse new credentials once a cap is hit so a
  // leaked key / abusive room / runaway month can't exceed a cost ceiling.
  const caps = gated ? capsFor(env, a) : []
  for (const c of caps) {
    if ((await peek(env.ENTITLEMENTS as KV, c.key)) >= c.cap) {
      return json({ iceServers: null, configured: true, tier: 'capped' }, 0)
    }
  }

  try {
    const ttl = gated ? intEnv(env.TURN_TTL_SECONDS, DEFAULT_TTL_SECONDS) : DEFAULT_TTL_SECONDS
    // customIdentifier (gated only) tags creds with the metering subject, so usage
    // is attributable in Cloudflare analytics and revocable by tag (api/revoke.ts).
    const payload: Record<string, unknown> = { ttl }
    if (gated && a.tag) payload.customIdentifier = a.tag

    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )
    if (!res.ok) return json({ iceServers: null, configured: true, error: `cf ${res.status}` }, 0)
    const data = (await res.json()) as { iceServers?: unknown }

    // Count this issuance against every applicable cap (best-effort; see _turn).
    for (const c of caps) await bump(env.ENTITLEMENTS as KV, c.key)

    // Gating OFF → identical response for everyone → safe to cache 1h.
    // Gating ON → tier-dependent (per token/grant) → must not be cached.
    const tier = gated ? (a.viaGrant ? 'room' : 'premium') : 'open'
    return json({ iceServers: data.iceServers ?? null, configured: true, tier }, gated ? 0 : 3600)
  } catch (e) {
    return json({ iceServers: null, configured: true, error: String(e) }, 0)
  }
}
