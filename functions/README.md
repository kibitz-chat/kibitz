# Cloudflare Pages Functions

Auto-deployed by Cloudflare Pages from this `functions/` directory (separate
from the Vite app build — `tsconfig` includes only `src/`).

## `/api/turn` — robust internet relay (TURN)

`api/turn.ts` mints short-lived **Cloudflare Realtime TURN** credentials so
online calls relay media through strict/symmetric NATs instead of failing. The
long-term key stays server-side; the browser (`src/core/iceConfig.ts`) only ever
gets ephemeral credentials, and falls back to STUN-only if this isn't set up.

### One-time setup
1. Cloudflare dashboard → **Realtime → TURN** → create a TURN key (or via API —
   see the chat/notes). Copy the **Key ID** and **API Token**.
2. The kibitz **Pages** project → **Settings → Variables and Secrets** → add two
   **Secrets** (encrypted): `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`. Make sure they're
   in the **Production** scope (kibitz.chat is Production; Preview is separate).
3. Redeploy — and trigger a **fresh deployment** (push a commit, or *Create
   deployment*), not just *Retry deployment*: Functions bind secrets at build
   time and a plain retry doesn't always rebind newly-added ones.

Until both exist, `/api/turn` returns `{ "configured": false }` and the client
uses STUN-only — calls still work on permissive networks.

### Cost
$0.05 / GB of relayed egress, **first 1,000 GB/month free** (shared with SFU).
Only *relayed* media counts; STUN and direct P2P are free.

## `/api/signal` — self-hosted signaling, with health-driven failover

`api/signal.ts` tells every client which signaling broker to use — our
`signal-worker` (Cloudflare Workers + Durable Objects) when it's healthy, or the
public PeerJS broker when it isn't. The health check runs **server-side here**,
so all clients get the SAME verdict and a call never splits across two brokers
(see `src/core/signalConfig.ts`). Failover and recovery are automatic.

