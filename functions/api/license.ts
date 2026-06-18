/**
 * Cloudflare Pages Function — GET /api/license?session_id=…
 *
 * After a successful checkout, the processor redirects the user to a success
 * page with the Stripe session id. That page calls this endpoint to fetch the
 * generated license key (mapped from the session by api/webhook/stripe) so the
 * user can copy it into Kibitz — no account needed.
 *
 * SCAFFOLDED, DORMANT: returns {key:null, configured:false} until the
 * ENTITLEMENTS KV namespace is bound.
 */

interface KVNamespace {
  get(key: string, type?: 'json' | 'text'): Promise<unknown>
}
interface Env {
  ENTITLEMENTS?: KVNamespace
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

export const onRequestGet = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context
  if (!env.ENTITLEMENTS) return json({ key: null, configured: false })
  const sessionId = new URL(request.url).searchParams.get('session_id')
  if (!sessionId) return json({ key: null, error: 'missing session_id' }, 400)
  const key = (await env.ENTITLEMENTS.get(`sess:${sessionId}`, 'text')) as string | null
  return json({ key: key ?? null })
}
