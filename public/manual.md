# Kibitz — product & UI manual (for people and language models)

> Source: https://kibitz.chat/manual.md · A complete map of what Kibitz does and **every control in its UI** (the web/embedded widget), across **desktop, mobile portrait, and mobile landscape**. Companion to the trust model (https://kibitz.chat/security.md, https://kibitz.chat/transparency.md) and the developer API (https://kibitz.chat/docs.md). Written so a language model can fully understand the product and, if it joins a call, know exactly what it can do and what every button means.

## What Kibitz is
Account-free, peer-to-peer, end-to-end-encrypted **"look at anything together" calls**. A room is just an unguessable **link** — open it and you're in. Audio, video, and all content (chat, shared links, screen-share, annotations) flow **directly browser-to-browser** over WebRTC (DTLS-encrypted); Kibitz's servers only introduce browsers and never see, store, or can decrypt a call. There is **no media server** and **no account**. Best for **2–6 people** (a direct mesh, not an SFU). The compiled web app is free to copy and self-host.

Mental model: it's **presence**, not meetings. A room is a *place* you carry with you, that people — or an AI agent — join by link.

## The four modes (how you enter Kibitz)
- **Web room** — go to `kibitz.chat/#<room>` (or any unguessable link). The call **widget** appears; click **Join**.
- **Embedded widget** — a site drops one `<script>` tag (`Kibitz.mount({ room })`); the same widget floats on their page. See `/docs.md`.
- **Headless engine** — `Kibitz.mount({ headless: true })` renders **no UI**; the host app draws its own tiles and drives the call through a typed controller. This is how apps and AI agents use Kibitz. See `/docs.md`.
- **Offline mode (same-Wi-Fi)** — everyone on the same Wi-Fi, **no internet**: one device runs a tiny LAN hub, others scan a QR once. (Unrelated to the TURN relay.) See `/relay.md`.

---

## Form factors at a glance
The widget lives in an **open shadow root**. **Form factor is NOT chosen by width breakpoints** — it is keyed on `orientation`, `max-height`, `pointer: coarse/fine`, and the `fill` mount option. Three "big surfaces" share one **Zoom-style** layout (bottom control bar + auto-hiding chrome + page-dots + seamless-black fill + safe-area insets): the dedicated **room window** (`fill: true`), **full screen** (a touch-only toggle), and the **Document-PiP pop-out**. The **embedded corner panel** keeps every control in its header instead.

| | **Desktop** (pointer:fine) | **Mobile portrait** (pointer:coarse) | **Mobile landscape** (pointer:coarse) |
|---|---|---|---|
| Resize | drag **any edge or corner** (mouse) — all four corners + edges, clamped to the window | **full-screen** toggle (⛶) instead | **full-screen** toggle (⛶) instead |
| Device pickers (pre-join) | mic / **camera** / speaker* | mic / speaker* (camera picker hidden — flip button instead) | mic / speaker* (camera picker hidden) |
| Pre-join layout | wide card, big self-tile, form at natural width | form **stacks below** the preview tile | short-landscape: preview LEFT, scrollable form RIGHT |
| Tiles (gallery) | `auto-fit` grid, centered | 2 → 1 col · 3 → 1 col · 4+ → 2 cols | filmstrip docks to a **right vertical column** beside the stage |
| Control bar | header (embed) or bottom bar (big surface) | header or bottom bar | header or bottom bar |
| View switch | **view button** (always, ≥2 views) | view button **+ page-dots + swipe** (touch big surface) | view button + page-dots + swipe |

\* The **speaker (audio-output) picker** only exists where `setSinkId` is available — **desktop Chromium** — and routes playback to a chosen device.

The **embedded corner panel** vs the **big "fill" room window** is the most important split: the corner panel is a small floating, draggable, ghostable bubble that keeps all controls in its header and can minimize back to a pill; the room window (and full screen and pop-out) fills its window opaque, moves the primary controls to a **bottom bar**, and auto-hides its chrome.

