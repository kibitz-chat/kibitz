import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** The app's SemVer (from package.json), baked into the bundle so the running build can compare
 *  itself against the deployment's min-version floor (the kill-switch — see core/minVersion.ts). */
export const APP_VERSION: string = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version

/**
 * A human-readable build identity baked into both bundles (main + widget): short
 * commit + UTC time. Cloudflare Pages exposes the commit as CF_PAGES_COMMIT_SHA;
 * fall back to git locally. Shown in the footer / debug overlay / console so anyone
 * can see EXACTLY what's running — the answer to "am I on the latest build?".
 *
 * Reproducible builds: honour SOURCE_DATE_EPOCH (the standard reproducible-builds
 * env var, seconds since epoch). When set, the stamp is derived from it instead of
 * wall-clock time, so the same source commit always yields byte-identical bundles
 * (the publish snapshot pins it to HEAD's commit time). Unset → live wall-clock.
 */
export const BUILD_ID: string = (() => {
  const sha =
    process.env.CF_PAGES_COMMIT_SHA?.slice(0, 7) ||
    (() => {
      try {
        return execSync('git rev-parse --short HEAD').toString().trim()
      } catch {
        return 'dev'
      }
    })()
  const epoch = process.env.SOURCE_DATE_EPOCH
  const stampDate = epoch ? new Date(Number(epoch) * 1000) : new Date()
  const stamp = stampDate.toISOString().slice(0, 16).replace('T', ' ')
  return `${sha} · ${stamp} UTC`
})()
