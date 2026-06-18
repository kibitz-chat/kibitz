/**
 * Cloudflare Pages Function — GET /j/:roomId  (a WhatsApp-friendly shareable room link)
 *
 * Problem: a bare fragment link (kibitz.chat/#room) can't be made link-preview-friendly, because the
 * `#room` fragment never reaches the server — so the preview crawler only ever sees the homepage and
 * WhatsApp collapses the message into a logo-only preview card, hiding the raw URL.
 *
 * This PATH form (room in the path) lets the SERVER answer differently per requester:
 *   • Humans → 302 to the fragment route (/#room), which joins the room exactly as today. Only this
 *     one share hop sees the code; the actual room session still rides the fragment.
 *   • Preview crawlers (WhatsApp / facebookexternalhit / Facebot / …) → 204 No Content — no HTML, no
 *     Open Graph tags, no-store. With nothing to render, WhatsApp leaves the URL visible as plain text.
 *     (Switch 204→404 below if you prefer; both are "nothing to preview".)
 *
 * TRADE-OFF: unlike the fragment default, this path sends the room code to the server/logs/CDN, so
 * it's OPT-IN for shareable links — the app's default invite stays fragment-only. UA sniffing is
 * best-effort; WhatsApp/Meta cache previews, so test with a FRESH room id.
 */

// Link-unfurl / preview crawlers that should get NO previewable content (so the URL stays visible).
const PREVIEW_BOT =
  /WhatsApp\/\d|facebookexternalhit|Facebot|Twitterbot|Slackbot|TelegramBot|Discordbot|LinkedInBot|Pinterest|redditbot|SkypeUriPreview|vkShare|Google-?PageRenderer|Applebot/i

// AI content crawlers/scrapers (training, indexing, answer-engines). They don't run the app to JOIN —
// they just fetch — so they also get nothing. NOTE: this does NOT affect an AI AGENT that genuinely
// joins by driving a browser (that sends a normal browser UA → the human/join path below).
const AI_SCRAPER =
  /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|Claude-User|anthropic-ai|PerplexityBot|Perplexity-User|CCBot|Bytespider|Amazonbot|Diffbot|cohere-ai|Meta-ExternalAgent|meta-externalfetcher|Google-Extended|Applebot-Extended|YouBot|ImagesiftBot|omgili|Timpibot|DataForSeoBot/i

export const onRequest = (context: { request: Request; params: { roomId?: string } }): Response => {
  const { request, params } = context
  const ua = request.headers.get('user-agent') || ''
  const roomId = String(params.roomId || '')

  // Preview bots + AI scrapers → nothing to render/scrape → WhatsApp keeps the URL visible as plain text.
  if (PREVIEW_BOT.test(ua) || AI_SCRAPER.test(ua)) {
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store, max-age=0' } })
  }

  // Humans → the normal fragment route (joins the room; keeps the code off the server for the
  // session). Forward any query string (e.g. a ?k= TURN grant) so it reaches the app, and put the
  // room in the fragment. Built from the request origin so it works on any deploy.
  const u = new URL(request.url)
  return new Response(null, {
    status: 302,
    headers: {
      location: `${u.origin}/${u.search}#${encodeURIComponent(roomId)}`,
      'cache-control': 'no-store, max-age=0',
    },
  })
}
