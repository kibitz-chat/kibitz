/**
 * Root Pages middleware — KIBITZ-ONLY storefront/API reverse proxy.
 *
 * Kibitz's call app (this Pages project) and its storefront + control-plane API live on the SAME
 * hostname (kibitz.chat, and www.kibitz.chat). The app itself is served by Pages; the storefront
 * pages (/agent wizard, /studio, /marketplace, /host, /store, /rate, the agent-spec docs) and the
 * money-path APIs (/launch-agent, /shorten, /r/*, /gift/*, /keepsake/*) live on an AWS CloudFront
 * distribution. This middleware makes them same-origin by transparently proxying that allowlist to
 * the AWS distribution, so a link like `/agent` opens IN the app instead of bouncing the browser to
 * a different origin (which iOS wraps in its jarring in-app-browser overlay).
 *
 * GATED BY `STOREFRONT_ORIGIN` (a Pages env var = the AWS distribution host, e.g.
 * drwev5vxt2t2e.cloudfront.net). Unset → this is a NO-OP and every request falls straight through.
 * That's deliberate: kibitz.chat and witz.chat share this functions/ dir and must NOT proxy — they
 * simply don't set the var. Only the kibitz project does.
 *
 * Falls through (next()) for everything not on the allowlist — the app shell, /assets/*, the PWA
 * files, the overlaid /privacy /terms /help pages, and the NATIVE Pages functions (/api/turn,
 * /api/signal, /j/<room>, …) which must keep serving from Pages, not AWS.
 */
interface Env {
  STOREFRONT_ORIGIN?: string // AWS distribution host to proxy the storefront/API allowlist to; unset = no-op
}

// Paths the AWS distribution owns. Match is prefix-based, so each also covers its sub-paths
// (/agent → /agent/, /agent/lib/x.js, /agent-manifest-spec.md, …). Anything not listed here is the
// app or a native Pages function and is left untouched. Fail direction is toward the APP: a missed
// storefront path 404s visibly on Pages rather than silently shadowing an app route.
const PROXY_PREFIXES = [
  '/agent', // the /agent wizard + /agent-*.md spec docs
  '/studio',
  '/marketplace',
  '/host',
  '/store',
  '/rate',
  '/affordance-contract.md',
  '/launch-agent', // money path — summon/launch
  '/shorten',
  '/r/', // short-link resolve
  '/gift/', // gift / birthday flow
  '/keepsake/', // keepsake assets (S3)
]

function isProxied(pathname: string): boolean {
  return PROXY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const origin = ctx.env.STOREFRONT_ORIGIN
  if (!origin) return ctx.next() // not the kibitz storefront build → passthrough (kibitz.chat / witz.chat / unset)

  const url = new URL(ctx.request.url)
  if (!isProxied(url.pathname)) return ctx.next() // app shell, PWA files, native /api & /j functions

  // Transparent same-path proxy to the AWS distribution. Preserve method, headers, body, and query;
  // don't auto-follow redirects (the distribution's dir-index emits 301s the browser should see).
  const target = new URL(url.toString())
  target.protocol = 'https:'
  target.hostname = origin
  target.port = ''
  const method = ctx.request.method
  const proxied = new Request(target.toString(), {
    method,
    headers: ctx.request.headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : ctx.request.body,
    redirect: 'manual',
  })
  return fetch(proxied)
}
