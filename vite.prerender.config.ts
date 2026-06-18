import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { APP_VERSION, BUILD_ID } from './vite.build-id'

// Builds the landing → static-HTML renderer (src/prerender.tsx) into a tiny Node
// SSR bundle. NO PWA / no client assets — scripts/prerender.mjs runs this at build
// time and injects the result into dist/index.html. The widget is loaded lazily in
// Landing, so it isn't executed here (Node has no WebRTC).
export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID), __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [react()],
  build: {
    ssr: 'src/prerender.tsx',
    outDir: 'dist-ssr',
    emptyOutDir: true,
    rollupOptions: { output: { format: 'es', entryFileNames: 'prerender.js' } },
  },
})
