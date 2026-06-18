import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { APP_VERSION, BUILD_ID } from './vite.build-id'

/**
 * Widget bundle: one self-contained classic script (IIFE) embeddable on any
 * page via <script src=".../widget.js" data-room="...">. CSS is inlined into
 * the JS (?inline import) and injected into the widget's shadow root.
 */
export default defineConfig({
  plugins: [react()],
  define: {
    // Library builds don't get this substituted automatically; React needs it.
    'process.env.NODE_ENV': JSON.stringify('production'),
    __BUILD_ID__: JSON.stringify(BUILD_ID), // shown in the widget's ?debug overlay
    __APP_VERSION__: JSON.stringify(APP_VERSION), // for the min-version kill-switch
  },
  build: {
    outDir: 'dist-widget',
    lib: {
      entry: 'src/widget/index.tsx',
      name: 'KibitzWidget',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
  },
})