### One-time setup
The Pages project → **Settings → Variables** → add one plain **Variable** (not a
secret — it's a public hostname):

    SIGNAL_HOST = kibitz-signal.<account>.workers.dev   (no scheme, no slash)

after deploying `signal-worker/` (see its README). Unset → always the public
broker. Clear it to fall back instantly, no rebuild.

## Premium gating — SCAFFOLDED, DORMANT

`api/turn.ts` (gate), `api/webhook/stripe.ts` (billing webhook), and
`api/license.ts` (success-page key lookup) implement the at-cost-relay paywall.
They are **inert until you bind a KV namespace** — adding them changed nothing.

**The on-switch is the KV binding.** With no `ENTITLEMENTS` namespace bound,
`/api/turn` is open to everyone exactly as before. Bind it and gating turns ON:
only callers presenting a valid `Authorization: Bearer <licenseKey>` (the client
sends one from `localStorage` if present — see `src/core/license.ts`) get TURN;
everyone else stays on the free STUN tier.

### To go live (when you're ready to charge)
1. Pages → **Settings → Functions → KV namespace bindings** → bind a namespace as
   **`ENTITLEMENTS`**.
2. Add the secret **`STRIPE_WEBHOOK_SECRET`** (the signing secret of the Stripe
   webhook you point at `https://kibitz.chat/api/webhook/stripe`).
3. (TURN must also be configured — `TURN_KEY_ID` / `TURN_KEY_API_TOKEN`.)

### KV layout
```
lic:<licenseKey>             → { status:"active"|"canceled", plan, exp?, ... }
sess:<sessionId>             → <licenseKey>   (1h TTL — success page exchanges it via /api/license)
sub:<subId>                  → <licenseKey>   (so subscription.deleted maps back to a key)
issued:<tag>:<YYYY-MM>       → per-key credential issuances this month   (cost cap)
issued:room:<room>:<YYYY-MM> → per-room issuances this month             (sponsor blast-radius)
issued:global:<YYYY-MM>      → global issuances this month               (hard backstop)
```
`<tag>` = a truncated SHA-256 of the license key (the raw key never lands in KV
or in Cloudflare analytics); room grants meter under `r:<sponsor-tag>`.

### Flow
Checkout (hosted) → `checkout.session.completed` webhook mints a license key →
success page `GET /api/license?session_id=…` shows it → user pastes it into
Kibitz → every `/api/turn` call carries it → gate grants TURN. Cancellation
webhook flips the key to `canceled` → next call drops to free.

## Abuse controls — Cloudflare-only, SCAFFOLDED, DORMANT

Built so billing can't be abused without leaving Cloudflare for self-hosted
coturn. Each control activates only when its config is present, so you harden
incrementally; with no `ENTITLEMENTS` binding, `/api/turn` is byte-for-byte its
old open self.

| Config (Pages var/secret) | Turns on |
|---|---|
| `ENTITLEMENTS` (KV) | the gate + all metering (master switch) |
| `TURN_TTL_SECONDS` | shorter credential lifetime (default 86400 — lower it) |
| `PREMIUM_MAX_ISSUES` | per-key credential issuances/month — the cost cap |
| `ROOM_MAX_ISSUES` | per-room issuances/month — a bad guest can't drain a sponsor's whole month |
| `GLOBAL_MAX_ISSUES` | global issuances/month — runaway backstop |
| `ROOM_GRANT_SECRET` | verify sponsor room-grants (see below) |
| `ROOM_GRANT_TTL_SECONDS` | grant lifetime (default 600) |
| `ADMIN_SECRET` | enables `/api/revoke` |

**Endpoints**
- **`POST /api/room-grant` `{room}`** — the safe "opener pays". A sponsor's active
  license mints a short-lived, room-scoped, **signed** grant. They broadcast it;
  joiners send it to `/api/turn` as `X-Kibitz-Grant`, which verifies it and mints
  TURN **metered to the sponsor** — no open relay, raw key never leaves the server.
  (Replaces the unsafe `?turn=host` link, which was open-relay-or-broken.)
- **`POST /api/revoke` `{identifier}`** (Bearer `ADMIN_SECRET`) — revokes all live
  creds under a `customIdentifier` tag, so a leaked key / abusive room stops NOW.
  ⚠️ Confirm the Cloudflare revoke path in `api/revoke.ts` before relying on it.

**Why issuance counts (not GB):** your function mints creds but never sees bytes,
so it caps *issuances* — a precise, Cloudflare-only proxy (worst-case GB =
issuances × TTL × max-bitrate). Reconcile real GB against Cloudflare analytics
out-of-band. Counters are best-effort (KV isn't atomic) — a backstop, not a meter.

**Honest residual (the Cloudflare-only limit):** no per-credential bitrate throttle
and no destination limiting (those are coturn-only). So a malicious *room
participant* can still burn a sponsor's room sub-cap *fast* — but it's **capped,
attributed (customIdentifier), and revocable**, and confined to that room. Bounded
and trust-scoped, never throttled. The relay's IP-reputation hit lands on
Cloudflare, not you. If you ever need throttling/destination control, that's the
signal to run coturn for the paid tier.

> Still not built: the live checkout + success page, and the client wiring to
> request/broadcast/redeem room-grants (the server side is ready). The paste-key
> UI exists (web room page + `licenseKey` mount option).

---

## Email-code verification (`/api/email/*`) — DORMANT until configured

The universal "verify by a mailed code" method for verified rooms (docs/verification.md §4.5).
It's **our own OIDC provider**: `/start` mails a 6-digit code, `/verify` checks it and mints an
RS256 token the unchanged client verifier accepts, `/jwks` publishes the key. Every endpoint
returns `{configured:false}` until all three bindings exist — nothing changes until then.

**Endpoints**
- `POST /api/email/start` `{email, room, nonce}` → mails a code, stores only its hash in KV under
  a random `ticket`, returns `{ok, ticket}`. (`nonce` = the client's cert-binding nonce.)
- `POST /api/email/verify` `{ticket, code}` → on a correct, unexpired, under-cap code, returns
  `{ok, jwt}` (email/room/nonce come from the server record, never re-supplied by the client).
- `GET  /api/email/jwks` → the provider's public key, as a JWKS.

**Setup (one time)**
1. **Signing key:** `node scripts/gen-email-key.mjs` → `npx wrangler pages secret put EMAIL_SIGNING_JWK` (paste the line).
2. **KV:** create a namespace and bind it as `OTP_KV` (Pages → Settings → Functions → KV bindings).
3. **Mailer(s):** bind **at least one** key — the free-tier **rotation** (`src/core/mailers.ts`) uses
   whichever are present, in order, falling through as each free tier exhausts (so the free quotas
   add up). Each is `npx wrangler pages secret put <KEY>`. **Recommended: start with Resend alone**
   (simplest, best deliverability, covers the volume); add the others later only for headroom.
   - `RESEND_API_KEY` — **Resend** (≈3k/mo, 100/day free; tried first). The pick — cleanest API + domain auth.
   - `BREVO_API_KEY` — Brevo (300/day free). Solid fallback.
   - `MAILERSEND_API_KEY` — MailerSend (~3k/mo, but its free tier has tightened — needs an *approved*
     account + a verified domain, and throttles trial sends — so treat it as optional, not a reliable fallback).
   - *(MailChannels was dropped — it ended its free Cloudflare-Workers tier in 2024; Postmark/SES are paid.)*
4. **Sending domain:** add + verify `mail.kibitz.chat` in **each** provider's dashboard and add the
   DKIM/SPF DNS records it gives you to the kibitz.chat zone (the provider handles DKIM signing).
   Deliverability is the whole game for OTP — a code in spam = a failed verification.
5. **Vars** (plain, not secret): `EMAIL_FROM=noreply@mail.kibitz.chat`, `EMAIL_ISSUER=https://kibitz.chat`,
   `EMAIL_AUDIENCE=kibitz-email`.
6. **Premium / opener-pays (optional):** bind `ROOM_GRANT_SECRET` (the SAME secret as `/api/turn`) and a
   sponsor room-grant (`X-Kibitz-Grant`, from `api/room-grant.ts`) will authorize the send — so ONE
   premium key covers a room's relay AND its verification emails, metered to the opener. Unsponsored sends
   stay free; set `MAIL_FREE_MAX` (a monthly count) to backstop their cost/abuse — **dormant unless set**,
   and an over-cap unsponsored send is then refused with a "use a sponsored link" message. Sponsored sends
   are never capped here.

**Safety:** the code is mailed and only its salted hash is stored (KV, auto-expiring 10 min);
6 digits are safe because the verifier holds the secret + rate-limits (5 tries/code, soft per-email
+ per-IP send caps) — the code is **never** in the link, so there's no offline brute-force oracle.
Crypto is the SAME tested modules the app uses (`src/core/emailOtp.ts`, `src/core/emailToken.ts`).
