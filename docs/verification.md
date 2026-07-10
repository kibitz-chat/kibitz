# Room Verification — the Link Is the Verifier

How Kibitz decides **who may enter a room**, with no server and no stored state. This
document declares the central principle — *the room link carries everything needed to
verify who gets in, and nothing it shouldn't* — and details every verification method
built on it.

> Companion: [agent-protocol.md](./agent-protocol.md). An agent is admitted exactly like a
> human (it presents a credential to the same gate).

---

## 1. The principle: the link is a verification capability

A Kibitz room has **no backend** and **no permanent owner**. The "authority" is just
whichever participant's browser is currently coordinating the room (the first one in;
the role migrates if they leave). So there is nowhere central to keep an access-control
list — it has to live with the authority, which is an untrusted-by-default browser that
can change at any moment.

The resolution is to make the **link self-contained**:

> The room link carries a **verifier** — public material that lets *any* authority check a
> joiner — and **never a secret**. Each allowed guest separately holds a **credential** they
> were given out-of-band. The authority checks *credential against verifier* and admits or
> refuses. **The authority holds no secret of its own.**

Three consequences fall out:

- **Stateless / reconstructible.** Any peer can rebuild the full gate from the link alone.
  No localStorage, no in-memory roster of secrets.
- **Survives reload and host migration.** A refresh re-reads the link; a new authority
  enforces identically, because the verifier was never the old authority's private state.
- **The link can't leak the answer key.** A link is a *bearer* artifact — forwarded,
  screenshotted, logged. So it must contain only what is safe to be public (a public key, a
  name list, an OAuth client id), never a code or a guest's secret. *(Two opt-in exceptions
  deliberately seal a secret into the link under a password — the host private key `ghk` and
  the passphrase-protected manifest `ge` — and accept the resulting offline-brute-force risk;
  see the §3 carve-out and §7.5.)*

This is a **capability-URL** model: holding the link grants the ability to *verify*, not the
ability to *enter*. Entering still requires a credential.

### The hard constraint

The strict form Kibitz targets is: **nothing is persisted and nothing is kept in memory —
after the room is created (and any per-guest credentials / email codes are handed out), the
link is the entire authority.** This rules some things in and some out (§7), and it is what
makes the model serverless *and* migration-proof at once.

---

## 2. The gate seam

Verification is enforced by the room authority **over the presence connection, before a
joiner is added to the roster** — so a refused peer never appears on screen and no one's
data/media mesh ever dials it. It is **method-agnostic**: `room.ts` knows nothing about
OIDC, invites, or codes. It exposes one injected seam:

```ts
interface IdentityGate {
  require: boolean                       // is the gate on? (live; host can toggle)
  requireAgentCredits?: boolean          // also require a valid network-access credit for declared agents
  verify(jwt: string | undefined,
         remoteFp: string | null,
         agentAssertion?: string,        // an AI agent's cert-bound key proof
         agentCredit?: string)           // a signed network-access credential
    : Promise<{ ok: boolean; reason?: string; creditExp?: number }>
  bindsFingerprint?: boolean             // does verify() use the live cert fingerprint?
}
```

The two extra args admit AI agents the same way a human is admitted: instead of a `jwt`, an
agent may present an `agentAssertion` (a cert-bound key proof checked against the manifest's
committed `agentKeys`) and, when `requireAgentCredits` is on, an `agentCredit` (a signed,
expiring network-access credential the authority re-checks on every announce). `verify` may
return that credential's `creditExp` so the authority can reap a lapsed agent. Cite
`room.ts` (the `IdentityGate` seam / `gateIdentity`), `Widget.tsx` (`withAgentGate`).

On a joiner's announce (which carries their `credential`), the authority:

1. reads `remoteFp` — the DTLS fingerprint of the cert the joiner **actually handshook** on
   the presence connection (read from the live `RTCPeerConnection`, **not** the spoofable
   SDP);
2. calls `verify(credential, remoteFp)` (the `credential` is the joiner's `jwt`; an AI agent
   instead announces an `agentAssertion` / `agentCredit`, checked by the same call);
3. **admits** (rosters them) or **refuses** (`status:'unverified'`, never rostered).

`bindsFingerprint` distinguishes credentials that are cryptographically bound to *this
connection* (OIDC tokens — a not-yet-readable fingerprint **holds** the joiner) from those
that aren't (invites/names — a null fingerprint must not block them).

