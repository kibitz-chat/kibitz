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
//   VITE_BRAND_MENU_ORIGIN     origin a rebrand allows for an in-call host menu (e.g. a rating page);
//                              the only origin Kibitz will frame, never a URL an agent picks. Omit → off.
//   VITE_BRAND_SUMMON_PATH     path a rebrand exposes as an in-call "Summon agent" button (e.g. '/agent');
//                              opens "<path>?room=<thisRoom>" in a new tab. Omit → no summon button.
//   VITE_BRAND_SUMMON_API      optional endpoint for ONE-TAP summon: when the room link carries a summon
//                              key (`sk`), the button POSTs {summonKey} here instead of opening the path —
//                              the brand re-launches the agent from stored params. Omit → always use path.
//   VITE_BRAND_OFFLINE_APP     path to a native companion app shown on the INSTALL page (e.g. '/host' — an
//                              Android LAN-hub APK download for hosting calls offline). Omit → no link.
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
  /** Origin allowed to host an IN-CALL menu (the host-menu seam, src/widget/hostMenu.ts). An agent can
   *  ENABLE a menu (hostMenu in its agent-actions manifest) but Kibitz only ever frames it on THIS origin
   *  — never a URL the agent picks (anti-phishing). e.g. 'https://your-brand.example' for a rating menu.
   *  Unset on the default product → host menus are disabled. */
  menuOrigin?: string
  /** Optional path a rebrand exposes as an in-call "Summon agent" button (e.g. '/agent'). Opening it
   *  appends `?room=<currentRoomId>` so a wizard can launch an agent into THIS call (new tab, so the call
   *  isn't dropped). Same-origin path or absolute URL. Unset on the default product → no summon button. */
  summonPath?: string
  /** Optional ONE-TAP summon endpoint. When the room link carries a summon key (`sk`), the Summon button
   *  POSTs `{summonKey}` here — the brand re-launches the agent from server-stored params (no wizard, no
   *  coupon re-entry) — instead of opening `summonPath`. Unset → the button always opens `summonPath`. */
  summonApi?: string
  /** Opt-in: copy GATED (verified/agent) room invites via the `/j/<room>?…` share hop too, with the gate
   *  params on the QUERY — which this brand's /j hop forwards, so admission still works — instead of the
   *  fragment-only full URL. Gives a WhatsApp-preview-friendly link for agent rooms. TRADE-OFF: the gate
   *  params (incl. the bearer summon key `sk`) then traverse the CDN (→ access logs / Referer), where the
   *  fragment form keeps them client-only — so it's opt-in. Unset → gated rooms stay fragment-only (default). */
  shareGatedViaJHop?: boolean
  /** Single active instance per browser: only the most-recently-opened tab/window runs the call; when a
   *  newer one opens, older tabs leave the call and return to the home screen. Unset on the default
   *  product (kibitz.chat allows many tabs); a rebrand sets VITE_BRAND_SINGLE_INSTANCE=1 to enforce it. */
  singleInstance?: boolean
  /** Apply a new deploy SILENTLY instead of showing a "reload to update" prompt (pwa.tsx). Unset on kibitz
   *  (the prompt lets you reload when you choose); a rebrand sets VITE_BRAND_SILENT_UPDATE=1. The silent reload
   *  still never interrupts a LIVE call — it waits for the call to end. */
  silentUpdate?: boolean
  /** Unified room sync (docs/unified-room-sync.md): route the chat union through the roomLedger CRDT + a
   *  content-addressed blob store (media fetched by hash, no replay caps). ON by default for the hosted app
   *  (main.tsx sets the window flag from this); coexists with the legacy paths (dedup by mid). A rebrand opts
   *  OUT with VITE_BRAND_ROOM_SYNC_V2=0; a user overrides per device with localStorage['kbz.roomSyncV2']. */
  roomSyncV2?: boolean
  /** Optional path to a NATIVE companion app a rebrand offers on the INSTALL page (e.g. '/host' — the
   *  Android LAN-hub APK that lets one device host calls OFFLINE). A website can't install an APK, so it's
   *  just a download link (the target page detects Android). Unset on the default product → no link shown. */
  offlineAppPath?: string
  /** Optional endpoint a rebrand exposes to SHORTEN a room invite link (e.g. '/shorten' — its OWN server).
   *  The room's invite panel POSTs `{ link }` (the full invite URL) and gets back `{ url }`, a short link
   *  that redirects to it — so long verified/AI-agent invites can be shared short. Unset on the default
   *  product → no "short link" button (the feature lives entirely in the brand's own backend). */
  shortlinkApi?: string
  /** Max HUMANS per room (a cooperative media-quality cap): stamped as `cap=N` on rooms this app CREATES, so the
   *  P2P mesh (every peer uploads to every other) doesn't degrade past a handful. Agents don't count. Unset on the
   *  default product (Kibitz) ⇒ unlimited; a rebrand sets VITE_BRAND_HUMAN_CAP=6. Enforced in useCall (maxHumans). */
  humanCap?: number
  /** Hide the privacy/security CHROME for a less technical audience: the call-bar "Verify your call is private"
   *  shield (the safety code) and the chat-intro "peer-to-peer & ephemeral" note. The call is still E2EE — this
   *  only drops the optional UI. Unset on the default product (Kibitz) → both shown. */
  hidePrivacyChrome?: boolean
  /** Floating agent-control bubble (docs/floating-agent-control.md in the kibitz repo): a draggable pill
   *  per agent that expands into a mini control panel (engage/disengage, scribe enable/disable, leave,
   *  capabilities), plus a creator-only summon bubble. Replaces the summon banner + AgentActionsBar for this
   *  brand when on. OFF by default (scaffold ships dark); a device can also force it with ?bubble=1 /
   *  localStorage['kbz.agentBubble']. */
  agentBubble?: boolean
  /** Room-creator "Top up" link in the agent bubble's credit panel — a checkout URL (opened in a new tab) to
   *  buy more coupon credit. Unset → no Top up button. */
  topupUrl?: string
  /** Hostnames the widget may NAVIGATE to when the caller LEAVES a call, if the room link carries `back=<url>`
   *  (e.g. the gift dashboard the caller came from). Open-redirect-safe: only these exact hosts, only http(s).
   *  Unset on the default product → the caller just stays on the app after leaving. VITE_BRAND_RETURN_HOSTS is
   *  comma/'|'-separated (e.g. 'witz.chat,www.witz.chat'). */
  returnHosts?: string[]
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
  menuOrigin: env.VITE_BRAND_MENU_ORIGIN || undefined,
  summonPath: env.VITE_BRAND_SUMMON_PATH || undefined,
  summonApi: env.VITE_BRAND_SUMMON_API || undefined,
  shareGatedViaJHop: env.VITE_BRAND_SHARE_GATED_JHOP === '1' || env.VITE_BRAND_SHARE_GATED_JHOP === 'true',
  singleInstance: env.VITE_BRAND_SINGLE_INSTANCE === '1' || env.VITE_BRAND_SINGLE_INSTANCE === 'true',
  silentUpdate: env.VITE_BRAND_SILENT_UPDATE === '1' || env.VITE_BRAND_SILENT_UPDATE === 'true',
  // v2 is now the default for the hosted app (verified fixed) — a rebrand opts OUT with VITE_BRAND_ROOM_SYNC_V2=0.
  roomSyncV2: env.VITE_BRAND_ROOM_SYNC_V2 !== '0' && env.VITE_BRAND_ROOM_SYNC_V2 !== 'false',
  offlineAppPath: env.VITE_BRAND_OFFLINE_APP || undefined,
  shortlinkApi: env.VITE_BRAND_SHORTLINK_API || undefined,
  humanCap: (() => {
    const n = parseInt(env.VITE_BRAND_HUMAN_CAP || '', 10)
    return Number.isInteger(n) && n > 0 ? n : undefined
  })(),
  hidePrivacyChrome: env.VITE_BRAND_HIDE_PRIVACY_CHROME === '1' || env.VITE_BRAND_HIDE_PRIVACY_CHROME === 'true',
  agentBubble: env.VITE_BRAND_AGENT_BUBBLE === '1' || env.VITE_BRAND_AGENT_BUBBLE === 'true',
  topupUrl: env.VITE_BRAND_TOPUP_URL || undefined,
  returnHosts: env.VITE_BRAND_RETURN_HOSTS
    ? env.VITE_BRAND_RETURN_HOSTS.split(/[,|]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined,
}
