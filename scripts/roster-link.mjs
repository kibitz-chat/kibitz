// Runner for roster-link.ts. Node can't import the engine's extensionless `.ts` modules directly,
// so we esbuild-bundle the CLI to a temp file and run it. esbuild (~50ms) is already a dep (vite).
//   node scripts/roster-link.mjs <roster.json> [flags]
import { build } from 'esbuild'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./roster-link.ts', import.meta.url))
const out = join(tmpdir(), `roster-link-${process.pid}.mjs`)
await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'error' })
await import(out) // reads process.argv (the user's flags ride through unchanged)
