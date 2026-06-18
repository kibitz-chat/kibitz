/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { APP_VERSION, BUILD_ID } from './vite.build-id'

// White-label PWA identity (the installed-app name, theme, title, og), from build-time env with
// Kibitz's own defaults. A sibling brand supplies these (and overlays its own icon files at the same
// paths) from its repo — see src/brand.ts for the matching in-app strings. No sibling values here.
const BRAND_NAME = process.env.VITE_BRAND_NAME || 'Kibitz'
const BRAND_SHORT = process.env.VITE_BRAND_SHORT_NAME || BRAND_NAME
const BRAND_THEME = process.env.VITE_BRAND_THEME_COLOR || '#0b3d2e'
const BRAND_DESC =
  process.env.VITE_BRAND_DESCRIPTION ||
  'Video calls that hang over whatever you’re doing — works on a LAN with no internet.'
const BRAND_TITLE = process.env.VITE_BRAND_TITLE || `${BRAND_NAME} — look at anything together, anywhere on the web`
const BRAND_URL = process.env.VITE_BRAND_URL || 'https://kibitz.chat'
const IS_REBRAND = !!process.env.VITE_BRAND_ACCENT // a sibling product (signalled by its own accent)

// Rewrite the static index.html head/no-JS fallback to the brand. The title + og:title default to
// this product's exact values (no-op for the default build). For a REBRAND we also rewrite the shared
// meta description / og / no-JS block, so a sibling ships none of this product's copy; the default
// build's index.html is left untouched.
const brandHtml = {
  name: 'brand-html',
  transformIndexHtml(html: string) {
    html = html
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${BRAND_TITLE}</title>`)
      .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${BRAND_NAME}$2`)
    if (IS_REBRAND) {
      html = html
        .replace(/(<meta name="description" content=")[^"]*(")/, `$1${BRAND_DESC}$2`)
        .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${BRAND_DESC}$2`)
        .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${BRAND_URL}$2`)
        .replace(
          /<noscript>[\s\S]*?<\/noscript>/,
          `<noscript><h1>${BRAND_NAME}</h1><p>${BRAND_TITLE}.</p><p>Please enable JavaScript to start.</p></noscript>`,
        )
    }
    return html
  },
}

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID), __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [
    react(),
    brandHtml,
    // Cache the app shell so Kibitz loads with NO internet after one online visit
    // — the whole point of offline LAN mode (a plane, a dead-zone cabin, an
    // internet-less Wi-Fi). The relay handles the call; the SW handles the page.
    VitePWA({
      // 'prompt' (not 'autoUpdate'): a new deploy no longer silently swaps the
      // code under an open tab (which left you unsure what you were running).
      // Instead src/pwa.tsx shows an "update available — reload" banner you control.
      registerType: 'prompt',
      injectRegister: false, // we register manually in src/pwa.tsx (for the banner)
      // injectManifest: we own the service worker (src/sw.ts) instead of generating it, so
      // it can carry a Web Push `push` handler later (the wake seam — see docs/wake-seam.md).
      // src/sw.ts re-implements, by hand, exactly what generateSW did for free (precache +
      // the navigation fallback with its denylist) so OFFLINE MODE is unchanged.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png'],
      manifest: {
        name: BRAND_NAME,
        short_name: BRAND_SHORT,
        description: BRAND_DESC,
        theme_color: BRAND_THEME,
        // Launch-splash background — cream, to match the light launcher/landing it splashes into.
        // (It does NOT paint the live drag-resize edge: that's the browser's own themed window
        // surface, which no page/manifest value can recolor — so we keep the splash light.)
        background_color: '#faf6ef',
        display: 'standalone',
        start_url: '/',
        // Lets navigator.getInstalledRelatedApps() recognize OUR OWN PWA (relative → same
        // origin, so it works on any deploy), so the home page can swap "Install" → "Open in app".
        related_applications: [{ platform: 'webapp', url: '/manifest.webmanifest' }],
        // PNG 192 + 512 (and a maskable 512) — Chrome requires these to consider the app
        // installable (it won't fire beforeinstallprompt on an SVG-only manifest).
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        // Precache the built shell; src/sw.ts falls navigations back to it offline.
        // (The navigateFallback + denylist that used to live here are now IN src/sw.ts,
        // because injectManifest hands navigation routing to the worker we own.)
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
  test: {
    environment: 'node', // core tests are pure functions — no DOM needed
    // src/ holds the engine/app tests; functions/ holds the Cloudflare Pages Functions (edge) tests.
    // (Request/Response/crypto/btoa are Node globals, so the edge handlers run under the node env.)
    include: ['src/**/*.test.ts', 'functions/**/*.test.ts'],
  },
})
