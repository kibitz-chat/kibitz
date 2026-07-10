// Stale-chunk recovery. A deploy replaces the hashed JS/CSS chunk files on the server; a tab that's been
// open since BEFORE the deploy still references the old names, so its next lazy import 404s ("Failed to
// fetch dynamically imported module") and the screen breaks — typically dumping the user back at the bare
// start URL (the landing page). Remedy: reload ONCE, which pulls the fresh index + chunks (auto-rejoin /
// the room hash put the user straight back). Guarded via sessionStorage so a genuinely missing file can't
// cause a reload loop. And it NEVER reloads out from under a live call — the failed chunk is a lazy feature,
// the call core is already loaded, so we hold the reload until the call ends (staleChunkAction → 'defer').

const RELOAD_KEY = 'kw.chunkReload'
const RELOAD_COOLDOWN_MS = 10_000

// Browser messages for a failed dynamic import / chunk load: Chrome/Firefox ("dynamically imported
// module"), Safari ("Importing a module script failed"), the SPA-fallback MIME case ("Failed to load
// module script" — the server returned index.html for a missing chunk), and webpack-style ChunkLoadError.
const STALE_PATTERNS = ['dynamically imported module', 'importing a module script failed', 'failed to load module script', 'loading chunk', 'loading css chunk']

/** Does this rejection/error look like a stale (deploy-replaced) chunk failing to load? */
export function isStaleChunkError(reason: unknown): boolean {
  if (!reason) return false
  const r = reason as { message?: unknown; name?: unknown }
  if (r.name === 'ChunkLoadError') return true
  const msg = String((typeof r.message === 'string' && r.message) || reason).toLowerCase()
  return STALE_PATTERNS.some((p) => msg.includes(p))
}

/** Reload only if we haven't already reloaded within the cooldown — else the file is truly gone and we'd loop. */
export function shouldReloadNow(lastReloadAt: number, now: number, cooldownMs: number = RELOAD_COOLDOWN_MS): boolean {
  return now - lastReloadAt >= cooldownMs
}

/** Pure recovery decision:
 *  'skip'   — reloaded within the cooldown (the chunk is truly gone → don't loop);
 *  'defer'  — a call is LIVE, so wait for it to end (never drop a call to recover a lazy feature chunk);
 *  'reload' — safe to reload now. */
export function staleChunkAction(inCall: boolean, lastReloadAt: number, now: number, cooldownMs: number = RELOAD_COOLDOWN_MS): 'skip' | 'defer' | 'reload' {
  if (!shouldReloadNow(lastReloadAt, now, cooldownMs)) return 'skip'
  return inCall ? 'defer' : 'reload'
}

// A live call is published by useCall as __kbzInCall (+ a kbz:incallchange event). A stale-chunk reload must never
// drop it: the failed chunk is a LAZY feature (the call core is already loaded), so we hold the reload until the
// call ends. Running the current build until then is safe.
const inCallNow = () => typeof window !== 'undefined' && !!(globalThis as Record<string, unknown>)['__kbzInCall']
let deferredReloadArmed = false

function doReloadNow(): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    /* storage blocked (private mode) — reload anyway (best effort, one-shot risk only) */
  }
  window.location.reload()
}

function deferReloadUntilCallEnds(): void {
  if (deferredReloadArmed || typeof window === 'undefined') return // already waiting for this call to end
  deferredReloadArmed = true
  const onCallEnd = (e: Event) => {
    if ((e as CustomEvent).detail) return // still / newly in a call — keep waiting
    window.removeEventListener('kbz:incallchange', onCallEnd)
    deferredReloadArmed = false
    doReloadNow()
  }
  window.addEventListener('kbz:incallchange', onCallEnd)
}

function reloadOnceForStaleChunk(): void {
  let last = 0
  try {
    last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
  } catch {
    /* storage blocked → treat as never-reloaded (best effort) */
  }
  const action = staleChunkAction(inCallNow(), last, Date.now())
  if (action === 'skip') return
  if (action === 'defer') return deferReloadUntilCallEnds() // reload the instant the call ends
  doReloadNow()
}

/** Install the global guard: a Vite preload-error and any stale-chunk unhandled rejection → reload once. */
export function installStaleChunkGuard(): void {
  if (typeof window === 'undefined') return
  // Vite fires this when a dynamically-imported chunk fails to (pre)load. preventDefault so it isn't also
  // re-thrown as an uncaught error — we're handling it with a reload.
  window.addEventListener('vite:preloadError', (e: Event) => {
    e.preventDefault()
    reloadOnceForStaleChunk()
  })
  // A bare `import()` that rejects (not always surfaced via vite:preloadError) lands here.
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    if (isStaleChunkError(e.reason)) reloadOnceForStaleChunk()
  })
}
