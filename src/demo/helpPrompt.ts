// Builds the copyable "ask any LLM about Kibitz" support prompt shown on the #help page.
//
// The idea: a user with a question copies ONE block, pastes it into ChatGPT / Claude / Gemini / any
// assistant WITH WEB ACCESS, and that assistant becomes a Kibitz support agent — by reading the live
// product docs, the site itself, and the open-source repos. The prompt is a POINTER: it tells the
// model what to read first, then to answer. (Deliberately assumes the assistant can browse — we don't
// bundle anything inline.)
//
// Pure function (no DOM, no fetch) so it's unit-testable and the page just renders its output.

/** Canonical, always-current sources the assistant should read (and follow links within). */
export const HELP_SOURCES = {
  full: 'https://kibitz.chat/llms-full.txt',
  site: 'https://kibitz.chat/',
  manual: 'https://kibitz.chat/manual.md',
  security: 'https://kibitz.chat/security.md',
  docs: 'https://kibitz.chat/docs',
  github: 'https://github.com/kibitz-chat/kibitz',
  // Sibling open-source projects in the same family (all public on the kibitz-chat org).
  whist: 'https://github.com/kibitz-chat/whist',
  whistSite: 'https://whist.kibitz.chat',
  offline: 'https://github.com/kibitz-chat/kibitz-offline',
  offlineGuide: 'https://kibitz.chat/relay',
} as const

/** The ready-to-paste support prompt. Static — it points the model at the live sources to read. */
export function buildHelpPrompt(): string {
  return [
    `You are a friendly, precise support assistant for **Kibitz** — an account-free, peer-to-peer, end-to-end-encrypted video-call and co-browsing app where a room is simply a link you open. Help the person using it.`,

    `First, read the official sources (you have web access) so your answers are accurate and current. Follow links and open additional pages as needed:
- ${HELP_SOURCES.full} — the master reference: everything about Kibitz in one file (product, every UI control, security, privacy, terms, plus the engine + agent docs)
- ${HELP_SOURCES.site} — the live site itself; browse to any page (e.g. ${HELP_SOURCES.manual}, ${HELP_SOURCES.security}, /privacy.md, /terms, /docs) to see exactly what a user sees
- ${HELP_SOURCES.github} — the full open-source code and docs (Kibitz is open source); read it for anything code-level or to verify a claim
- Sibling open-source projects in the same family: ${HELP_SOURCES.whist} (Whist — a card game built on the Kibitz engine where an AI agent joins as a "kibitzer"; live demo at ${HELP_SOURCES.whistSite}) and ${HELP_SOURCES.offline} (Offline mode — the LAN hub for same-Wi-Fi, no-internet calls; user guide at ${HELP_SOURCES.offlineGuide})`,

    `How to answer:
- Be concise, warm, and concrete. When they ask "how do I…", give the exact steps and name the buttons.
- Ground every answer in those sources. Don't invent features, prices, settings, or guarantees — if something isn't covered, say you're not sure and point them to ${HELP_SOURCES.docs} or the GitHub repos above.
- Be exact about privacy: calls are end-to-end encrypted and go directly between browsers — there is no media server that can see or record them. Don't overstate or understate this.`,

    `Begin by reading the sources above, then greet me in one short line and ask what I'd like help with. Wait for my question before going deeper.`,
  ].join('\n\n')
}
