/**
 * Cloudflare Pages Function — GET /api/signal
 *
 * Reports which signaling broker the app should use, as ONE shared answer every
 * client reads — so a call's participants always agree on a broker (two peers on
 * different brokers can't discover each other). Returns:
 *   { host: "<worker host>" }  when our self-hosted signaling worker is healthy
 *   { host: null }             otherwise → the public PeerJS broker
 *
 * Health is probed SERVER-SIDE here (Cloudflare → the worker), never per-browser,
 * so one client's local network blip can't split a call across brokers. If the
 * worker is down, the check fails for everyone alike and the whole call falls
 * back together — and recovers automatically once it's back.
 *
 * Configure (Pages → Settings → Variables — a plain Variable; it's a public
 * hostname, not a secret):
 *   SIGNAL_HOST — the deployed signal-worker host, e.g.
 *                 kibitz-signal.<account>.workers.dev   (no scheme, no slash)
 * Unset → always { host: null }. Clear it to fall back to the public broker
 * instantly, with no site rebuild.
 */

interface Env {
  SIGNAL_HOST?: string
}

const json = (body: unknown, cacheSeconds: number): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${cacheSeconds}` },
  })

export const onRequestGet = async (context: { env: Env }): Promise<Response> => {
  const host = (context.env.SIGNAL_HOST ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (!host) return json({ host: null }, 30)

  try {
    // The worker's id endpoint returns 200 when it's up. Both ends are on
    // Cloudflare's network, so this is fast and a shared verdict for all clients.
    const res = await fetch(`https://${host}/id`, { method: 'GET', signal: AbortSignal.timeout(2500) })
    if (res.ok) return json({ host }, 30)
  } catch {
    /* unreachable / timed out → fall back */
  }
  return json({ host: null }, 10) // shorter cache while down → recovery seen sooner
}
