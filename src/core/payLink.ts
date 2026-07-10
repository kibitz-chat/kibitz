/**
 * A payment "link" the room can carry — a web checkout URL (Stripe, PayPal, Wise…),
 * a payment URI (bitcoin:, lightning:, upi:…), or a bare Lightning invoice / LNURL.
 *
 * Kibitz only ever TRANSPORTS this string: the money moves on the provider's own
 * rail, between the payer and the provider — it never passes through Kibitz, which
 * holds no funds, no accounts, and no custody. The recipient always sees the link
 * before opening it (anti-phishing), and unsafe schemes are rejected here so a
 * "payment" can't smuggle a `javascript:` payload into the panel.
 */
export interface PayLink {
  /** What to show the payer, so they can see exactly where their money would go. */
  display: string
  /** A safe href to open. Bare Lightning invoices get a `lightning:` scheme so a
   *  wallet handles them; unsafe/unknown inputs are rejected (this returns null). */
  href: string
}

// Web links + the common payment URI schemes. Deliberately allow-listed.
const SAFE_SCHEME = /^(https?|lightning|bitcoin|litecoin|monero|ethereum|upi|paypal|cashapp|venmo|web\+[a-z0-9.+-]+):/i
// A bare Lightning invoice (lnbc/lntb…) or LNURL pasted without a scheme.
const BARE_LN = /^(lnbc|lntb|lnbcrt|lnurl)[0-9a-z]/i

/** Validate + normalize a user-entered payment string, or null if empty, over-long,
 *  or an unsafe/unknown scheme (so it can never carry `javascript:`/`data:` etc.). */
export function normalizePayLink(raw: string): PayLink | null {
  const s = (raw || '').trim()
  if (!s || s.length > 512) return null
  if (SAFE_SCHEME.test(s)) return { display: s, href: s }
  if (BARE_LN.test(s)) return { display: s, href: `lightning:${s}` }
  return null
}
