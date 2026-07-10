// Browser-side wake PAIRING — runs in the page (not the SW). It connects THIS installed
// PWA to a "Hub" so the Hub can later ring it: subscribe to Web Push with the Hub's VAPID
// key and hand the subscription back. See docs/wake-seam.md.
//
// SCOPE: this is the minimal DEV pairing used to demo the wake seam end-to-end against a
// local fake hub. The HARDENED production pairing (single-use nonce + a Hub-origin
// ALLOWLIST + QR + a consent screen) is a later phase; this path only enforces HTTPS and
// is reachable from a hidden #wake route. Do NOT promote it to a linked, default surface
// without the allowlist (a malicious Hub URL could otherwise capture the wake capability).

// Decode a base64url VAPID key to bytes for applicationServerKey. Returned as BufferSource
// because the lib types Uint8Array as <ArrayBufferLike>, which isn't assignable as-is; the
// byte-array form (not a base64 string) is the path proven to work on iOS in the spike.
const urlB64ToKey = (b64: string): BufferSource => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr as BufferSource
}

/** HTTPS-only gate (dev). Production additionally requires a Hub-origin allowlist (C-1). */
export function gateHubUrl(input: string): URL {
  const url = new URL(input.trim())
  if (url.protocol !== 'https:') throw new Error('Hub URL must be https://')
  return url
}

export interface WakePairResult {
  endpoint: string
}

/**
 * Subscribe this PWA to Web Push with the Hub's VAPID key and register with the Hub.
 * Reuses an existing subscription if present (retry-safe — never mints duplicates).
 */
export async function pairWithHub(hubBase: string): Promise<WakePairResult> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('This browser has no Web Push (on iOS, open the INSTALLED app, not Safari).')
  }
  const hub = gateHubUrl(hubBase)

  const vapidRes = await fetch(new URL('/vapid', hub))
  if (!vapidRes.ok) throw new Error(`Hub /vapid failed: ${vapidRes.status}`)
  const { publicKey } = (await vapidRes.json()) as { publicKey?: string }
  if (typeof publicKey !== 'string' || !publicKey) throw new Error('Hub did not return a VAPID key')

  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error(`Notifications ${perm} — wake needs permission`)

  const reg = await navigator.serviceWorker.ready
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToKey(publicKey) }))

  const res = await fetch(new URL('/register', hub), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subscription: sub }),
  })
  if (!res.ok) throw new Error(`Hub /register failed: ${res.status}`)

  return { endpoint: sub.endpoint }
}