`verify` is injected by the embedder (the Widget builds it from the link descriptor), so the
core comms code stays free of any verification policy.

---

## 3. The link codec

Mostly **non-secret verifier material** is encoded into the URL, namespaced `g*` so it never
collides with the room hash. (Two opt-in params — `ghk` and `ge` — seal a *secret* into the
link under a password; see the carve-out below.)

| param | carries | for |
|-------|---------|-----|
| `g`   | the mode (`open` / `invite` / `names` / `google` / `code` / `email`) | all |
| `gk`  | the creator's signing **public key** (JWK, b64url-json) — verifies invites AND the manifest | signed invites / roster |
| `gn`  | the pickable **name list** (csv) | name list |
| `gc`  | the OAuth **client id** — read for **any** mode now (verified identity *and* the OIDC host tier) | verified identity / OIDC host |
| `gt`  | *(per-guest link only)* that guest's signed invite **token** | signed invites |
| `gm`  | the signed room **manifest** (committed roster), cleartext | verified roster (§7) |
| `ge`  | the manifest **sealed** under a group passphrase (privacy mode) | verified roster (§7) |
| `gh`  | the **host** ECDSA P-256 **public** key (JWK) | password host tier (§7.5) |
| `ghk` | the host **private** key **sealed** under the host password (PBKDF2/AES-GCM) | password host tier (§7.5) |
| `ghn` | the soft **host name** (whoever joins under it is host; spoofable) | name host tier (§7.5) |
| `gho` | the host's verified **email** (proved via OIDC sign-in) — needs `gc` | OIDC host tier (§7.5) |
| `gl`  | `1` → start with the waiting room ON | name host tier (§7.5) |

The shared **room link** carries the verifier (`g`,`gk`/`gn`/`gc`, plus any `gm`/`ge`/`gh…`
host material). Each guest's **personal link** is the room link plus their own `gt` credential.
A creating tab's private material (an invite signing key, short codes) is **never encoded** — it
is used at creation and dropped. Display-only `d` (room description), `n` (consent notice), and
`ag` (agent-call type) ride the same fragment. New links carry the gate in the **URL fragment**
(host-private) by default, falling back to the legacy query string
(`joinGateLink.ts:48-55 gateParamsFrom`, `:37 GATE_KEYS`).

**A secret in the link, deliberately.** The "never a secret" principle (§1) has two opt-in
exceptions that seal a secret into the link under a password and accept the resulting
offline-brute-force risk: the **host private key** (`ghk`, §7.5) and the
**passphrase-protected manifest** (`ge`, §7). Both are PBKDF2/AES-GCM blobs
(`hostKey.ts:60-76 sealHostKey`/`unsealHostKey`) — because the sealed blob rides the *public*
link and **there is no server to throttle guessing, a strong passphrase is required**
(`hostKey.ts:10-11`). These are the only material in the link that is not safe to be public.

---

## 4. The methods

Each method is just a different `verify()` strategy on the §2 seam. They share one mental
model: *the link holds a verifier; the guest holds a credential.*

### 4.0 Open (baseline)

No gate. Anyone with the link is in. The account-free default. The link is unguessable by
default (a crypto-random room id), so "knowing the link" is itself the (weak) access control.

### 4.1 Verified identity — OIDC / Google

The strongest, and the only one where the credential proves a **real-world identity**.

- **The ID is** a verified email (or the Workspace `hd` domain).
- **The link carries** the OAuth **client id** (`gc`) — public. The allow-list
  (`allowedDomains` / `allowedEmails`) is policy: in the link (visible — reveals who's
  invited) or held by the authority.
- **The guest holds** a Google-signed **ID token** obtained at sign-in, whose
  `nonce = base64url(sha256(canonicalFingerprint(theirCert) + "|" + roomId))`.
- **Verification** (peer-to-peer, no Kibitz server): the authority fetches Google's public
  keys (JWKS, discovered from the issuer), checks the token's **RS256 signature**, `iss` /
  `aud` / `exp`, `email_verified`, the **cert-binding** (`nonce == sha256(remoteFp + "|" +
  roomId)`), and `allowedDomains`/`allowedEmails`.
