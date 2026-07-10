// Render the engineering docs (docs/*.md) into themed, crawlable HTML pages under dist/docs/<name>/,
// so the specs that used to live only on GitHub are first-class, readable pages on the site (linked
// from the Kibitz Engine hub at /docs). Build-time only: `marked` is a devDependency and this script
// is NOT imported by the app, so nothing ships to the browser. Runs in plain Node after `vite build`
// (which copies public/ → dist/), like prerender.mjs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The set to publish (excludes README — that's the hub — and any internal CODEMAPS). Each gets a
// short nav label for the cross-links between docs.
const DOCS = [
  { name: 'architecture', label: 'Architecture' },
  { name: 'verification', label: 'Verification' },
  { name: 'cert-binding', label: 'Cert-binding' },
  { name: 'threat-model', label: 'Threat model' },
  { name: 'agent-protocol', label: 'Agent protocol' },
  { name: 'agent-platform', label: 'Agent platform' },
  { name: 'host-menu', label: 'Host menu' },
  { name: 'offline-mode', label: 'Offline / LAN' },
  { name: 'wake-seam', label: 'Wake' },
  { name: 'shared-screen-annotation', label: 'Annotation' },
  { name: 'map-widget', label: 'Map widget' },
]
const KNOWN = new Set(DOCS.map((d) => d.name))

