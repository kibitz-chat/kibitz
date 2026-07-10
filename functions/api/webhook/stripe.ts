/**
 * Cloudflare Pages Function — POST /api/webhook/stripe
 *
 * Receives Stripe (or any HMAC-signed) billing webhooks and writes entitlement
 * records into the ENTITLEMENTS KV namespace, so /api/turn can gate on them.
 *
 * SCAFFOLDED, DORMANT: a no-op (returns {configured:false}) until BOTH the
 * ENTITLEMENTS KV namespace is bound AND the STRIPE_WEBHOOK_SECRET is set. Point
 * a Stripe webhook at this URL once you're ready to charge.
 *
 * KV layout (see api/turn.ts and api/license.ts):
 *   lic:<licenseKey>   → { status:"active"|"canceled", plan, exp?, ... }
 *   sess:<sessionId>   → <licenseKey>   (1h TTL; success page exchanges it)
 *   sub:<subId>        → <licenseKey>   (so cancellations map back to a key)
 */

interface KVNamespace {
  get(key: string, type?: 'json' | 'text'): Promise<unknown>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}
interface Env {
  STRIPE_WEBHOOK_SECRET?: string
  ENTITLEMENTS?: KVNamespace
}

const enc = new TextEncoder()
const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let out = 0
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return out === 0
}

/** Verify Stripe's `t=…,v1=…` signature with WebCrypto (no SDK needed). */
async function verifySig(body: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false
  const parts: Record<string, string> = {}
  for (const seg of header.split(',')) {
    const i = seg.indexOf('=')
    if (i > 0) parts[seg.slice(0, i).trim()] = seg.slice(i + 1).trim()
  }
  const t = parts['t']
  const v1 = parts['v1']
  if (!t || !v1) return false
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false // replay window
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`))
  return timingSafeEqual(toHex(mac), v1)
}

async function setStatus(env: Env, licenseKey: string, status: string): Promise<void> {
  if (!env.ENTITLEMENTS) return
  const prev = ((await env.ENTITLEMENTS.get(`lic:${licenseKey}`, 'json')) as Record<string, unknown> | null) ?? {}
  await env.ENTITLEMENTS.put(`lic:${licenseKey}`, JSON.stringify({ ...prev, status, updated: Date.now() }))
}

interface StripeEvent {
  type?: string
  data?: { object?: { id?: string; subscription?: string; status?: string } }
}

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context
  if (!env.STRIPE_WEBHOOK_SECRET || !env.ENTITLEMENTS) {
    return new Response(JSON.stringify({ configured: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const body = await request.text()
  if (!(await verifySig(body, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return new Response('invalid signature', { status: 400 })
  }

  let ev: StripeEvent
  try {
    ev = JSON.parse(body) as StripeEvent
  } catch {
    return new Response('bad body', { status: 400 })
  }

  const obj = ev.data?.object ?? {}
  switch (ev.type) {
    case 'checkout.session.completed': {
      // Idempotent: Stripe delivers at-least-once (it retries on any 5xx/timeout/lost response). If
      // this session was already provisioned, do NOT mint a second key — the orphaned first key would
      // have no `sub:` mapping and so would survive cancellation forever. A re-delivery is a no-op.
      if (obj.id && (await env.ENTITLEMENTS.get(`sess:${obj.id}`, 'text'))) break
      const licenseKey = crypto.randomUUID().replace(/-/g, '')
      await env.ENTITLEMENTS.put(`lic:${licenseKey}`, JSON.stringify({ status: 'active', plan: 'pro', created: Date.now() }))
      if (obj.id) await env.ENTITLEMENTS.put(`sess:${obj.id}`, licenseKey, { expirationTtl: 3600 })
      if (obj.subscription) await env.ENTITLEMENTS.put(`sub:${obj.subscription}`, licenseKey)
      break
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      if (obj.id) {
        const licenseKey = (await env.ENTITLEMENTS.get(`sub:${obj.id}`, 'text')) as string | null
        if (licenseKey) {
          const active = ev.type !== 'customer.subscription.deleted' && (obj.status === 'active' || obj.status === 'trialing')
          await setStatus(env, licenseKey, active ? 'active' : 'canceled')
        }
      }
      break
    }
  }

  return new Response('ok')
}