- **Security:** unforgeable (Google's signature), **non-transferable** (bound to the live
  DTLS cert — a captured token can't be replayed over another connection), **no cross-room
  replay** (room-salted nonce). Composes with the 🛡️ safety-code (SAS). The binding scheme
  itself is written up in full in **[cert-binding.md](./cert-binding.md)**.
- **Limits:** needs the internet (JWKS) → **online-only, fail-closed**; point-in-time
  ("authenticated ≤1h ago"); RS256/JWKS only; alg-confusion rejected (the verifier pins the
  algorithm, never the token header).
- **Status:** built. `bindsFingerprint: true`.

### 4.2 Signed invites

The canonical fit for "the link is everything." Per-person, unforgeable, no server, no stored
secret.

- **The ID is** whatever the creator labels each guest (a name).
- **The link carries** the creator's ECDSA **public key** (`gk`) — safe to publish, reveals
  nothing about who's invited.
- **The guest holds** a **signed token** = `base64url(payload) . base64url(signature)`, where
  `payload = { name, room, exp }`, signed with the creator's ECDSA P-256 **private key**. The
  token is usually delivered as the guest's personal link (`…&gt=<token>`).
- **Verification:** the authority imports the public key from the link and checks the
  signature, the `room` binding, and `exp`. Stateless — any authority verifies with the link
  alone.
- **Creation:** generate a keypair → mint one token per guest → hand out the personal links →
  **discard the private key.** Forever after, the link's public key verifies everyone.
- **Security:** **unforgeable** (forging = breaking ECDSA, not guessing — so no brute-force
  oracle), **room-bound** (no cross-room replay), **expiring**. It is a **bearer** credential
  (whoever holds a guest's token joins as that guest — like a signed invite link); pair with
  §4.1 if you need it tied to a person.
- **Trade-off:** the guest's credential is a long pasteable token, not a short say-aloud code.
  The **guest list is fixed at creation** (the signing key was discarded — adding someone later
  means a new link).
- **Status:** built. `bindsFingerprint: false`.

### 4.3 Name list

Presence/organization, not security.

- **The ID is** a name; **the link carries** the allowed names (`gn`); **the guest holds**
  nothing — they pick a name from the list.
- **Verification:** the authority checks the picked name ∈ the list (case-insensitive).
- **Security:** **none** — anyone with the link can pick any allowed name. Use it to organize
  a known group, not to keep anyone out.
- **Status:** built. `bindsFingerprint: false`.

### 4.4 Join code

A shared secret per person (or one shared code). Intuitive, but in tension with the link rule.

- **The ID is** a name; the **credential** is the assigned **code** the guest types.
- **The tension:** if the link must hold a verifier for the code, that verifier is an
  **offline brute-force oracle** — anyone with the link can enumerate guesses with no rate
  limit. A *short, say-aloud* code (≈30 bits) is cracked in seconds. So under "the link is
  everything," a code must be **high-entropy** (≈60+ bits, a KDF-hashed commitment) — at which
  point it is effectively a §4.2 invite token, just with a hash instead of a signature.
- **The alternative** that keeps codes short is to **not** put the verifier in the link: hold
  the `{name → code}` map in the *creator's browser* and **rate-limit** guesses (online-only
  guessing the authority can throttle). This is safe for short codes but is **creator-local**
  (lost on the creator's reload; doesn't migrate) — it deliberately steps outside the strict
  link rule.
- **Status:** core helpers built (`codeMatch` constant-time, `formatCode`,
  `createRateLimiter`); the browser-held variant is superseded by §4.2 under the strict link
  rule; a server-backed variant is §4.5.

### 4.5 Email + mailed code

Proves control of an email address without a third-party identity provider — the one method
that needs a backend. **Built.**

- **The ID is** an email; the **credential** is a high-entropy **code mailed to that address.**
- **How it works (we are our own OIDC provider):** a browser can't send mail, so a small
  Cloudflare Worker (`functions/api/email/*`) emails a per-recipient random code, and on
  correct entry **mints an RS256 ID token** — exactly the OIDC shape the existing verifier
  already checks. The token is **cert-bound** (its nonce hashes the joiner's DTLS fingerprint,
  server-held during the exchange) and is then **verified peer-to-peer against the Worker's
  published JWKS** (`/api/email/jwks`), routed by issuer through the same `verifyPeerMulti`
  path as Google. So after the code exchange the verification is peer-to-peer — the server
  bows out, exactly like the OIDC path. The link carries only the gate **mode** (`email`) and
  the backend base (`apiBase`), never the code.
- **Mailer:** a pluggable, free-tier-rotating provider seam (`core/mailers.ts`) — HTTP-only
  providers (a Cloudflare Worker can't open SMTP). Premium/over-quota sends can be sponsored
  by the room opener via the same opener-pays grant as TURN.
- **Security:** the code is high-entropy (server-generated); the minted token is RS256,
  alg-pinned and cert-bound, so it can't be forged or replayed over another connection. The
  server sees **join metadata** (which email asked to join which room) — a privacy cost the
  other methods avoid; it never sees call content.
- **Status:** **built** — crypto core, RS256 mint, Worker endpoints, mailer, and the client
  provider all ship (the live mail *provider* choice is still being firmed up). Like every
  gate, wants a 2-device live test before deploy.

---

## 5. Comparison

| Method | "ID" is | Proof of the ID | Link carries | Secret lives | Server | Survives migration | Brute-force resistant | Non-transferable |
|--------|---------|-----------------|--------------|--------------|:------:|:------------------:|:---------------------:|:----------------:|
| Open | — | none | — | — | no | — | — | — |
| Verified identity | email | Google signature + cert-binding | client id (+ allow-list) | — | no¹ | yes | yes | **yes** |
| Signed invites | a label | creator's ECDSA signature | public key | (discarded) | no | yes | yes | no (bearer) |
| Name list | name | none | the names | — | no | yes | n/a | no |
| Join code (short) | name | knows the code | — (browser-held) | creator browser | no | no | only via rate-limit | no |
| Join code (link) | name | knows a high-entropy code | code hashes | (discarded) | no | yes | yes (if high-entropy) | no |
| Email + code | email | code mailed to it | code hashes | (discarded) | **yes** | yes | yes | no |

¹ No *Kibitz* server, but it fetches the provider's public keys (online-only).

---

## 6. Security analysis

**Replay (other connection).** Defeated only by cert-binding (§4.1): the credential's nonce
is bound to the DTLS cert the joiner actually handshook, read from the live connection, so a
captured token can't be reused over a different connection. Other methods are bearer (a
captured invite/code works for whoever holds it) — by design.

**Cross-room replay.** Every credential is room-bound (the nonce salt / the invite payload's
`room`), so a credential for room A is refused in room B.

**The offline-oracle trilemma.** Putting a *verifier* in the link lets anyone attack a secret
**offline**, with no rate limit. So without a server you can have only **two** of: *short
say-aloud code*, *survives host hand-off*, *resists offline cracking*. Signed invites pick the
last two (the "secret" is a full signature — not guessable); browser-held short codes pick the
first two (rate-limited, but creator-local); a server (§4.5) is the only way to get all three.

**Algorithm/temporal.** OIDC verification pins RS256 (the token header never selects the
algorithm), checks `exp` with bounded leeway, and can bound token age.

**Fail-closed.** If the authority can't reach the provider's keys (an offline LAN call), it
**denies** rather than admits. `require` rooms are therefore online-only by design.

---

## 7. Verified roster — no privileged host (optional)

By default the authority (the first peer in) is *trusted to run* the gate. It can't read
content or forge an identity — both are peer-to-peer (§4.1, [threat-model](./threat-model.md))
— but it decides admission. The **verified-roster** mode removes that last trust: it publishes
a committed roster and makes **every** participant, the host included, prove a listed identity
to *everyone*, **before entering**.

**Why both — one verifier vs. everyone-verifies-everyone.** This is the classic trade-off. The default
gate has the **authority** check each joiner *once*: **O(n)**, automatic, gate-capable (deny at the
door), and it binds a **named** identity — but you trust the authority to *run* admission. The
verified-roster makes **every peer check every peer**: **O(n²)** and **no central trust**, at the cost of
more checks (OIDC-only today). Crucially, *neither can **forge** an identity* — each peer verifies the
cert-bound credential itself (§4.1) — so even the default's residual trust is only "*rosters honestly*,"
never "*vouches for who you are*." Beneath both sits the manual **safety code** (the shield;
[cert-binding §6](./cert-binding.md)) — the trust-no-one, out-of-band floor for **open** rooms, where
there's no credential to bind at all.

**The manifest.** The creator publishes a **signed manifest** in the link:
`{ members, policy, room, exp }` signed by the creator's key, with the creator's **public key**
in the link (the private key is then discarded). The manifest is the published, committed
roster + policy — anyone can read who's expected and confirm the manifest is authentic.

**Mutual, pre-share verification.** Verification is a *precondition to entry*, both directions:

1. **authority → joiner** — verified before rostering (already the gate; denied at the door);
2. **joiner → every existing member, incl. the host** — verified before the joiner shares
   anything; if the host (or anyone) can't prove a listed identity, the joiner **refuses to
   enter**;
3. **host → itself** — the honest-host bootstrap: a host's own client won't host a room it
   can't verify into.

**Invariant:** *no peer is "in" until it has verified, and been verified by, every other peer
(the host included) against the manifest — before any content flows.* A malicious host can
neither admit an off-manifest peer (everyone else rejects it) nor be the host without proving
a listed identity (the first arrival checks it).

**The bootstrap (why "alone host" is fine).** A host that is *alone* has no relying party, so
it can only self-attest — harmless, because no one is there to be exposed. The **first arrival
verifies the host before that arrival enters.** So from every actual participant's view, no one
ever entered a room containing an unverified peer. (You can't verify yourself *to no one*;
verification is always relative to the party relying on it.)

**Design choices.**
- **Any listed + verified member may be the host** (first-come) — the room isn't dead if one
  specific person isn't first.
- **Plaintext list** (previewable roster — reveals who's invited) vs. a **commitment**
  (hashed allow-list that hides the names at the cost of the preview). "Publish before
  entering" favors the plaintext, previewable list — but the **commitment path is now built**:
  `mh` carries room-bound `memberHash()` values instead of cleartext emails, and the gate
  matches by hashing via `memberAllowedAsync` (`roomManifest.ts:44-48,150-159`,
  `rosterHash.ts`). The passphrase-**sealed** manifest (`ge`, `joinGateRuntime.ts unlockGate`)
  is the Layer-2 privacy mode — the whole manifest is encrypted under a group passphrase so the
  link itself reveals nothing without it.
- Full strength needs a **cert-bound** method. **OIDC (Google)** is the strong path: each
  peer's proof is bound to the DTLS cert it actually handshook with (`nonce == hash(remoteFp)`),
  so a relaying authority — or any peer that received someone's token — *cannot replay it* to
  impersonate that member to a third peer. **Signed invites** prove "the creator authorised a
  member named X" but are **bearer** tokens (not cert-bound): they confirm admission against the
  committed roster but are replayable peer-to-peer, so the invite path gates the **door** (the
  authority) and not the mutual, peer-to-peer pre-share. Cert-binding invites (a per-guest
  keypair committed in the manifest) is a future step. Name-list / code confirm "on the list"
  but are not strong proof.

**What enforces it (code).** The decision is a pure function,
[`src/core/rosterGate.ts`](../src/core/rosterGate.ts): given the committed roster, my own proven
identity, and what every present peer has proven so far, it yields `selfVerified`, a per-peer
`pending | verified | rejected`, and a `canShare` gate (true only when **I** am a listed member
*and* **every** present peer is a verified member). `useCall` drives it — it polls each peer's
cert-bound identity (`getIdentity`), checks it against the roster, and then

- **holds every broadcast** (chat / app / pay / ink) until `canShare`, and sends a *directed*
  message only to an individually-cleared peer;
- **drops content received** from any peer that isn't a verified member (the ID token — how a
  peer becomes verified — is the one exception);
- exposes `rosterGate` so the widget shows **"verifying the room…"** while pending, a
  **compromised alarm** (+ Leave) the moment a present peer proves an *off-roster* identity, and
  a **host self-gate** banner if *my own* sign-in isn't on the roster.

The same committed roster also drives **admission**: when a link carries a manifest, the
authority's allow-list *is* the manifest (not the host's editable guest list) and `require` is
forced on — so the door and the peer-to-peer pre-share share one roster. Mint a room with
`buildVerifiedGoogleRoom(base, room, emails, clientId, exp)` (one shareable link; members prove
by Google sign-in) or, for the invite/door path, `buildVerifiedRoom(...)`.

