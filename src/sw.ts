/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { parseWakeEnvelope } from './core/wakeEnvelope'

// This file is the SERVICE WORKER. It is built SEPARATELY by vite-plugin-pwa
// (strategies: 'injectManifest') and is EXCLUDED from the app's tsc (tsconfig.json) —
// it runs in a worker context, not the DOM. It re-implements, by hand, exactly what the
// previous generateSW config did for free, so OFFLINE MODE is unchanged:
//   • precache the built app shell (the __WB_MANIFEST list injected at build time), so
//     Kibitz loads with NO internet after one online visit (the whole point of LAN mode);
//   • fall navigations back to the precached /index.html when offline …
//   • … EXCEPT the real static pages + the server-routed /j/ share link, which must hit
//     their own files / Cloudflare Functions and never the SPA shell (so they stay
//     crawlable and /j/<room> still 302s to the room instead of landing on the homepage).
//
// Owning the SW is what lets a Web Push `push` handler land here later (the wake seam —
// see docs/wake-seam.md). Until that ships, this file is a faithful port of generateSW,
// nothing more.

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>
}

// Precache the shell injected at build time; drop precaches from older workbox versions.
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// Navigation fallback to the precached app shell. Keep this denylist in LOCKSTEP with the
// old workbox.navigateFallbackDenylist — these routes serve their own content, not the SPA.
// A rebrand can ship its own static pages (served from their own files, never the SPA) by listing
// their path prefixes in VITE_BRAND_PAGES (comma-separated, e.g. "agent"). The default product adds
// none, so its denylist is unchanged.
const brandPages = ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_BRAND_PAGES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => new RegExp('^/' + p.replace(/[^a-z0-9_-]/gi, '')))
const denylist = [/^\/privacy/, /^\/terms/, /^\/help/, /^\/relay/, /^\/security/, /^\/embed/, /^\/docs/, /^\/manual/, /^\/extension/, /^\/j\//, ...brandPages]
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist }))

// 'prompt' update flow (registerType: 'prompt' + src/pwa.tsx): do NOT auto-activate a new
// SW under an open tab — wait until the page's UpdateBanner calls updateSW(true), which
// posts SKIP_WAITING here. This preserves "what's on screen is what's running".
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

// --- Wake push (the wake seam — docs/wake-seam.md) --------------------------------------
// The ONE verb: a push says "offer to join room X". The payload is UNTRUSTED (the Hub is
// across a trust boundary) — parseWakeEnvelope validates a versioned {v,kind,roomId,label}
// and drops anything off-spec. The room id rides in `data` ONLY, never in visible text
// (no lock-screen leak). A flood is collapsed into one "possible spam" notice.
const recentWakes: number[] = []
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data: unknown
      try {
        data = event.data ? event.data.json() : null
      } catch {
        return // malformed JSON → drop
      }
      const env = parseWakeEnvelope(data)
      if (!env) return // off-spec / wrong verb → drop silently

      const now = Date.now()
      while (recentWakes.length && now - recentWakes[0] > 60_000) recentWakes.shift()
      recentWakes.push(now)
      if (recentWakes.length > 3) {
        await self.registration.showNotification('Kibitz', {
          tag: 'kbz-wake-spam',
          body: 'Multiple call attempts — possible spam.',
        })
        return
      }

      await self.registration.showNotification(env.label || 'Incoming call', {
        body: 'Join the room?',
        tag: 'kbz-wake',
        data: { roomId: env.roomId },
        actions: [{ action: 'join', title: 'Join' }],
      })
    })(),
  )
})

// Tapping the notification opens (or focuses) Kibitz AT the room — /#<roomId> drops into
// the normal hash-room join flow (App.tsx hashRoom()), so the device auto-joins.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const roomId = event.notification.data?.roomId
  if (typeof roomId !== 'string' || !/^[a-z0-9-]{3,64}$/.test(roomId)) return // re-validate
  event.waitUntil(
    (async () => {
      const origin = self.location.origin
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = wins.find((w) => {
        try {
          return new URL(w.url).origin === origin
        } catch {
          return false
        }
      })
      if (open) {
        // The app is already open. WindowClient.navigate() to a fragment-only-different URL
        // does NOT reliably route on iOS (it focuses but stays put), so MESSAGE the page to
        // go to the room — App.tsx sets location.hash → hashchange → join. Then focus it.
        open.postMessage({ type: 'kbz-wake-join', roomId })
        try {
          await open.focus()
        } catch {
          /* focus can reject if not allowed — the message still routed it */
        }
        return
      }
      // Not open: a fresh launch at /#<roomId> routes via App.tsx's launch path (hashRoom()).
      return self.clients.openWindow(`/#${roomId}`)
    })(),
  )
})