// Single source of truth for the look: reuse the Engine page's own <style> block so the rendered
// docs match it exactly (light paper theme, code blocks, tables, .note, nav — all already targeted).
const enginePage = readFileSync(resolve(root, 'public/docs/index.html'), 'utf8')
const styleMatch = enginePage.match(/<style>[\s\S]*?<\/style>/)
if (!styleMatch) throw new Error('render-docs: could not find the <style> block in public/docs/index.html')
const sharedStyle = styleMatch[0]

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// GitHub-compatible heading slug, so the docs' existing cross-anchors (`verification.md#7-…`) resolve.
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, '') // strip any inline tags first
    .replace(/&[a-z]+;|&#\d+;/gi, '') // drop HTML entities (&quot; &amp; …) so they don't leak into the id
    .replace(/[^\w\s-]/g, '') // drop punctuation (em dash, parens, colons…)
    .trim()
    .replace(/\s/g, '-') // each space → a hyphen (no collapsing, matching GitHub)

function renderDoc({ name, label }) {
  const md = readFileSync(resolve(root, `docs/${name}.md`), 'utf8')
  // Title = the first H1; description = the first real paragraph, flattened for the meta tag.
  const title = (md.match(/^#\s+(.+)$/m)?.[1] ?? label).trim()
  const descLine = (md.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('>')) ?? '').trim()
  const desc = descLine.replace(/[*_`[\]]/g, '').slice(0, 160)

  let body = marked.parse(md)
  // Add ids to headings (marked v18 doesn't), so in-page + cross-doc anchors work.
  body = body.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, lvl, inner) => `<h${lvl} id="${slug(inner)}">${inner}</h${lvl}>`)
  // Rewrite intra-repo doc links: `./verification.md#x` → `/docs/verification#x`; README → the hub.
  body = body.replace(/href="(?:\.\/)?([A-Za-z0-9_-]+)\.md(#[^"]*)?"/g, (_m, base, hash = '') => {
    const b = base.toLowerCase()
    const path = b === 'readme' ? '/docs' : `/docs/${b}`
    return `href="${path}${hash || ''}"`
  })

  const crumbs = DOCS.filter((d) => d.name !== name)
    .map((d) => `<a href="/docs/${d.name}">${d.label}</a>`)
    .join('\n        ')

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(title)} — Kibitz Engine docs</title>
    <meta name="description" content="${esc(desc)}" />
    <meta name="theme-color" content="#faf6ef" />
    ${sharedStyle}
  </head>
  <body>
    <div class="wrap">
      <a class="brand" href="/">Kibitz</a>
      <p style="margin:10px 0 0;font-size:0.92rem"><a href="/docs">← The Kibitz Engine</a> · deep dive</p>
      ${body}
      <nav>
        <a href="/docs">← Engine docs</a>
        ${crumbs}
        <a href="/">Kibitz home</a>
      </nav>
    </div>
  </body>
</html>
`
  const outDir = resolve(root, `dist/docs/${name}`)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(resolve(outDir, 'index.html'), html)
  return { name, title, bytes: html.length }
}

// Warn (don't fail) on any cross-link to an unrendered .md so we notice dangling references.
function warnDangling(name) {
  const md = readFileSync(resolve(root, `docs/${name}.md`), 'utf8')
  for (const m of md.matchAll(/\]\((?:\.\/)?([A-Za-z0-9_-]+)\.md(?:#[^)]*)?\)/g)) {
    const b = m[1].toLowerCase()
    if (b !== 'readme' && !KNOWN.has(b)) console.warn(`render-docs: ${name}.md links to unrendered "${b}.md"`)
  }
}

// Render public/manual.md → dist/manual/<index.html> as a readable, crawlable page (the raw .md
// downloads/shows unstyled, and a SW navigation would fall it back to the SPA — so a human link to
// it is "not good"). The LLM help prompt keeps pointing at the raw /manual.md; humans get /manual.
// Brand-aware: a rebrand's name/accent come from the build env (VITE_BRAND_*), default = Kibitz, so
// the same render serves the green Kibitz manual and a rebrand's accent-coloured one with no per-brand code.
function renderManual() {
  const brandName = process.env.VITE_BRAND_NAME || 'Kibitz'
  const accent = process.env.VITE_BRAND_ACCENT || '#1a7f4e'
  const md = readFileSync(resolve(root, 'public/manual.md'), 'utf8')
  const title = (md.match(/^#\s+(.+)$/m)?.[1] ?? `${brandName} — manual`).trim()
  const descLine = (md.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('>')) ?? '').trim()
  const desc = descLine.replace(/[*_`[\]]/g, '').slice(0, 160)

  let body = marked.parse(md)
  body = body.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, lvl, inner) => `<h${lvl} id="${slug(inner)}">${inner}</h${lvl}>`)
  // Any .md link (relative, or absolute to our own host) → the clean same-origin HTML page:
  // security.md → /security, docs.md → /docs, manual.md (self-ref) → /manual. Origin-relative so it
  // resolves on whichever host the build is served from.
  body = body.replace(/href="(?:https?:\/\/[^/"]+\/)?([a-z0-9-]+)\.md(#[^"]*)?"/gi, (_m, base, hash = '') => `href="/${base.toLowerCase()}${hash || ''}"`)

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(desc)}" />
    <meta name="theme-color" content="#faf6ef" />
    <style>
      :root { color-scheme: light }
      body { margin: 0; background: #faf6ef; color: #2a342f;
        font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif }
      .wrap { max-width: 760px; margin: 0 auto; padding: 24px 20px 72px }
      a { color: ${accent} }
      .brand { color: ${accent}; font-weight: 700; text-decoration: none; font-size: 1.3rem }
      h1, h2, h3, h4 { color: ${accent}; line-height: 1.25 }
      h1 { font-size: 1.8rem; margin: 16px 0 6px }
      h2 { font-size: 1.3rem; margin: 34px 0 8px; border-top: 1px solid rgba(0,0,0,.08); padding-top: 22px }
      h3 { font-size: 1.08rem; margin: 22px 0 4px }
      code { background: rgba(0,0,0,.05); padding: .12em .35em; border-radius: 5px; font-size: .9em }
      pre { background: #0d1117; color: #e6edf3; padding: 14px 16px; border-radius: 10px; overflow: auto }
      pre code { background: none; padding: 0 }
      blockquote { margin: 14px 0; padding: 6px 14px; border-left: 3px solid ${accent};
        color: #5b6470; background: rgba(0,0,0,.025) }
      table { border-collapse: collapse; width: 100%; margin: 14px 0 }
      th, td { border: 1px solid rgba(0,0,0,.12); padding: 7px 10px; text-align: left }
      hr { border: 0; border-top: 1px solid rgba(0,0,0,.1); margin: 28px 0 }
      nav { margin-top: 44px; padding-top: 16px; border-top: 1px solid rgba(0,0,0,.12);
        display: flex; gap: 18px; font-size: .92rem; flex-wrap: wrap }
    </style>
  </head>
  <body>
    <div class="wrap">
      <a class="brand" href="/">${esc(brandName)}</a>
      ${body}
      <nav>
        <a href="/">← ${esc(brandName)} home</a>
      </nav>
    </div>
  </body>
</html>
`
  const outDir = resolve(root, 'dist/manual')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(resolve(outDir, 'index.html'), html)
  return { title, bytes: html.length }
}

const done = DOCS.map((d) => {
  warnDangling(d.name)
  return renderDoc(d)
})
const manual = renderManual()
console.log(`render-docs: wrote ${done.length} docs → dist/docs/{${done.map((d) => d.name).join(',')}} + manual → dist/manual/ ("${manual.title}")`)