**Published per-invitee roster + pre-entry preview.** `buildVerifiedRoster(base, room, invitees,
clientId, exp)` takes a **per-invitee method** and signs an `invitees` list into the manifest
alongside the gate's match lists. Each invitee picks one of:

- **`signin`** — OIDC sign-in pinned to one **email** → that exact address joins `members`;
- **`oidc`** — OIDC sign-in for **any verified account at a domain** → the domain joins `domains`
  (the gate admits any verified address there, matched in both the authority gate via
  `identityAllowed` and the peer-to-peer `rosterGate` via `memberOf(members, id, domains)`);
- **`mail`** — a mailed code to an email (via the email-code backend, §4.5) → that exact
  address joins `members`. `signin` and `mail` both gate on the **exact** verified email and
  differ only in which provider proves it, so both contribute their email to `members`
  (`joinGateRuntime.ts:236-239`). *(The email backend has shipped — see §4.5 — so this is no longer
  the "display-only until it ships" placeholder noted in the `roomManifest.ts:17` comment.)*

The **room creator gets their own line** (they verify too — honest host). A per-invitee
**`show`** flag (default off) controls whether an email/domain is revealed in the preview. The
signed `invitees` roster powers a **pre-entry preview**: opening a verified-roster link shows
*who's invited and how each verifies* (tamper-proof — checked against the link's pubkey), lets the
joiner **pick which one they are**, and approves *before* the room mounts. The OAuth client id
rides the link (`gc`), so the whole gate runs **from the link alone** (the id is public; tokens
are still audience-checked).

