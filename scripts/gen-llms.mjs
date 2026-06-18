// Generate dist/llms-full.txt by concatenating the per-page Markdown files (the
// canonical AI-readable content) — so the "everything in one fetch" file is never a
// separately hand-maintained copy that can drift. The per-page .md files in public/
// are copied to dist/ by Vite and served at /<page>.md; this stitches them together.
// Runs in plain Node (Cloudflare Pages git build), sequenced after `vite build`.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(resolve(root, p), 'utf8').trim()

// Order matters: overview/trust first, the product+UI manual, then policies, then
// the developer reference.
const PAGES = ['security.md', 'transparency.md', 'manual.md', 'privacy.md', 'terms.md', 'docs.md', 'relay.md']

// The engine deep-dives live in docs/ (rendered to /docs/<name> by render-docs.mjs). They
// document the architecture, threat model, verification gate, cert-binding, and the AGENT
// protocol/platform — content an LLM needs to act in a room. Inline them too, after the
// product pages, so /llms-full.txt is genuinely "everything in one fetch" (docs/README.md is
// the hub, intentionally skipped). Keep in sync with render-docs.mjs's DOCS list.
const DOCS = [
  'architecture.md',
  'threat-model.md',
  'verification.md',
  'cert-binding.md',
  'agent-protocol.md',
  'agent-platform.md',
  'offline-mode.md',
  'wake-seam.md',
]

const header = `# Kibitz — full reference for language models

> Account-free, peer-to-peer, end-to-end-encrypted video calls and co-browsing you embed with one script tag. This file inlines the site's pages as Markdown so an agent can answer in depth. The curated map is at https://kibitz.chat/llms.txt; each section below is also served on its own at https://kibitz.chat/<name>.md (product pages) or https://kibitz.chat/docs/<name> (engine deep-dives).
`

const productBody = PAGES.map((f) => read(`public/${f}`)).join('\n\n---\n\n')
const docsBody = DOCS.map((f) => read(`docs/${f}`)).join('\n\n---\n\n')
const docsDivider = `\n\n---\n\n# Engine deep-dives (rendered at https://kibitz.chat/docs/<name>)\n\n---\n\n`
const out = `${header}\n---\n\n${productBody}${docsDivider}${docsBody}\n`

writeFileSync(resolve(root, 'dist/llms-full.txt'), out)
console.log(`gen-llms: wrote dist/llms-full.txt (${out.length} chars from ${PAGES.length} pages + ${DOCS.length} docs)`)
