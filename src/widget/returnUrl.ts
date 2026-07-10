// A brand-gated, open-redirect-safe post-call "return" URL. The call app leaves you on its own screen after
// you hang up; a rebrand can pass `back=<url>` in the room link so the widget navigates HOME on leave (e.g.
// back to the gift dashboard the caller came from). Safety: only http(s), and only to a hostname the BUILD
// allowlisted (brand.returnHosts) — never an arbitrary URL a link supplies. Off entirely when no allowlist.
export function safeReturnUrl(raw: string | null | undefined, allowedHosts: readonly string[] | undefined): string | null {
  if (!raw || !allowedHosts || allowedHosts.length === 0) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  return allowedHosts.includes(u.hostname) ? u.href : null
}