**Fail-closed.** A forever-pending peer (no valid proof) keeps `canShare` false — content is
*held*, never leaked to an unproven peer. That is intentional (a security room favours silence
over exposure); it also means one stuck/malicious peer can stall sharing, which the user
resolves by leaving or (host) removing them. It also needs the provider's JWKS to be reachable,
so the strong path is **online-only** (offline/LAN can't verify → fail-closed → hold).

**Status:** built for the cert-bound **google** mode — manifest signing/verification
(`roomManifest.ts`), the pure gate (`rosterGate.ts`, unit-tested), the `useCall` content gate +
self-gate, and the widget alarm/hold/self-gate banners. Needs a **2-device live test** (an
off-roster window must be *refused content* by every other window, not merely admitted-then-
swept). Invite-mode mutual pre-share (cert-bound per-guest keys) remains a follow-up.

## 7.5 Room host / admin (the 4 tiers)

**Coordinator ≠ host.** The *coordinator* (a.k.a. the authority) is just whichever browser is
currently running the room — positional, migratory plumbing: it holds the room id, keeps the
roster, runs presence ping/reap, relays signaling, and **migrates** when that peer leaves. It
has *no discretionary powers*. **Admin** — run the waiting room, admit/deny knocks, lock/unlock,
kick, reset — is a separate, verified **HOST** role. Admin powers attach to *proving the host
credential the link committed*, **NOT** to being the coordinator (`room.ts` host tracking,
`useLobby.ts` `useHostLobby`). This is what fixes the "coup" (a stranger who became coordinator used to
seize moderation) and "bans vanish on migration."

A host can moderate **from any seat**: it signs a cert-bound command and whatever browser is
coordinating verifies it against the committed host material — the data flows over the
`t:'mod'` wire message, relayed to the coordinator (`useCall` `hostModerate` →
`room.ts` `sendModFn` send → `room.ts` `handleMod` → `room.ts` `enactMod`;
`hostKey.ts` `verifyHostCommand`).

`isVerifiedHost` = the roster's `host` field == our own media id. The roster `host` =
`verifiedHostId`, reset on coordinator migration **and** on the host's own disconnect (the host
re-claims) — `room.ts` (`verifiedHostId`, cleared on the host-leaves branch).

