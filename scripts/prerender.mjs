// Bake the landing's static HTML into dist/index.html so the homepage's content
// ships in the raw HTML (crawlers / no-JS / instant first paint), then the client
// takes over on load. Runs in plain Node — no headless browser — so it works in the
// Cloudflare Pages git build. Sequenced after `vite build` + the SSR render build.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const mod = await import(pathToFileURL(resolve(root, 'dist-ssr/prerender.js')).href)
const render = mod.render ?? mod.default?.render ?? mod.default
if (typeof render !== 'function') throw new Error('prerender: no render() export in dist-ssr/prerender.js')

const html = render()
if (!html || html.length < 200) throw new Error(`prerender: suspiciously small render (${html?.length} chars)`)

const indexPath = resolve(root, 'dist/index.html')
const marker = '<div id="root"></div>'
let out = readFileSync(indexPath, 'utf8')
if (!out.includes(marker)) throw new Error(`prerender: '${marker}' not found in dist/index.html`)
out = out.replace(marker, `<div id="root">${html}</div>`)
writeFileSync(indexPath, out)
console.log(`prerender: injected ${html.length} chars of landing HTML into dist/index.html`)
