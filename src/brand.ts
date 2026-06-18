// White-label brand, resolved at BUILD time from VITE_BRAND_* env vars.
//
// The DEFAULTS are this app's OWN brand (Kibitz). A sibling product supplies its name / tagline /
// accent / landing copy / call-platform hosts through these env vars at build time (from that
// product's own repo + deploy) — so NO sibling-specific values ever live in this repo.
//
//   VITE_BRAND_NAME            wordmark (H1 + document title)
//   VITE_BRAND_TAGLINE         landing tagline; '|' separates lines
//   VITE_BRAND_TAGLINE_SHORT   installed-launcher tagline; '|' separates lines
//   VITE_BRAND_ACCENT          accent colour (any CSS colour) — recolours the paper theme + the call
//   VITE_BRAND_HERO_SUB        landing hero paragraph(s); '|' separates paragraphs (rebrand → replaces
//                              the default copy and hides the default's product-specific sections)
//   VITE_BRAND_POINTS          short bullet list shown on a rebrand's landing; '|' separates bullets
//   VITE_BRAND_POINTS_TITLE    heading for that list
//   VITE_BRAND_SIGNAL_HOST     force the signaling broker host (when this build isn't served from an
//   VITE_BRAND_TURN_HOST       origin that has /api/signal + /api/turn — e.g. a static sibling site
//   VITE_BRAND_API_BASE        that borrows the platform's call backend). Omit on the platform itself.
export interface Brand {
  name: string
  taglineLanding: string[]
  taglineLauncher: string[]
  accent?: string
  /** Landing hero paragraphs. Set → a rebrand: replaces the default hero copy AND hides the default's
   *  product-specific marketing sections (the landing shows hero + `points` + footer). */
  heroSub?: string[]
  points?: string[]
  pointsTitle?: string
  /** Footer (a rebrand's): a small-print line + links, replacing the default's. */
  footerNote?: string
  footerLinks?: { label: string; href: string }[]
  /** Optional SECOND home-page CTA beside "Start a room" — a rebrand can point it at a page of its
   *  own (e.g. a static "set up a room with an agent" flow). Unset on the default product. */
  secondaryCta?: { label: string; href: string }
  /** Call-backend hosts for a build NOT served from the platform origin (a sibling's static site).
   *  Omit on the platform itself (same-origin /api/signal + /api/turn). */
  signalHost?: string
  turnHost?: string
  apiBase?: string
}

const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {}
const lines = (s: string | undefined, fallback: string[]): string[] =>
  s ? s.split('|').map((x) => x.trim()).filter(Boolean) : fallback

export const brand: Brand = {
  name: env.VITE_BRAND_NAME || 'Kibitz',
  taglineLanding: lines(env.VITE_BRAND_TAGLINE, [
    'Look at anything together — anywhere on the web.',
    'With anyone. Even agentic AI.',
  ]),
  taglineLauncher: lines(env.VITE_BRAND_TAGLINE_SHORT, ['Look at anything together.']),
  accent: env.VITE_BRAND_ACCENT || undefined,
  heroSub: env.VITE_BRAND_HERO_SUB ? lines(env.VITE_BRAND_HERO_SUB, []) : undefined,
  points: env.VITE_BRAND_POINTS ? lines(env.VITE_BRAND_POINTS, []) : undefined,
  pointsTitle: env.VITE_BRAND_POINTS_TITLE || undefined,
  footerNote: env.VITE_BRAND_FOOTER_NOTE || undefined,
  // 'Label:href' pairs, '|'-separated — e.g. 'Privacy:/privacy|Terms:/terms|Help:#help'.
  footerLinks: env.VITE_BRAND_FOOTER_LINKS
    ? lines(env.VITE_BRAND_FOOTER_LINKS, [])
        .map((s) => {
          const i = s.indexOf(':')
          return i > 0 ? { label: s.slice(0, i).trim(), href: s.slice(i + 1).trim() } : null
        })
        .filter((x): x is { label: string; href: string } => !!x)
    : undefined,
  // 'Label:href' — e.g. 'Start a room with an AI agent:/agent'. Adds a second home-page button.
  secondaryCta: (() => {
    const s = env.VITE_BRAND_SECONDARY_CTA
    if (!s) return undefined
    const i = s.indexOf(':')
    return i > 0 ? { label: s.slice(0, i).trim(), href: s.slice(i + 1).trim() } : undefined
  })(),
  signalHost: env.VITE_BRAND_SIGNAL_HOST || undefined,
  turnHost: env.VITE_BRAND_TURN_HOST || undefined,
  apiBase: env.VITE_BRAND_API_BASE || undefined,
}