The room link commits **one of four** host tiers, chosen at creation (the CreatePage "Room
admin (host)" 4-way chooser — `CreatePage.tsx` `hostTier`):

| Tier | Link params | How admin is claimed | Trust property |
|------|-------------|----------------------|----------------|
| **None** (open) | — | — | **No admin at all.** With no host key committed, every `mod` command is dropped (the `!committedHostKey` guard in `room.ts` `handleMod`, "open room = no admin"). A room with no host has no live moderation — a behavior change from "the first peer moderates." |
| **Soft name** | `ghn` (+ `gl`) | Whoever announces under the committed display name becomes host (`room.ts` `matchHostByName`, `useCall.ts` `claimHostByName`). First-match-holds; reclaim-by-name after the host disconnects. | **Spoofable** — no crypto; any link-holder can use the name. For "I'm first in, hold the door, let the agent in, then admit everyone" convenience, not defense. `gl=1` starts the waiting room ON (`room.ts` `lastLobbyOn`), which holds a stranger *before* they can announce a name. |
| **OIDC email** | `gho` + `gc` | Host signs in (OIDC); every peer verifies every peer's cert-bound ID token peer-to-peer, the authority matches the committed email **locally**, and `declareHost`s it (`room.ts` `declareHostFn`/`declareHost`, `useCall.ts` declare-host wiring). Signing in *is* claiming. | **Un-spoofable + portable** — sign in on any device, nothing stored. Needs the internet (JWKS) and a Google OAuth client id in the link (public, like verified rooms). The room itself stays open; only *admin* is gated to the email. |
| **Password key** | `gh` + `ghk` | Enter the host password → unseal the private key from `ghk` → sign cert-bound commands the coordinator verifies against `gh` (`hostKey.ts` `unsealHostKey`/`signHostCommand`/`verifyHostCommand`, `useCall.ts` `claimHost` → `hostModerate`). | **Un-spoofable, no provider, moderates from any seat, migration-safe** (each command is individually signed). The sealed key rides the **public** link, so a weak password is **offline-brute-forceable** (PBKDF2 only slows it; no server to throttle) — use a passphrase (the HONEST LIMIT comment in `hostKey.ts`; the create UI nudges a strong one). |

**Commands** (`hostKey.ts` `HostOp`/`HOST_OPS`):
`claim` · `lobbyon` · `lobbyoff` · `admit` · `deny` · `lock` · `unlock` · `reset` · `kick`.
Each (password tier) is **cert-bound** (to the host's live DTLS fingerprint), **room-bound**
(`normalizeRoom(room)`), and **fresh** (120 s window), so a captured command can't be replayed
on another connection, room, or later (`hostKey.ts` `HostCommandPayload`/`verifyHostCommand`).
The `remoteFp` cert binding is *optional* so a
coordinator that is itself the host can self-inject a command without a remote fingerprint
(`room.ts` `handleMod` + the `sendModFn` self-inject path).

**Migration.** Because every peer holds the committed host *public* material from its own link,
any new coordinator can verify a `mod` command identically. If the verified host **leaves**, the
room **loses its admin until someone re-claims it** (`room.ts`, the host-leaves branch clearing
`verifiedHostId`) — admin does **not** silently transfer to the next coordinator. **No host
committed = no admin**, ever (the `!committedHostKey` guard in `room.ts` `handleMod`).

**Precedence.** A committed host **key** wins over a committed **name**/**email** — the name and
email tiers are disabled when a host key is present (`room.ts`, `committedHostName`/`committedHostEmail` are blanked when `committedHostKey` is set). Host fields are read for
**any** mode, including `open` (`joinGateLink.ts` `decodeGateParams` reads the host fields before
the open-mode early return), so an otherwise-open room can still carry a verified moderator. So
"open" no longer implies "no moderation" — admission and admin are independent axes.

## 8. Enforcement details

- **Authority-enforced, before rostering.** A refused joiner is never added, so it can't flash
  on screen and learns no one's media id.
- **The host must hold the gate (admission).** Under the link rule, *whoever runs the room must
  open a gated link* — the **join gate** lives in the link, so a bare room link is an open door
  for *admission*. (The create-screen issues the creator a gated link so this is automatic.)
  Note this is about admission only: an **open** room can still carry a host for *moderation*
  (§7.5), so "open" does not imply "no admin in all cases."
- **Host migration.** A new authority rebuilds `verify` from the link and enforces identically;
  members it **inherited** mid-call are grandfathered (already-verified), while new joiners are
  re-verified.
- **Live toggle.** `require` is flippable by the host at runtime; re-enabling drops the
  "already verified" memory so everyone re-proves.
- **Backstop.** A practical post-admission sweep (host removes anyone who fails the policy)
  covers token expiry mid-call and defends if the door is bypassed.
- **DoS guards.** An oversized credential is refused synchronously before any async work.

---

## 9. Code map

| Concern | Where |
|--------|-------|
| The gate seam + enforcement | `src/core/room.ts` (`IdentityGate`, `gateIdentity`, migration) |
| The handshook remote fingerprint | `src/core/transport.ts` (`connRemoteFingerprint`), `src/core/safetyCode.ts` |
| Link codec (verifier ↔ URL) | `src/core/joinGateLink.ts` (`GateDescriptor`, encode/decode) |
| Runtime: verifier-from-link (names / invites) | `src/core/joinGateRuntime.ts` (`gateVerifierFor`, `buildInviteBundle`) |
| OIDC / email gate verify (google + email modes) | `src/widget/Widget.tsx` (`makeGateVerify`) → `src/core/identity.ts` (`verifyPeerMulti`, route by issuer) — **not** `joinGateRuntime`, and **not** a separate `identityMulti.ts` (no such file) |
| Email-OTP backend (our own OIDC issuer) | `functions/api/email/{start,verify,jwks}.ts`, `src/core/{emailOtp,emailToken,mailers,emailProvider}.ts` |
| Signed invites (ECDSA) | `src/core/inviteToken.ts` |
| Name / code helpers | `src/core/joinGate.ts`, `src/core/gateRateLimit.ts` |
| OIDC verify + cert-binding | `src/core/oidcVerify.ts`, `src/core/oidcBinding.ts`, `src/core/identity.ts` |
| Verified roster (§7) — signed manifest + membership | `src/core/roomManifest.ts` (`signManifest`/`verifyManifest`/`memberAllowed`/`memberAllowedAsync`), `src/core/inviteToken.ts` (`signPayload`/`verifyPayload`) |
| Privacy / hashed roster + sealed manifest | `src/core/rosterHash.ts` (`memberHash`), `src/core/roomManifest.ts` (`mh`, `memberAllowedAsync`), the `ge` seal (`src/core/joinGateLink.ts`, `joinGateRuntime.ts` `unlockGate`) |
| Room host / admin (§7.5) — key + commands | `src/core/hostKey.ts` (`generateHostKeypair`/`sealHostKey`/`unsealHostKey`/`signHostCommand`/`verifyHostCommand`/`HostOp`), `src/core/room.ts` (`verifiedHostId`, `handleMod`/`enactMod`, `matchHostByName`, `declareHost`, the `t:'mod'` wire) |
| Host hooks + UI | `src/react/useCall.ts` (`claimHost`/`claimHostByName`/`declareHost`/`hostModerate`/`isVerifiedHost`), `src/react/useLobby.ts` (`useHostLobby`), `src/widget/Widget.tsx`, `src/demo/CreatePage.tsx` (the 4-tier chooser) |
| Agent admission via the manifest | `src/core/roomManifest.ts` (`agentKeys`, `admitAgentByManifest`), `src/widget/Widget.tsx` (`withAgentGate`), the `requireAgentCredits` gate (`src/core/room.ts`, `identity.ts` `AgentCreditConfig`) |
| Wiring + the joiner's door | `src/widget/Widget.tsx` (`makeGateVerify`, link-gate effect, paste-invite/pick-name) |

## 10. Status

| Method | Status |
|--------|--------|
| Open | shipped |
| Verified identity (OIDC/Google) | built; `bindsFingerprint:true`; needs a 2-device live test before deploy |
| Signed invites | built; live admit/deny wants a 2-device test (the authority must hold the gate) |
| Name list | built |
| Join code | core helpers built; browser-held variant superseded by invites under the strict link rule |
| Email + code | **built** — Worker (RS256 mint + JWKS), cert-bound token, mailer seam, client provider; verified peer-to-peer via `verifyPeerMulti`. Live mail-provider choice still being firmed up; wants a 2-device test |
| Verified roster / no privileged host (§7) | **built** — manifest crypto (`roomManifest.ts`) + mutual pre-share wiring (`rosterGate.ts` → `useCall` content gate) + host self-gate + widget alarms; needs a 2-device test |
| Authority-level door (deny unverified before rostering) | **built** — the authority verifies a cert-bound token over presence before admitting (`room.ts` gate, `unverified` lobby status); needs a 2-device test |
| Room host / admin (§7.5) | **built** — 4 tiers (none / soft name / OIDC email / password key) decoupled from the coordinator; cert-bound `mod` commands (`hostKey.ts`, `room.ts` `handleMod`/`enactMod`); "no host = no admin"; host-leaves-loses-admin migration; needs a 2-device test |
| Privacy / hashed roster (§7) | **built** — hashed allow-list `mh` (`rosterHash.ts`, `memberAllowedAsync`) + passphrase-sealed manifest `ge`; needs a 2-device test |
