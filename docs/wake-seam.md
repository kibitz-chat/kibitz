# Wake — ring an installed app into a room

Kibitz can let an **external service ring an installed Kibitz PWA**: wake the device with a
notification that, on tap, drops the user straight into a room and joins the call. Kibitz provides only
the generic, **identity-blind** plumbing; an external **wake provider** supplies the directory of who
may be rung and sends the push. Kibitz never learns who is calling, who is called, or the contact graph.

> **Status: dev preview.** The push seam below is built and deployed; it is **inert** until a device is
> paired, and pairing is reachable only behind a developer unlock (see [Status](#status)). The hardened
> pairing (provider-origin allow-list, single-use nonce, QR) is not done yet.

## Why it's shaped this way

A room link is the only credential in Kibitz — there are no accounts. That is also why Kibitz, by
itself, *cannot* ring you: it has no directory mapping "a person" to "a device to wake". Adding one
naively (e.g. "ring everyone in this room") would be a privacy violation — a bearer link would become a
standing permission to wake someone's phone, with no consent and no revocation.

So Kibitz exposes only a generic, identity-blind **seam**. The *directory* — who may ring whom — lives
in an external **wake provider** that Kibitz treats as an abstract sender; it never lives in Kibitz. If
no provider is ever connected, the seam stays dormant and the anonymous floor is unchanged.

## The seam in one line

A wake provider hands Kibitz an **opaque credential** at pairing time; later the provider decides
someone may be rung and POSTs a push (room id only) to the endpoint that credential names; Kibitz's
service worker renders **"Join the room?"** and a tap joins. Kibitz only ever sees "an authorized push
said: offer to join this room id" — never the caller, the callee's identity, or the contact graph.

## What Kibitz owns vs. the provider

- **Kibitz owns the plumbing:** the push subscription, a service-worker `push` handler whose only verb
  is "offer to join a room", join-on-tap, and the pairing *client*. It is provider-agnostic — everything
  provider-specific crosses the seam as **opaque blobs** (a VAPID key, an endpoint URL, a nonce, a
  display label) that Kibitz renders or relays but never interprets.
- **The wake provider owns the policy** (out of scope for Kibitz): the contact directory, "who may ring
  whom", VAPID key custody, the single-use nonce, rate limits, and revocation. Kibitz holds none of it.

This mirrors the rest of the engine: a lower layer agnostic to whatever drives it (the way
`verifyIdentity` / `joinGate` / capability grants take opaque descriptors the engine passes through
without understanding the provider). The account-free product survives on its own.

## A — the wake seam (generic, identity-blind)

1. **Subscribe with a handed-in VAPID key.** Kibitz does not own or generate it; the provider supplies
   it so the provider's server is the only thing that can later push to the subscription.

   ```js
   const reg = await navigator.serviceWorker.ready
   const sub = await reg.pushManager.subscribe({
     userVisibleOnly: true,
     applicationServerKey: providerVapidPublicKey, // opaque bytes from the provider
   })
   ```

2. **A service-worker `push` handler** with exactly one verb — *offer to join a room*. The payload is
   **untrusted** (the provider is across a trust boundary, and may be compromised): it validates a
   versioned `{ v, kind, roomId, label }` envelope, bounds the room id, rate-limits, and **drops**
   anything off-spec. The room id rides in `data` only — never in visible title/body (no lock-screen
   leak).

   ```js
   const ROOM_RE = /^[a-z0-9-]{3,64}$/
   self.addEventListener('push', (e) => e.waitUntil((async () => {
     let m; try { m = e.data && e.data.json() } catch { return }   // bad JSON → drop
     if (!m || m.v !== 1 || m.kind !== 'wake') return               // unknown verb/version → drop
     if (typeof m.roomId !== 'string' || !ROOM_RE.test(m.roomId)) return
     // …rate-limit a flood into one "possible spam" notice…
     await self.registration.showNotification(m.label || 'Incoming call', {
       body: 'Join the room?', tag: 'kbz-wake', data: { roomId: m.roomId },
     })
   })()))
   ```

3. **Join on tap.** `notificationclick` opens (or focuses) Kibitz at `/#<roomId>`, which drops into the
   normal hash-room join flow — the device auto-joins. See [iOS routing](#ios-specifics) for the
   already-open vs. cold-launch handling.

   **The SW must NOT:** auto-join without the tap; fetch anything from the payload; execute payload
   content; or honor any field outside `{ v, kind, roomId, label }`. Payload is data, never instructions.

## B — device pairing (one-time "connect a device")

Pairing is how a wake provider claims a Kibitz install as a wake target. It runs **inside the installed
Kibitz PWA** (see [iOS](#ios-specifics)) and is the *only* moment a subscription is created.

1. The provider mints a single-use, short-TTL token and renders an opaque pairing blob as a QR:

   ```json
   {
     "vapidPublicKey": "<base64url VAPID public key>",
     "registerEndpoint": "https://provider.example/.../register",
     "nonce": "<single-use, short TTL>",
     "pairingLabel": "<display-only text naming the provider>"
   }
   ```

2. In the installed Kibitz app the user scans it (iOS can't open a PWA from a tapped link). Kibitz
   validates + **gates** the blob, shows a consent screen naming the endpoint origin + label, and only
   on confirm: requests notification permission, subscribes with `vapidPublicKey`, and POSTs
   `{ subscription, nonce }` to `registerEndpoint`. The provider verifies the nonce and stores the
   subscription against the user's device.

After this, "ring this device" is the provider POSTing a wake envelope (room id only) to the stored
subscription.

## Security (Kibitz's responsibilities)

Kibitz must uphold these regardless of provider. The provider-side duties are listed too, as the
contract Kibitz assumes — but they are the *provider's* to implement.

| Concern | Owner | Requirement |
|---|---|---|
| **Endpoint allow-list** | **Kibitz** | `registerEndpoint` must be **HTTPS** and match a hard-coded allow-list of trusted provider origins, enforced *before* any fetch, **plus** the origin shown at the consent step. (Without this the pairing is an SSRF / subscription-theft vector.) **Not yet implemented — see Status.** |
| **SW input hardening** | **Kibitz** | `try/catch` the payload parse, validate the versioned envelope, bound `roomId`, drop anything malformed (no notification). |
| **Room id only in `data`** | **Kibitz** | never in visible notification text; `label` is display text, never the raw id. |
| **No auto-join** | **Kibitz** | a wake is an *offer*; joining requires the user's tap. |
| Single-use nonce + short TTL | provider | minted, verified, burned provider-side. |
| Per-pairing VAPID rotation | provider | not a static per-account key. |
| Rate limits / "who may ring whom" / blocking | provider | the real policy; Kibitz adds a defensive SW-side flood cap only. |
| Revocation | both | provider deletes its subscription row; Kibitz `unsubscribe()`s locally on unpair. |
| No join secret in the push | provider | ring into unguessable-id rooms only; never a room password. |

**Trust boundary:** a paired provider can ring this device into any room until it is unpaired — disclosed
at the pairing consent step. Pair only with a provider you trust.

## iOS specifics

- **Web Push fires only for an installed PWA** — a browser tab cannot be woken. So pairing and the wake
  UI only make sense in the installed app.
- **A tapped link can't open an installed PWA on iOS**, so pairing must be **scan/paste *inside* the
  installed app** (the same constraint behind QR room-join; reuses `QrScanner`).
- `Notification.requestPermission()` must be called from a user gesture inside the installed app.
- `userVisibleOnly: true` is required, and silent background "invisible wakes" are blocked by platform
  policy — so every ring is a visible offer.

**Routing into the room — verified on-device matrix.** Tapping the notification must land in the room in
every app state:

| App state on tap | Path | Note |
|---|---|---|
| Cold-closed | `clients.openWindow('/#<roomId>')` | fresh launch keeps the hash → joins. |
| Locked / suspended | also cold-launch | iOS kills the app, so no window to reuse. |
| Backgrounded but alive | SW `postMessage({type:'kbz-wake-join', roomId})` → page sets `location.hash` | `WindowClient.navigate()` to a fragment-only-different URL focuses but does **not** route on iOS — message the page instead. |

(A *foreground* app suppresses the banner — the push fires the SW but iOS shows no tappable
notification; that's expected.)

## Status

Built and deployed as a **dev preview**:

- **Done:** the service worker is owned via `vite-plugin-pwa`'s `injectManifest` (so it can carry the
  `push` handler) with offline mode preserved; the `push` / `notificationclick` handlers; the pairing
  client (`src/core/wake.ts`, HTTPS-gated) + a `#wake` pairing screen reachable only behind a 5-tap dev
  unlock in Settings (so it isn't a normal-user surface); proven end-to-end on a real iPhone in every
  app state. A local test sender lives in `tools/wake-spike/`.
- **Not done (hardening backlog):** the provider-origin **allow-list** (today HTTPS-only), single-use
  nonce + per-pairing VAPID rotation, QR pairing, register retry/idempotency, an unpair UI + local
  pairing record, and persisting the SW rate-limit across worker restarts.

Until a real wake provider exists and the hardening lands, the seam ships but stays inert (no
subscription = no push possible) and the pairing surface stays developer-gated — so the anonymous,
account-free floor is exactly what it claims to be.
