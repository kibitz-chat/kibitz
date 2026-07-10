# Phishing‑resistant invites — design note

**Status:** design / not implemented. Captures a design discussion; no code shipped (a small
`parseRoomTarget` enabler was prototyped and reverted — see *Enabler* below).
**Companions:** [threat-model.md](./threat-model.md), [verification.md](./verification.md),
[cert-binding.md](./cert-binding.md), [claimed-identity.md](./claimed-identity.md).

## Why parked (not built now)

Today the **clickable link is the right default** — it's the simplest UX, and Kibitz isn't yet a
phishing target: small, trusted audiences, no clone/typo‑squat domains in the wild, nothing
high‑value enough to be worth impersonating. Adding code‑into‑app **friction before the threat is
real** would cost adoption for no security gain. This doc exists so the solution **and the reasoning**
are ready to apply *when* phishing becomes real — not to apply now.

**Revisit when** any of these appear: the product is popular enough that **clone/typo‑squat domains**
show up (or a phishing report lands); **higher‑stakes** content/identities flow through rooms
(verified‑identity, paid, enterprise) so a successful impersonation is worth an attacker's effort; or
a specific incident forces it. The **cost of waiting is low** — the enabler is a one‑line
`parseRoomTarget` change and the whole design is captured below.

**Cheap to do early, independent of all that:** the **verified‑host ✓** (roadmap #2) adds *no*
friction — it just shows *who* hosts — so it can be habituated well before phishing is a concern.

## The problem

A room invitation is a clickable URL (`https://kibitz.chat/#room?…`). Clickable links are
**phishable**: a look‑alike/clone domain (`kibitz‑chat.evil.com`, a typo‑squat) can serve a
pixel‑identical join page and harvest the visitor's Google sign‑in or just impersonate the room.

The hard truth, and it's not Kibitz‑specific: **nothing inside a link can defend against the page
that link loads.** Once you navigate to a domain, that domain runs its own JavaScript and can fake
every on‑page trust signal. The **domain + TLS + the browser's URL bar is the only anchor**, and
verifying it is inherently the recipient's/browser's job. This is the same problem as bank links,
email links, and **Zoom links** (fake "Zoom invite" emails are a top phishing category).

So we cannot make a link self‑protecting. The realistic goals are narrower:
1. **Move the trust anchor off the domain** for people who already have the app.
2. **Establish a consistent, recognizable secure path** so the *insecure* path looks wrong.
3. Keep clear about what the link/app **can** vouch for (the host) vs **can't** (the site).

## What we already have

- **Verified‑host ✓** ([verification.md](./verification.md)) — a room can commit a Google‑verified
  host email; every peer checks it **peer‑to‑peer**, bound to the call's encryption key
  ([cert-binding.md](./cert-binding.md)), so it's un‑spoofable. Answers *"who runs this room?"* —
  but **not** *"is this the real site?"*
- **Installed‑app re‑homing** (`src/core/roomInput.ts` `parseRoomTarget`) — when you paste a
  link/code into the **installed** app, it **discards the link's origin and re‑homes the room onto
  your own trusted origin** (it explicitly refuses to graft a foreign `?query`). So opening rooms
  *via your installed app* pins you to a safe origin.
- **Low click blast‑radius** — a click lands in the pre‑join **lobby**, not auto‑joined; mic/camera
  need an explicit action *and* the browser's own permission prompt. A click can't silently expose you.

**The gap:** re‑homing is **user behavior**, not a guarantee — it only helps if the recipient
*chooses* to open the app instead of tapping the raw link. A clicked link is only ever as safe as
its domain.

## The core insight: habituation

The real value of "links open the app" (e.g. Zoom's Universal Links) is **not** that it blocks the
evil link — an evil/clone‑domain link won't trigger the app binding either, so on the evil link
itself there's no technical difference. The value is **conditioning**: because genuine links
*reliably* open the app, users build an automatic expectation, and the evil link's **failure to
match that ritual** ("why is this opening a browser asking me to sign in?") becomes a signal they
**feel without inspecting anything**.

The corollary is the indictment of an inconsistent path: a PWA where links *sometimes* open the app
and *sometimes* a browser tab **trains users to ignore** the one cue that would have saved them.
**Consistency makes the attack stand out; inconsistency destroys the signal.**

## Proposed design: invite as a *code into the app*, link as a first‑timer fallback

Distribute the invitation so the **canonical** way to join is a **code you open in the app**, not a
clickable URL. The trust anchor becomes *"the app I installed"* (on the real origin) instead of
*"the domain I navigated to."* There's no link to land on, so there's no clone to land on — and it
**works on a PWA today** (no native app required), via the existing `parseRoomTarget` re‑homing.

The invite presents (proposed wording) — note it carries **no clickable room link at all**:

```
Paste this code in your Kibitz app — new? open kibitz.chat to install (or paste it there):
<code>
```

**Order matters: all instruction first, the code LAST.** A gated room's code is hundreds–1,500+ chars,
so leading with the code would **bury the "new?" guidance** under a wall of text — and messaging apps
**truncate** long messages ("…Read more"), hiding anything after it. With one instruction line on top,
both audiences read it before the code, and any truncation cuts the *code* (which they expand to copy
anyway), not the guidance.

This is a strictly **stronger** posture than demoting a clickable link: the first‑timer path is
*"navigate to the known domain yourself and paste,"* not *"click this URL."* So even a first‑timer
**types `kibitz.chat`** (the real domain) instead of tapping a possibly‑cloned link — which closes
the first‑timer phishing gap. The **code is the one universal token**: pasted into the installed app,
or pasted on kibitz.chat after navigating there. No `https://…/#room?…` URL travels in the message.

- **Code** = the room + gate **fragment** (everything after `#`). Copy/paste‑able text — the channel
  for sending in a message; the recipient pastes it into the app (or on kibitz.chat).
- **Extracting the code** (UX detail the ordering raises): the code is long and sits *after* the
  instruction line, so the recipient either selects just the last line, or — more robustly — the join
  field accepts the **whole pasted message** and pulls the code out of the surrounding prose
  (`parseRoomTarget` would need a "find the code in pasted text" step). The latter is the friendlier
  flow and removes the fiddly select‑the‑long‑substring step on mobile.
- **No clickable room link** — replaced by a bare reference to the canonical domain (`kibitz.chat`)
  the recipient navigates to *themselves* (the safe path: you go to the domain you know).
- **QR** stays a *separate display mode* for **screen‑to‑screen / in‑person** scanning (an image, not
  copy/paste text; you can't scan your own screen).
- **Implementation implication:** kibitz.chat's **landing must make "paste a code to join"
  prominent** for first‑timers (the mechanism exists via `parseRoomTarget`; today it isn't front‑and‑
  centre).

### Code length (honest)
The code is the link **minus** the `https://kibitz.chat/#` prefix (~22 chars), no more:
- **Open room** → just the room id (`fjord-6ezatsa2ps`) — short, typeable, tiny QR.
- **Gated/verified/agent room** → carries the gate payload (`gk` pubkey, `gm` signed manifest, `gt`
  token…) — hundreds to ~1,500+ chars. **Not typeable → QR is the practical carrier.** Shortening it
  uniformly would require a **lookup service** (short id → gate descriptor on a relay), which trades
  away Kibitz's "nothing stored server‑side; the link carries the gate" property.

### Enabler (prototyped, reverted)
For a *gated* room's code to round‑trip, `parseRoomTarget`'s bare‑code branch must keep a `?gate`
suffix (today it `normalizeRoom`s it away, so only **open**‑room codes work). The one‑line change +
tests were prototyped and reverted pending the decision to build. It's safe — a bare code has no
foreign origin, so the gate is the sender's own admission material, not a cross‑origin query.

### Honest limits
- **First‑timers navigate to the domain themselves** (no clickable link) — better than a clicked
  link, since they type the known `kibitz.chat` rather than tapping a possibly‑cloned URL. But it's
  **not immunity**: an attacker writes their *own* invite message and can swap in a clone domain, so
  the win is the **habituated norm** ("a real invite is a code + go to kibitz.chat" → a variant
  looks off), not a cryptographic block.
- **Higher friction** than tap‑a‑link — by design; you lose **tap‑to‑join** (the recipient must
  navigate + paste), and the copy must make "open it in the app / go to kibitz.chat" obvious or
  people paste it into a search bar out of habit.
- **Orthogonal to the host question** — code‑into‑app proves *"real app"*; the **verified‑host ✓**
  proves *"real host."* Pair them.
- **Context‑sensitive wording** — "open the app" fits an installable PWA (kibitz.chat, kibitz.chat)
  but **not** the widget embedded on a third‑party site. So either gate the code‑first invite to the
  standalone/installed context, or use neutral wording.

## The stronger version: a native app + Universal Links

The only mechanism that makes it **link‑driven instead of behavior‑driven** is a **native app** with
**Universal Links / App Links**: Apple/Google verify the domain↔app binding (the OS fetches
`/.well-known/apple-app-site-association` / `assetlinks.json` *from* the domain), so a genuine
`kibitz.chat` link **auto‑opens the trusted app** and a clone domain **cannot claim that binding**.
This establishes the habituation baseline a PWA structurally can't. (It still doesn't stop a
clone‑*domain* link — that lands in a browser regardless — but it removes the user‑discipline gap for
legitimate links.)

**Feasibility (from the kibitz/kibitz repos):**
- **Android: nearly free.** A native WebView shell already exists (`kibitz/android/`, the galaxy
  relay) and **runs real calls** — so "does the WebRTC app work in a native WebView?" is already
  answered *yes*. Adding a verified **App Link** is an `autoVerify` intent‑filter + serving
  `assetlinks.json` on the domain (~a day) + a rebrand. Web content stays live‑updating.
- **iOS: the real work.** No iOS shell. Needs a **WKWebView** app + the `associated-domains`
  entitlement + AASA. Risk: WebRTC in WKWebView (getUserMedia works iOS 14.3+, but validate data
  channels + the **audio session / Bluetooth / background** path — exactly the iOS pain seen in the
  PWA). **Upside:** a native iOS shell unlocks **CallKit + native audio‑session control**, which
  would likely fix a class of those iOS call bugs — so it pays for itself twice (link habituation +
  call experience). Effort: ~1–3 day de‑risk spike → ~2–4 wks TestFlight w/ Universal Links + basic
  CallKit → ~4–6 wks polished/approved. Watch App Store **guideline 4.2** (thin web wrappers get
  rejected → add real native value: CallKit, push, the relay).
- **Costs (either):** Apple Developer $99/yr; Play Console $25; review latency; a second
  build/signing pipeline. But because the shell loads the live site, **web changes still hot‑update
  instantly** — only the rarely‑changing shell is re‑submitted.

## Supporting context: the OIDC/identity trust model

(Full depth in [verification.md](./verification.md) / [cert-binding.md](./cert-binding.md); summary
of why the link carries what it carries.)

- **Verification needs no server** — not Google's, not ours. The ID token's signature is checked
  **locally** in the browser (WebCrypto, RS256) against **Google's public keys (JWKS)**, fetched once
  from Google's well‑known endpoint and cached (or **pre‑pinned** for offline). No `tokeninfo`/
  introspection call, no central authority — the room/peer verifies it itself (the cert‑binding makes
  it peer‑to‑peer).
- **The `client_id` is the app anchor** (`aud`). The room checks `aud === client_id` so a token
  **minted for another site** (a `evil.com` "Sign in with Google" that also gets the user's email)
  can't be **replayed** into the room. The **email alone is not enough** — Google issues
  email‑bearing tokens to *many* apps; the client_id ties the token to *your* app.
- **`client_id` is per‑app, not per‑user** — one fixed, **public** value for the whole deployment;
  what differs per user is `sub`/`email` *inside* the token.
- **Why you "paste it once"** — Kibitz has no central server to own a Google app for you (the flow is
  browser‑side, no client secret), and a Google client is **origin‑bound** (its authorized origins),
  so there can't be one universal built‑in id. You register one (free) for your origin, or **borrow a
  trusted friend's** (it's public): works as‑is if you're on the **same origin** (e.g. both on
  kibitz.chat); on a different origin the friend must add yours to their client. They can't intercept
  (tokens are Google‑signed, delivered to *your* origin) or forge (only Google signs).
- **The cert‑binding fingerprint** is the **SHA‑256 of the connection's DTLS certificate**, taken
  from the live handshake (`RTCDtlsTransport.getRemoteCertificates()`, **not** the spoofable SDP
  line). The token's `nonce = hash(fingerprint)`, so a captured token can't be replayed onto a
  different connection (different cert → mismatch); impersonation would also need the cert's private
  key, which never leaves the browser.

## Recommendation / roadmap

1. **Now (cheap, PWA‑only):** make **code‑into‑app the primary invite** — the message carries the
   **code + "go to kibitz.chat"** for first‑timers, **no clickable room link**. Requires the small
   `parseRoomTarget` gated‑code enabler, the invite‑UI change (`copyInvite` in `Widget.tsx`), and a
   prominent **"paste a code to join"** entry on the kibitz.chat landing. Front‑end only, no agent
   rebuild. Gate the wording to the installed/standalone context.
2. **Now (cheap):** **always surface the verified‑host ✓** prominently, so its *absence* becomes the
   noticeable anomaly — habituation applied to the host question (the part a PWA *can* address).
3. **Later (bigger, optional):** a **native app + Universal Links** for the link‑driven habituation —
   Android is nearly free (the shell exists); iOS is the investment but doubles as fixing the iOS
   call experience (CallKit). Start with a short **iOS WKWebView WebRTC spike** before committing.

## Open questions / decisions

- Standalone/installed‑only code‑first invite (safe) vs everywhere with neutral wording?
- Exact wording — "the app" vs the **brand name** (Kibitz); "No app yet?" vs "First time?"
- Is the native‑app investment worth it for the habituation + iOS‑call payoff, or is the PWA
  code‑into‑app posture (+ verified‑host ✓) sufficient?
- A short‑code lookup service for gated rooms (typeable codes) — only if we accept a server holding
  admission descriptors (against the current zero‑server property).
