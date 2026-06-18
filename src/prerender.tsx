import { renderToStaticMarkup } from 'react-dom/server'
import { Landing } from './demo/Landing'

// Build-time only: render the landing to static HTML (plain Node, no browser) so
// scripts/prerender.mjs can bake it into dist/index.html's #root. We don't hydrate
// (the client uses createRoot, which re-renders), so static markup — no React
// hydration attributes — is exactly what we want. The handlers are no-ops; they're
// absent from the markup, and the client wires the real ones on load. onInstall is set
// (no-op) so the "Install Kibitz" CTA is in the static markup too; standalone is left
// off — the prerendered page is the marketing/browser view (an installed app re-renders
// to the launcher client-side).
export function render(): string {
  return renderToStaticMarkup(<Landing onStart={() => {}} onOpen={() => false} onInstall={() => {}} />)
}