**Resize (embedded corner panel, desktop).** Drag **any edge or corner** — all four corners + the four edges — to stretch the box like a real window; the opposite edge stays pinned. The box is **clamped to the viewport** (it can't run off the right or bottom) and is otherwise **uncapped** (stretches up to the window). There's **no visible grip mark** — the diagonal/edge cursor on hover is the cue. The **control-bar icons and the tile avatars scale with the box** (bigger box → bigger controls and avatars), via CSS container queries. On touch the **full-screen toggle** replaces drag-resize.

---

## Setting up a room — "Set up your room" page
Reached by **Start a room**. Friendly by default: the page shows just a **Room description** field and **Create room →**, which makes an **open** room (anyone with the link). Everything else is tucked under a collapsed **⚙️ Advanced (who can join · AI agents · premium)** section. The room id is always a fresh, un-guessable code; the typed description is display-only. Secrets stay in the creator's browser; the link only carries the gate.

Inside **Advanced**:
- **📁 Load from file / ⬇ Download config** — save the whole room setup (description, who-can-join method + roster, AI agents) to a JSON file, or load a saved one, so a room configuration can be reused.

### Who can join?
- **Anyone with the link** (default) — the unguessable link is the only key.
- **Verified participants** — commit a per-invitee **roster** into the link; each participant (creator included) verifies by their own **method**, chosen per row:
  - **Sign in** — only that exact verified Google email.
  - **OIDC** — any verified Google account at a **domain** (e.g. `acme.com`).
  - **Email code** — a one-time 6-digit code mailed to that address (no account, any email). Live on kibitz.chat (Resend-backed); the code is cert-bound and verified peer-to-peer through Kibitz's own OIDC issuer (`/api/email/jwks`), the same path as Google/Microsoft sign-in. *(Self-hosting: inert until you bind the mailer backend — see `functions/README.md`.)*
  - An **"In link"** checkbox per row reveals that email/domain in the roster everyone sees before joining (off = hidden).
  - Google needs an **OAuth client id** (you paste it once; it's public and rides the link).
  - **Lock the roster with a shared secret** (optional passphrase) — seals the roster *encrypted* in the link, so neither the host nor a bare link-holder can read who's invited; joiners enter it once to unlock. Share it out-of-band.

### Room admin (host)? — the 4-tier host system
A separate chooser (see "The host system" below): **No admin · Host by name · Host by Google · Host password**. This decides *who can moderate*, independent of who can join.

### AI agents (verified rooms)
**+ Generate agent key** mints a per-agent keypair: the **public** key is committed to the room's allow-list; the **private** key is shown **once** (copy it into your agent — never stored). Each agent has a label and a **"can act"** checkbox — unticked = **watch-only** (the default); ticked grants chat/act for an agent-only or collaboration room. An agent enters by its own key — no human sign-in.

### 🛡️ Hide my IP from other people (relay-only)
A **per-browser** privacy toggle (not a room setting). When on, *your* media + data route through the TURN relay, so other participants see the relay's IP, not yours. The relay and the host still see your IP, and it can add latency, but it can't read your E2EE media/messages.

### ⚡ Premium (opener-pays), optional
A collapsible section to sponsor the room's infrastructure for everyone you invite: paste a premium **key** and the invite link carries a signed **grant** so TURN relay (and over-quota verification email) is billed to you. The key **never leaves your browser**; guests stay anonymous and free. Beta — keys are issued by request (no self-serve checkout yet).

The chosen gate is enforced by the room **authority before anyone is rostered** — an unverified/uninvited peer never appears and no one's mesh dials it.

---

## The host system (Room admin) — 4 tiers
Kibitz **decouples two roles**:
- **Coordinator** — positional, migratory plumbing: holds the room id, keeps the roster, runs presence ping/reap, relays signaling. Every room has one; it **migrates** if that peer leaves. *No discretionary powers.*
- **Host (admin)** — discretionary moderation: the waiting room (admit/deny), lock/unlock, kick, reset. Belongs to a **verified host**, NOT to whoever is currently the coordinator. This fixes the "coup" (a stranger who becomes coordinator can't seize moderation) and "bans vanish on migration".

**A room with no host committed has NO admin at all** — the host-tools icon never appears and moderation actions are inert. The tier is chosen at room creation:

1. **No admin (open)** — *default.* No one can moderate.
2. **Host by name (soft)** — commit a host **display name** (+ optional "Start with a waiting room"). Whoever joins under that name is the host. **No crypto → spoofable by any link-holder.** First-to-join holds; reclaim-by-name after the host disconnects. Best for trust-friendly rooms: "I'm first in, let the AI agent in, then admit everyone."
3. **Host by Google (OIDC)** — commit a verified **email** + a Google client id. The host **signs in** to prove the email; every peer verifies it peer-to-peer (bound to the call's encryption key). **Un-spoofable + portable** (sign in on any device; nothing stored). The room stays open — only *admin* is gated to the email.
4. **Host password (strong)** — a host key sealed under a **password** rides the link. Enter the password to **claim admin** and moderate from any seat via individually-signed commands (migration-safe, un-spoofable). Honest limit: the sealed key is in the public link, so a **weak password is offline-brute-forceable** — the create UI nudges a strong passphrase. A committed password key **disables** the name + Google tiers.

### What each role sees in the UI
- **The verified host** sees the **Host-tools icon** (🏠, with a badge for anyone waiting). No one else does.
- A **non-host while a host is committed** sees only the relevant **claim-admin affordance** (and no host tools):
  - **🔑** (password tier) → opens a **Claim admin** password dialog.
  - **🪪** (soft-name tier) → one tap adopts the host name and re-announces (claims host).
  - **🔐** (OIDC tier) → opens the **Verify** panel to sign in; a matching email auto-marks you host.
- In a **managed** room (any host/lobby/lock/verified gate active) tiles carry "· host" labels; a plain open call hides them.

---

## Joining a room — the pre-join screen
Before you're in the call, Kibitz shows a **Zoom-style pre-join screen** with a live **self-preview** (a purely-local camera/mic preview, separate from the call's media). Layout adapts: **desktop** puts a big self-tile beside the form; **portrait** stacks the form below the preview; **short landscape** puts the preview left (≈56%) and a scrollable form right. In the dedicated **room window** the header is dropped entirely — just a top-left **✕**.

### Self-preview tile and its controls
- **Self preview** — live mirrored camera video (the rear camera is shown un-mirrored), or a big initial-letter face when the camera is off.
- **Bottom of the tile**: **Mic** toggle + **Camera** toggle (preview only).
- **Top-right of the tile**: **Speaker on/off** toggle and a **Flip-camera** button (shown only while the camera is on). The pre-join speaker choice carries into the call's speaker/deaf state. *Note: the speaker toggle is a display preference — the web has no earpiece/loudspeaker routing API.*
- **ROOM** label + the room description/name.

### Device pickers (per form factor)
- **Microphone** — desktop shows it if ≥1 device exists; touch shows it only with **>1** device.
- **Camera** — **desktop only.** Phones expose many lenses, so the **flip** button covers front/rear instead of a dropdown.
- **Speaker (output)** — only where `setSinkId` exists (**desktop Chromium**), and (desktop ≥1 / touch >1).

### Consent (when the room is an AI-assisted call or carries a host notice)
Shown as up to two stacked blocks:
- **Part 1 — Kibitz AI warning** (red alert) — *"🤖 AI-assisted call (audio)"* or *"(audio + video)"*; the **audio-only** wording warns that what you **say** and the messages you send may be recorded and sent to third-party services; the **audio + video** wording adds **your camera/video**. "By joining, you consent."
- **Part 2 — host notice** (ⓘ) — verbatim text the host wrote for this room.
- Footer: *"By joining, you agree to the above."*

### Identity sign-in (when the room has verified identity)
- Once signed in: *"Signed in as &lt;email&gt; ✓"*.
- Otherwise: a **Google sign-in** button plus, where the room accepts mailed codes, a **✉️ Verify by email** button (mails a one-time code). The hint reads *"sign in to join"* if the room **requires** verified identity, else *"Optional — prove who you are so others see a verified ✓."*

### Name, Join, invite
- **Name field** (max 14 chars; remembered).
- **Join** button — its label is **Join** / **↻ Rejoin** (if you were just in this call) / **Sign in to join** (verified-only and not signed in) / **Out of date** (retired build). It appends **"(N in)"** when others are present. You enter **muted, camera off** unless you toggled them on in the preview.
- **↻ Rejoin / Start fresh instead** — after a reload/crash you see *"You were just in this call"*; Join becomes **↻ Rejoin** (one tap brings you back) and **Start fresh instead** clears it.
- **🔗 Copy invite link** — the room link (a room *is* its link).
- **Retired-build banner** — *"⚠️ This version is out of date"* with **Reload** if this build was retired for security.

### RoomPreview — "Who's in this room" (verified-roster links)
Opening a verified-roster link first shows a **Who's in this room** page: the **signed** roster (tamper-checked against the creator's key), each entry with a method badge (**✉️ Email code** / **🪪 Google sign-in**). Pick which invitee you are, then **Continue as &lt;name&gt; →** to verify. Content stays blocked until you and everyone present has proven a listed identity.

### Gated-lobby states (what replaces the join card by gate)
- **Removed** — 🚫 *"The host removed you from the room."* + Close.
- **Waiting** — ✋ *"Waiting for the host…"* + an editable name field (the host sees it).
- **Locked** — 🔐 *"This room is locked."* + Close.
- **Invite-only** — 🎟️ paste your personal **invite** link/token.
- **Name list** — 🪪 *"Who are you? Pick your name to join"* — buttons of the invited names.
- **Verified-only** — 🛡️ *"This room is for verified people."* + Google sign-in.
- **Generic refusal** — 🚪 *"The host didn't let you in."* + Close.

### Roster alarms / holds (mid-call, verified rooms)
- **Not on roster** — ⚠️ *"You're not on this room's roster"* (you signed in with an unlisted account; others won't accept content from you).
- **Compromised** — ⚠️ *"Someone here isn't on the verified roster"* + **Leave**; sharing is blocked.
- **Holding** — 🔒 *"Verifying everyone in the room…"* — sharing is paused until each peer is proven.

---

## In a call — controls
The in-call buttons live in **one of two places**: in the **header** (embedded corner panel) or in a **Zoom-style bottom bar** (`.kw-controlbar`, big surfaces). On big surfaces the **secondary** controls (verify / invite / QR / host) ride the **top title strip** so the two bars stay balanced.

### Title strip
- **Title** — in-call shows **🎙️ N** (roster count); pre-join shows *"Kibitz · &lt;room&gt;"*.
- **Minimize (–)** — collapse to the pill. **Embedded panel only** (hidden in the room window).
- **← Home / ✕** — in the **room window** the exit (`onExit`, PWA "back to home") replaces minimize.
- **Leave (✕)** — **two-tap confirm.** First tap arms it to a red **"Leave?"**; a second tap within 3s leaves. *(There is no back-arrow — it was removed.)*

### Primary control bar (left → right, with conditions)
1. **Mic** — mute/unmute (`M`; hold **Space** for push-to-talk). Off = red. A blocked-permission or device hiccup shows a brief, neutral **toast** (auto-dismisses) — *not* a lingering red banner (the on/off button already conveys the state). The red banner is reserved for fatal problems (couldn't connect, build retired).
2. **Camera** — on/off (`V`). Same transient-toast feedback as the mic for a blocked/failed toggle.
3. **Flip camera** — shown only while the camera is on (and on touch, or where a flip is possible).
4. **Speaker / "deaf"** — the **master** "mute everyone for me" toggle. Off = you hear no one (replaces the old per-tile mute/volume). Off state is red.
5. **Screen-share** (🖥️ / 🛑) — present a tab or your whole screen. **Desktop only** (where capture is possible). Starting a share in a browser tab also pops the call out to a Document-PiP window. Click again to stop.
6. **Avatar** (🙂) — open a row of voice-reactive emoji avatars (shown when your camera is off); **🔤** = use your initials.
7. **Chat** (💬) — open the chat pane; a badge shows unread lines.
8. **🤖 Agents menu** — appears whenever ≥1 agent has published an on-call action manifest. A per-viewer **checklist to show/hide** each agent's on-call menu **locally**, plus inline action **chips** for agents that chose the control-bar placement. *(This is the per-viewer menu — distinct from the host-only agent-consent panel below.)*
9. **Full screen** (⛶) — **touch only** (hidden on a mouse, where edge/corner drag-resize replaces it); not shown in the room window.
10. **View switch** (▭ / ▦ / 🚗 / ▥) — tap to cycle the available views. **Shown everywhere** (corner panel and big surfaces alike) whenever ≥2 views exist; big touch surfaces add page-dots + swipe as a position cue. The offered set is surface-specific — see "Stage & views".
11. **Ghost** (◐ / ◑) — **embedded panel only.** Makes the tile area see-through **and click-through** so you use the page underneath. A transparency slider sets the level. Another person on the **speaker stage** is see-through too (not an opaque black block), and **your own tile stays see-through even while you talk** (the "active speaker pops to full opacity" highlight is for spotting who *else* is talking, so a solo call no longer goes opaque mid-sentence).
12. **Pop-out** (⧉, Document PiP) — desktop Chrome/Edge: move the call into an always-on-top window floating over every tab and app.
13. **Video PiP** (⧉) — **Android Chrome only** (where Document PiP isn't available, and not iOS): float the active speaker over the home screen.

### Secondary controls
14. **Verify** (🛡️, the *safety code*) — open the per-person emoji code panel to rule out a man-in-the-middle. The shield turns **amber** with a **!** badge if a peer's encryption key changes mid-call. (Verifies the **media** connection.)
15. **Copy invite** (🔗 → ✓) — copy a share link mid-call. **The link depends on the surface:** the dedicated **room window** copies the WhatsApp-friendly **`/j/<room>`** path link (opens the kibitz.chat room); the **embedded widget** copies the **page it's embedded on** (e.g. `…/embed.html?room=…`) so recipients land on that page *with* the floating widget, not the full-window room. Either form can be pasted into the app's **"Open a room"** (it accepts `/j/<room>`, `#room`, a bare code, **or** an embed `?room=` link). Gated/verified or offline rooms always copy the full URL (it carries the admission params the `/j/` hop can't preserve).
16. **QR invite** — open the **📱 Scan to join** panel (a QR code + copy button) so someone nearby can scan their way in.
17. **Host tools** (🏠) — **verified host only;** a badge shows the knock count. Opens the host-tools menu (below).
18. **Claim-admin** (🔑 / 🪪 / 🔐) — shown only when a host is committed and you haven't claimed it; one of the three per the tier (see "The host system").

### Auto-hiding chrome (big surfaces)
On the room window / full screen / pop-out the title strip, bottom bar, and page-dots **fade out after ~3s idle** (and the cursor hides); any tap, pointer move, or key press reveals them. The share-nudge and dots hide with the rest.

---

## Stage & views
Call **views**, cycled in canonical order — **Car 🚗 · Speaker ▭ · Gallery ▦ · Strip ▥** — with **Speaker the default** (a fresh first join always starts in Speaker; the choice is otherwise persisted). The **offered set is surface- and device-specific**:
- **Speaker** — always offered.
- **Gallery** — needs ≥2 people (it's identical to Speaker when you're alone).
- **Car** — **touch + a "car surface" only** (the dedicated room window / installed app you'd prop up while driving); never the embedded widget, never desktop.
- **Strip** — the **embedded widget only** (a compact row of tiles); the room window uses Car instead, so Strip there is just swipe clutter.

So a touch **room window** in a group offers Car · Speaker · Gallery; the **embedded widget** offers Speaker · Gallery · Strip. Switch with the **view button** (shown everywhere with ≥2 views); big **touch** surfaces also let you **swipe** left/right and show **page-dots** as a position cue. **Page-dots are touch-only** — desktop relies on the view button (the dots would just be clutter where you can't swipe). In **mobile landscape** the dots are pinned **bottom-centre** (the stage becomes a side-by-side row, so a naive flow would have parked them on the right).

- **Speaker view** — one big **focus tile** (the sticky active speaker) plus a small **face strip**. A **presenter forces the stage** (their screen).
- **Gallery view** — an even grid of all tiles.
- **Strip view** (embedded widget) — a single compact **row of tiles**; the control bar sits **in-flow directly below the row** (not floating at the foot of an empty box), and the tiles **scale with the box** as you stretch it.
- **Car / driving mode** — hides all video; shows who's talking and a **giant round mic button** (drive-safe). It also claims the OS "Now Playing" media session so a car/Bluetooth head unit's transport controls can pause the call.

### Screen-share stage
A screen/tab share promotes that person to a big **letterboxed** stage (`object-fit: contain`, so a shared tab is fully visible); everyone else drops to a face strip.
- **Pinch-zoom + pan, 1–4×** on the shared screen, with a **⤢ 1×** reset chip and **double-tap to reset**.
- **Ink / annotation** — a shared **laser pointer + freehand** draw, **only over a shared screen**, live and ephemeral. The ink rides the *same* zoom transform so annotations stay pinned to the pixels.

### Tiles (per remote person)
Each tile shows the person's video or avatar/initial, their **name**, and the items below. The **avatar emoji/initial and the name scale with the tile size** (CSS container units) — they fill a big solo/stage tile and shrink in a small one, instead of staying a fixed size. A picked emoji avatar renders as a **vendored Twemoji SVG** so it looks **identical on every device** (Apple/Google/Windows emoji fonts otherwise differ) — in the tiles **and** the floating Video-PiP tile (drawn to its canvas); a name-initial stays plain text. The avatars work offline (no CDN).
- **🤖 AI** tag for an agent; **✓** for a verified identity; **· host** chip for the host.
- A **direct vs. relay** connection dot (with RTT / packet-loss in its tooltip).
- **Remove** (🚫) — **host only:** remove that person; their token is blocked from rejoining, and a verified email is durably banned (surfaced as the host menu's "🚫 N banned").
- **Self tile:** a live mic-level wave and (camera on) a flip-camera button.
- **No per-tile mute button or volume slider** — the **speaker/"deaf"** master toggle handles all remote audio. (The headless `Tile` still accepts `muted`/`sinkId`, driven by that master toggle, not per-tile UI.)
- **Kibitzers** (unseen agents/observers) get **no tile** but their audio still plays (also muted by speaker-off).

### Pop-out vs PiP
- **Document-PiP pop-out** (desktop Chrome/Edge) — the whole room in an always-on-top window over every app.
- **Video PiP** (Android Chrome) — just the active speaker floating over the home screen. **iOS doesn't support either** for a live call.

---

## Panels

### Chat
- **Messages** — peer-to-peer and ephemeral; only people here right now see them, nothing is stored.
- **To: Everyone ▾** — a recipient picker; choose a person to send a **🔒 private** direct message (point-to-point, tagged "· private"); default is the whole room.
- **💳 Pay** — a button in the chat input row opens an inline form to share a "pay me" **link + a note**; recipients get a card with the link + **QR**. Kibitz only carries the link — it never touches funds; it can be directed to one person.
- **Message field** + send (➤). The input is **disabled while the roster is verifying or blocked** (the placeholder says why).

### Verify (safety code)
Per-peer **emoji SAS** from the real DTLS certs to rule out a MITM; a key-change shows a ⚠️ warning. Verified-identity rows replace the emoji ritual with a ✓; you can sign in inside the panel. Honest scope note: it **verifies the media connection**.

### Host-tools menu (verified host only)
Opened from the 🏠 icon — these are **on demand**, not a permanent bar:
- **🪪 Verified people only ↔ Guests allowed** (only when identity is on) + an editable **guest-email allow-list** (add/remove).
- **🔓 Anyone with the link ↔ 🔒 Approving joiners** — the knock-to-admit lobby toggle.
- **🔐 Lock room / Locked** — seal it to new people (those already in can still reconnect).
- **🚫 N banned / Clear** — durable email bans, with a one-tap clear.
- **Knock queue** — each waiting person with **Admit / Deny**.
- *(No "reset/clear chat" button — chat is ephemeral; `resetRoom()` remains a controller method only.)*

### Claim admin (password tier)
A dialog with a **Host password** field and **Claim admin** button; a wrong password shows *"That password didn't work."*

### Agents — two distinct surfaces (don't conflate)
- **🤖 Agents menu** (control bar, **any viewer**) — locally show/hide each agent's on-call menu + use its inline action chips. This does **not** grant capabilities.
- **🤖 Agent consent panel** (**host only**, in-call) — per-agent capability toggles: **perceive** (see-screen / hear-audio / read-chat / see-who's-here / receive-directed) and **act** (post-chat / speak / act-control), a **revoke** control, and a live **audit feed** of blocked acts and changes. Agents start **read-only**.

---

## Capability catalog (everything Kibitz does, one line each)
- **E2EE media** — direct browser-to-browser audio/video (DTLS-SRTP); no SFU/media server.
- **Peer-to-peer data** — chat, directed `sendTo`, "pay me" links, app messages, and annotations go directly between each pair of browsers; no participant relays content.
- **Screen-share** — present a tab or your whole screen from the widget (desktop); viewers watch from a plain link, nothing to install.
- **Pinch-zoom + pan (1–4×)** on a presenter's shared screen, double-tap to reset; ink stays pinned.
- **Shared annotation** — laser pointer + freehand draw on the presented stage, live and ephemeral.
- **Chat + private DMs** — room chat plus point-to-point private messages to one person.
- **Transport-only payments** — share a pay link + QR; Kibitz never touches money.
- **Safety code (SAS)** — compare an emoji code from the real DTLS certs to rule out a MITM; amber alarm if a key changes.
- **Knock-to-admit lobby**, **lock room**, **kick + block-rejoin** — host entry control + moderation.
- **The 4-tier host system** — No admin / by name / by Google / by password, with claim-admin affordances (🔑 / 🪪 / 🔐).
- **Speaker / "deaf" master mute** + **keyboard shortcuts** (M / V) + **push-to-talk** (Space). *(Per-tile mute/volume were removed.)*
- **Connection diagnostics** — direct-vs-relay badge, RTT, packet loss.
- **Auto-rejoin** after a reload/crash; **invite via link or scan-to-join QR**.
- **Views** — Speaker / Gallery / **Car (driving) mode** + swipe + page-dots; **ghost** (see-through/click-through, embed only); **full screen** (touch); **Document-PiP pop-out** (desktop) and **video-PiP** (Android).
- **Per-form-factor layout** — desktop resize grip vs touch full-screen; camera picker desktop-only; header vs bottom bar; portrait tile stacking vs landscape side column.
- **Offline mode** — same-Wi-Fi rooms via a tiny self-hosted LAN hub (no internet).
- **Verified identity (opt-in)** — bind a real identity (Google via OIDC, or **email code**) to the call, checked **peer-to-peer**; **off by default** so Kibitz stays account-free unless a host turns it on (`verifyIdentity` mount option, see /docs.md §2a).
- **Verified / gated rooms** — set who may enter **at room creation** (name list · signed invites · **email-mailed code** · Google/OIDC), enforced at the authority **before** rostering; a **RoomPreview** page shows the signed roster first; an optional **roster passphrase** encrypts the roster in the link.
- **Hide my IP (relay-only)** — a per-browser toggle to route your media/data through TURN.
- **Participant capabilities** — every participant carries a grant of what it may **perceive** — `see-screen`, `hear-audio`, `read-chat`, `read-roster`, `receive-directed` — and **act** — `send-chat`, `speak`, `act`. **Humans default to full; agents default to read-only**. The **engine enforces** it per-peer.
- **Agent consent + audit** — the host's **🤖 Agents** consent panel; the per-viewer **🤖 Agents menu** is separate.
- **Premium / opener-pays** — a room opener can sponsor TURN relay (and over-quota email) via a signed grant in the invite link; the key never leaves the opener's browser and guests stay free/anonymous.
- **Embeddable** (one `<script>`) and **headless/composable** (drive the whole call as an API).
- **Agents** — an AI can join a room as another participant (see below).

## Driving it programmatically (summary — full reference at /docs.md)
- `Kibitz.mount({ room, startOpen?, headless?, fill?, identity?, meta?, verifyIdentity? })` → a controller.
- **State/people:** `getState()`, `getParticipants()` (each: `id, name, isSelf, camOn, speaking, stream, meta, role`).
- **Controls:** `join({mic?,cam?})`, `leave`, `toggleMic`, `toggleCam`, `flipCam`, `shareScreen`, `shareTrack`, `stopShare`, `setName`, `setAvatar`, `setMeta`.
- **Content (peer-to-peer):** `broadcast(msg)`, `sendTo(id, msg)`, `onMessage(cb)` — shared state / app messages / directed messages over the call's data channel.
- **Host/lobby:** `setLobby`, `admit`, `deny`, `remove`, `setLocked`, `resetRoom`, `getKnocks`, `knock` (moderation requires being the verified host).
- **Capabilities (host):** `getCapabilityGrant(id)`, `setCapabilityGrant(id, grant|null)`, `getAgentAudit(id)`.
- **Verified identity:** `signInIdentity(el, 'google'|'email')`, `identityNonce()`, `provideIdentityToken(jwt)` — inert unless `verifyIdentity` is set.
- **Events:** `on('participants' | 'join' | 'leave' | 'speaking' | 'state' | 'knocks' | 'lobby', cb)`.
- `identity` (a stable per-user/seat id) makes reconnects dedupe and powers resume; `meta` is opaque app data Kibitz never reads but carries on the roster so your app can map a participant to its own user.

## Trust & limits (full detail at /security.md, /transparency.md)
- **End-to-end encrypted; nothing recorded.** Keys live only in the browsers; no server can decrypt. The safety code lets you verify it yourself.
- **What a participant (human or agent) can see:** the shared *pixels* (a shared tab/screen), chat, and voice of the room — **not** your other tabs, DOM, forms, cookies, or history.
- **Identity is ephemeral and self-asserted by default** (names aren't verified). Attribution is by the unspoofable roster; the safety code proves you're talking to the same key. Optional **verified identity** (Google/OIDC or email code, bound to the call's encryption key, checked peer-to-peer) adds a trustworthy ✓, but it's **off by default** and host-enabled.
- **Limits:** best for 2–6 people (mesh); *presenting* a screen/tab needs a desktop browser (anyone can *watch* from a link, on any device).
- **iOS note:** the **pre-join preview** grabs the camera/mic locally first (a purely-local preview). When you tap **Join**, Safari asks for **microphone permission** (a quirk of how iOS unlocks the WebRTC connection) — you still join **muted** unless you turned the mic on in the preview, and granting it transmits nothing until you unmute. Deny it and the call can't connect on iOS. Android/desktop don't prompt until you first unmute. iOS does not support Document-PiP or video-PiP for a live call.

## For a language model acting in a call
If you join a room as a participant (via the headless engine or as an invited agent), you're governed by the **capability layer** — and an agent (tagged `meta.role='agent'`) starts **read-only by default**: you perceive **chat, the roster, and data directed at you**, but you receive **no audio and no screen share**, and you can **post nothing**, until the host grants more in the **🤖 Agents consent panel** (a host-only surface — distinct from the per-viewer 🤖 Agents menu that any human uses to show/hide your on-call chips). This isn't an honour system — the engine enforces it per peer (withheld media never reaches you; anything you try to send while un-granted is dropped by every other participant and logged to the host's audit). Be honest about your **backend/egress** (set `backend` when you create the agent) so the host can consent knowing what you see leaves the encrypted room. You **cannot** see anyone's other tabs, DOM, cookies, or history — only the pixels they chose to cast. Every participant is visible in the host's panel and can be removed or revoked at any time. When granted, you act the same ways a person does: chat (`say`/`broadcast`), message one peer (`sendTo`), read the roster (`getRoster`/`getParticipants`). A working example is the Whist "kibitzer" (https://github.com/kibitz-chat/whist, `tools/kibitzer`); the full agent model is at /docs/agent-platform.
