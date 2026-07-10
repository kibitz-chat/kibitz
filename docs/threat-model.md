# Kibitz Threat Model

What Kibitz protects, what it doesn't, and who can see what. Honest by design.

> Companions: [architecture.md](./architecture.md) (the planes),
> [verification.md](./verification.md) (admission security).

---

## 1. Assets

- **Call content** — audio/video/screen, and data (chat, co-browse, directed messages).
- **Identity** — that a participant is who they claim (a verified email; a genuine peer, not a
  machine-in-the-middle).
- **Membership** — who is allowed into a room.
- **Moderation authority** — who may lock/unlock, kick, and admit/deny from the waiting room.
  This is the *host* (admin), distinct from membership and from the coordinator (see §2).

## 2. The trust model

| Component | What it is | What it can see |
|-----------|-----------|-----------------|
| **Media plane** | full WebRTC mesh, **DTLS-SRTP** | nothing in the clear leaves the browsers; no media server |
| **Data plane** | peer-to-peer **DTLS** data mesh | content goes browser→browser; **no participant relays it** |
| **Signaling broker** | `signal.kibitz.chat` (stateless) | **presence metadata** only — connection events, room ids, ephemeral peer ids; **not content** |
| **TURN relay** | Cloudflare Realtime (when direct fails) | encrypted packets + IPs; **cannot decrypt** the call |
| **Coordinator** | a *participant's browser* (migratory) | room content it's *granted* (it's in the room) + coordinates presence/gate + distributes the capability grant map. **No discretionary powers** — it relays signaling and host commands, it doesn't author them. |
| **Host (admin)** | a peer that *proves* the room's host credential | may lock/kick/admit. Its `mod` commands are **signed, room-bound, cert-bound, fresh, and replay-guarded** (a per-command `jti` the verifier LRU-dedups) (`hostKey.ts`), so even a malicious coordinator can't forge or replay them. An **open room has no host** at all. |

The headline property: **there is no server that can decode or record a call.** Content is
E2E-encrypted between browsers; the edge helpers are content-blind. There is nothing central
to subpoena, record, or shut down mid-call.

And just as no server can *read* a call, **no server can *eject* anyone from one** — there is no
central power to wield. Enforcement is **per-peer and sender-side**: each honest browser simply
**refuses to share** its media and data with a peer it can't verify (and the gate refuses an
unverified joiner *before* rostering). A peer that fails the check stays connected to *nothing useful*
— it's **starved, not kicked**. This makes enforcement **distributed and fail-closed**: there's no
central point to compromise, and the default on "I can't verify you" is *nothing*, never the real
content. The irreducible edge: **you can always deny a peer, but you can never force *another* peer to
deny them** — which is exactly why collusion (§4) is out of scope.

Note the **coordinator/host split.** The coordinator is positional, migratory plumbing — it
holds the room id, keeps the roster, runs presence ping/reap, and relays signaling; it has *no*
moderation powers of its own. The host is a *verified* peer who holds a discretionary credential
(see §4). This decoupling is deliberate: it stops a stranger who happens to become coordinator
from seizing moderation, and it means bans don't vanish when the coordinator role migrates.

## 3. What is protected

- **Confidentiality of content** against the network and our own infrastructure — media and
  data are E2E-encrypted; the broker and TURN can't read them.
- **Connection authenticity** — the **safety code (SAS)**, derived from the real DTLS cert
  fingerprints, lets a pair detect a machine-in-the-middle out-of-band; a changed key alarms.
- **Identity** — opt-in OIDC, **cert-bound** so a token can't be replayed over another
  connection, verified peer-to-peer against the provider's keys (no Kibitz identity server).
- **Admission** — the [verification gate](./verification.md): unverified/uninvited peers are
  refused **before rostering**, so they never appear or learn anyone's media id.

> These authenticity/identity properties stop a **deceiving middle** — a machine-in-the-middle or an
> impersonator. They do **not** stop two **willing** parties from colluding (§4): verification proves
> *identity*, not *honesty*. Concretely on the MITM question: **who can MITM you?** In a **verified
> room — nobody** (cert-binding forbids it, §5; not even the operator). In an **open room**, only
> whoever *relays your setup* (a coordinator, or the broker we run) can *try* — and the **safety code
> catches them**. So it's *prevented* when verified, *detectable* when open — never silently possible.

## 4. What is *not* protected (scope boundaries)

These are inherent to a P2P, in-room model — stated plainly:

- **The authority's *power*, not its identity, is the trusted part — and it's reducible.**
  The authority is a participant's browser. It **cannot** read content (E2E mesh, no relay) or
  forge an identity (the verified badge + safety code are checked **peer-to-peer**, not via the
  authority) — so "trusted host" never meant it can spy or impersonate. By default it is only
  trusted to *coordinate presence* and *run admission*: a tampered authority could mis-roster
  or admit an off-policy peer. The **[verified-roster mode](./verification.md#7-verified-roster--no-privileged-host-optional)**
  removes the admission trust — a signed manifest in the link plus *mutual, pre-share*
  verification (every peer checks every peer, **the host included**, before content flows) means
  a malicious authority can't admit an off-manifest peer (everyone rejects it and **refuses to
  share** with it) or host without proving a listed identity (the first arrival checks it). This
  is **built and enforced for the cert-bound OIDC path** (`rosterGate.ts` → the `useCall`
  content gate): a peer's proof is bound to its DTLS cert, so it can't be replayed. With *signed
  invites* the roster still gates the **door** but the bearer token isn't cert-bound — so the
  peer-to-peer "refuse to share" step is OIDC-only until invites carry per-guest keys. What stays
  irreducible
  is **connectivity coordination / denial of service** (someone must route signaling; the role
  migrates) and **non-cryptographic** methods (a shared name/code is only as good as who
  checks it).

  On that irreducible piece: the signaling broker is **content-blind and cannot MITM** (cert-binding
  defeats a tampered fingerprint, §5), so its *only* real power is **availability** — it can refuse to
  route, be taken down, or be geo-blocked. That makes **multiple / fallback signaling brokers** worth
  doing — but as a **resilience (anti-DoS, anti-censorship) move, not an integrity one**: more brokers
  don't add MITM protection cert-binding already gives you, they remove the single chokepoint. The broker
  is stateless, so running several adds uptime without adding trust surface.
- **Host admin is a key, and the key rides the link.** When a room commits a host credential, a
  peer claims admin by *proving* it, and every `mod` command is then **signed, room-bound,
  cert-bound to the signer's live DTLS fingerprint, and fresh** (≤120s) before the coordinator
  enacts it (`hostKey.ts` `verifyHostCommand` → `room.ts` `handleMod`/`enactMod`) — so even a
  malicious *coordinator* can't forge moderation; it verifies
  against the **link-committed host public key**, and an open room (no committed key) drops every
  command (the `!committedHostKey` early return in `handleMod`). The credential tiers differ in strength:
  a **password key** (`gh`/`ghk`, ECDSA P-256 sealed under a host password) is un-spoofable and
  migration-safe, but **honest limit: the sealed key rides the public link, so a weak host
  password is offline brute-forceable** (PBKDF2 only slows it — there's no server to throttle; the
  HONEST LIMIT comment in `hostKey.ts`) — use a strong passphrase; an **OIDC email** host (`gho`) is
  un-spoofable and portable (proven by a cert-bound ID token, `room.ts` `declareHost`); a **soft
  name** (`ghn`) has **no crypto** and is spoofable by any link-holder. The coordinator stays
  trusted for the *roster*; the host's *powers* are gated by the committed key/email/name.
- **Cross-call key-change alarm (SSH-style TOFU).** When you explicitly verify a contact (compare
  the safety code), Kibitz pins their cert fingerprint against their name; on a later call a
  *different* key for that name raises a man-in-the-middle alarm — the SSH "host identification
  has changed" behaviour (`safetyPins.ts`, `pinStatus` → `'mismatch'`).
  Honest limits: the pin is keyed on a **self-asserted name** (not a cryptographic identity — for
  that, use a verified room), and it is established only on an **explicit verify**, so a
  man-in-the-middle present from the very first call can't auto-pin itself (see the "Honest limits"
  header comment in `safetyPins.ts`).
