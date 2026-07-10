/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Dev-only: force the signaling broker host (e.g. `signal.kibitz.chat`) so plain
   *  `vite dev` — which has no /api/signal Function — can do real peer discovery
   *  instead of the flaky public PeerJS broker. See src/main.tsx. */
  readonly VITE_SIGNAL_HOST?: string
}

/** Build identity (short commit + UTC timestamp), injected by vite.config.ts. */
declare const __BUILD_ID__: string
/** The app's SemVer (package.json), injected by the vite configs — for the min-version kill-switch. */
declare const __APP_VERSION__: string
