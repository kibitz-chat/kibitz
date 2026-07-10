// freeze-release.mjs — vendor the CURRENT widget build at an immutable, versioned path so a
// pinned `https://kibitz.chat/v<version>/widget.js` survives every future deploy (Cloudflare
// Pages does full-snapshot deploys, so a versioned build only persists if it's committed under
// public/, which Vite copies to the site root). Run when cutting a release:
//
//   npm run build && node scripts/freeze-release.mjs
//
// It REFUSES to overwrite an already-frozen version (a frozen build is immutable — bump the
// package.json version first), and prints the SRI hash to paste into the docs / integrity=.
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
const src = resolve(root, 'dist/widget.js')
const destDir = resolve(root, `public/v${version}`)
const dest = resolve(destDir, 'widget.js')

if (!existsSync(src)) {
  console.error(`freeze-release: no build at dist/widget.js — run "npm run build" first`)
  process.exit(1)
}
if (existsSync(dest)) {
  console.error(`freeze-release: public/v${version}/widget.js already exists — a frozen release is immutable.`)
  console.error(`  Bump "version" in package.json before freezing a changed widget.`)
  process.exit(1)
}
mkdirSync(destDir, { recursive: true })
cpSync(src, dest)
const bytes = readFileSync(dest)
const sri = 'sha384-' + createHash('sha384').update(bytes).digest('base64')
console.log(`freeze-release: wrote public/v${version}/widget.js (${bytes.length} bytes)`)
console.log(`  served at  https://kibitz.chat/v${version}/widget.js`)
console.log(`  integrity  ${sri}`)
console.log(`  → commit public/v${version}/, then update the pin in public/docs.md §5.`)