- **By default, anyone admitted to a room sees that room's content.** Membership is the
  baseline boundary. Two things narrow it: an app can host-tailor a per-participant projection
  (e.g. hidden hands — see [agent-platform.md](./agent-platform.md)), and the
  **[capability layer](./architecture.md#6-participant-capabilities)** withholds content per
  peer by grant — a read-only agent (or any peer the host scopes down) receives **no media and
  only the chat/roster/directed data it's granted**, enforced sender-side in the mesh. What
  membership does *not* give you is per-peer hiding from a peer you've granted full perception,
  or defense against a peer that records what it is legitimately shown (endpoint trust).
- **Metadata at the edges.** The broker sees who connects to which room id and when; TURN (if
  used) sees encrypted traffic and IPs. Use an unguessable room id; presence ≠ content. An
  optional per-browser **"hide my IP"** toggle (`relayPref.ts`) mounts the call `relayOnly` so
  other *participants* see the TURN relay's IP instead of yours — but **honest limit: the relay
  (and the host) still see your IP** (`relayPref.ts`), it adds a little latency, and it can't
  read your media/data (still end-to-end encrypted).
- **Self-asserted display names.** A name is just typed text — spoofable. **Only the verified
  badge** (OIDC) is a trustworthy identity signal.
- **Endpoint compromise.** If a participant's device/browser is compromised, E2EE can't help —
  the content is decrypted there by definition.
- **Collusion is out of scope — and unpreventable by anyone.** No system can stop two parties who
  *want* to connect: they control their own browsers and can exchange signaling out-of-band, so they
  can always stand up a direct link *outside* the room — and a member holds the cleartext, so it can
  re-broadcast to a non-member over a side channel. Crucially, **verification proves identity, not
  honesty**: the safety code and verified badge catch a *deceiving middle* (MITM / impersonation), but
  two *willing* colluders feed every verifier consistent inputs, so none — peer **or** authority — can
  detect them. The only levers against collusion are **accountability** (who's admitted / identified),
  **minimizing what any one peer is shown** (the [capability layer](./architecture.md#6-participant-capabilities)),
  and **detection / economics** — never cryptographic verification.

## 5. Admission attacks (and why they fail)

Detailed in [verification.md §6](./verification.md). Summary:

- **Token replay over another connection** — defeated by cert-binding (the credential's nonce
  is tied to the DTLS cert actually handshook, read from the live connection, not the SDP). Full
  scheme: [cert-binding.md](./cert-binding.md).
- **Cross-room replay** — every credential is room-bound (salt / payload `room`).
- **Offline brute force of a short secret** — putting a verifier in the link makes it an
  offline oracle, so short codes can't be both link-carried and brute-resistant; Kibitz uses
  unforgeable signed invites (or a rate-limited browser-held variant, or a server) instead.
- **Algorithm confusion / forged signature** — the OIDC verifier pins RS256 (the token header
  never selects the algorithm) and checks the signature against the provider's published keys.
- **Forged / replayed moderation command** — a `mod` command is checked against the committed
  host public key and rejected unless it is **room-bound, cert-bound** to the signer's live
  fingerprint, **and fresh** (the room/fp/iat checks in `hostKey.ts` `verifyHostCommand`), so it
  can't be forged by the coordinator, carried to another room, or replayed later. With **no host
  key committed the command is dropped outright** (open room = no admin, the `!committedHostKey`
  guard in `room.ts` `handleMod`).
- **Fail-closed** — if the provider's keys are unreachable, the gate **denies**. The capability
  **media gate fails closed** the same way: a withheld peer that can't be given a placeholder
  gets **nothing** rather than the real track (`gatedTrack` returns null → `replaceTrack(null)` in
  `mesh.ts`), so a gate never leaks media.

## 6. Agent-specific surface

- **An agent is a participant — with least-privilege defaults.** It's admitted via the same
  gate, but the [capability layer](./architecture.md#6-participant-capabilities) starts it
  **read-only**: it perceives chat, the roster, and data directed at it, and **acts nothing**.
- **A read-only agent gets no media and can't act — enforced by the engine, not by trust.**
  Its grant carries no `see-screen`/`hear-audio`, so every sharer withholds the screen-share
  and audio tracks from it (a placeholder is substituted on its connection — it never receives
  a frame). It has no `send-chat`, so any chat/app/pay/ink it emits is **dropped by every
  honest peer** (and logged to the host's audit feed). Its only effect is *reading*. Granting
  it more (`speak`, `act`, media) is an explicit, revocable host decision.
- **Prompt injection.** Room content reaching an agent is *data, not instructions* — feed it
  as data; the blast radius of a read-only agent is bad *advice*, never bad *actions*.
- **Egress is disclosed, not hidden.** An agent's model **backend** sees whatever the agent
  forwards (page content, chat); the agent declares its `backend`/`egress` so the host sees
  "what it perceives leaves the E2EE room" before granting it perception. That routing is the
  operator's choice — disclosed honestly, not enforced.
- **Uniform across humans.** The authority distributes the grant map to every peer **over the
  P2P data mesh** — and each peer accepts a `caps` update **only from the current host id**
  (the `c.k === 'caps'` branch in `useCall.ts` ~1156-1163), so a non-authority peer can't rewrite policy. The grants are clamped on
  the wire (`sanitizeGrant`; `intersectGrant` — never more than requested,
  `capabilities.ts`), so an agent's limits hold the same way no matter which participant is
  sharing or sending.

## 7. The email-OTP exception

The one verification method that needs a backend ([verification.md §4.5](./verification.md))
sees **join metadata** (which email asked to join which room) — a privacy cost the other
methods avoid. It does **not** see call content. Use it only when proving email control
without a third-party IdP is worth that trade.

## 8. Operator posture

The project is operated **pseudonymously** and holds **no call content, accounts, or
recordings** — by construction, not policy. The legal/privacy surface is therefore minimal:
the only data that touches infrastructure is ephemeral presence metadata and (optionally)
TURN-relayed *encrypted* packets.
