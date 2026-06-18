# Cert-Binding — Serverless, Peer-to-Peer Verified Identity (the "Level 3" scheme)

How Kibitz proves that **the party on the other end of *this* encrypted connection really is who
they claim** — with **no server in the loop** and a credential that **can't be replayed**.

This is the distinctive piece of Kibitz's identity layer. The cryptographic *ingredients* are
standard (an RS256-signed OIDC token, SHA-256, the WebRTC DTLS handshake); the *composition* —
stapling the identity token to the live transport certificate and verifying it peer-to-peer — is
the part we built. Internally it's the third identity tier, hence **L3**.

> Companion docs: [verification.md](./verification.md) (all admission methods, §4.1 is the OIDC
> entry), [threat-model.md](./threat-model.md) (what's in/out of scope).

---

## 1. The problem it solves

Plain "Sign in with Google" (OIDC) gives you a token that means *"Google attests this is
alice@acme.com."* That's necessary but, in our setting, not sufficient — for two reasons:

1. **There's no server.** A call is peer-to-peer; no Kibitz backend receives the token, validates
   it, and vouches for the user. Standard OIDC assumes a **relying party** (a server) does exactly
   that. We don't have one.
2. **It's a bearer token.** Whoever holds the token is "alice." In a call the token is broadcast
   over the data channel, where any participant could capture it. A captured token presented by
   someone else would normally be indistinguishable from the real thing.

So the open question is: *given a signed "I am alice" token arriving over a peer connection, how
does each browser — with no server — know the **person operating this specific connection** is
alice, and not someone replaying her token?*

Cert-binding answers it by tying the token to the one thing unique to a live connection: its
**DTLS certificate fingerprint.**

---

## 2. The idea in one sentence

> At sign-in you put **a hash of your connection's cert fingerprint** inside the identity token;
> every peer re-derives that hash from the cert it **actually handshook with** and checks it
> matches — so the token is only valid for whoever holds *this* connection's certificate.

Every WebRTC peer connection is secured by a DTLS certificate. Its **fingerprint** (a hash of the
cert's public key material) uniquely identifies that encrypted channel, and — crucially — *each
side can read the fingerprint of the certificate the other side presented*
(`RTCDtlsTransport.getRemoteCertificates()`, surfaced via `safetyCode.ts`). That readable,
per-connection value is the anchor we bind the identity to.

---

## 3. The algorithm

### Mint (at sign-in, on the prover's device)

1. Read your own connection's pinned cert fingerprint `fp`.
2. Compute the binding nonce:

   ```
   nonce = base64url( SHA-256( canonicalFingerprint(fp) + "|" + roomId ) )
   ```

   (`canonicalFingerprint` = trimmed, lowercase colon-hex, so both sides hash identical bytes;
   `roomId` salts it — see §5. Implemented in `nonceForFingerprint(fp, salt?)`, where the salt
   *is* the normalized room id — the param is optional, named `salt` in code.)
3. Run the OIDC sign-in passing that `nonce` in the provider's **standard `nonce` field**. The
   provider (Google, or our [email-code backend](./verification.md#45-email--mailed-code)) **echoes
   the nonce into the signed token** — it can't be altered without breaking the signature.
4. Broadcast the signed token to peers over the data channel.

The prover never reveals a secret. The nonce isn't secret either — it's a *commitment* to a cert
the prover controls.

### Verify (on every other peer's device, and at the admission gate)

For a token received from a peer whose connection presented cert fingerprint `remoteFp`:

1. **Signature + claims** (`verifyIdToken`): RS256 signature against the provider's published JWKS
   keys (algorithm **pinned**, never read from the token header), plus `iss` / `aud` / `exp` and
   `email_verified === true`.
2. **Binding** (`bindingMatches`): recompute `base64url(SHA-256(canonicalFingerprint(remoteFp) +
   "|" + roomId))` and require it to **equal the token's `nonce`**.
3. If both pass → trust the identity (`{ email, name, … }`); else → reject with a reason.

Composed in `verifyPeerIdentity` (and routed by provider in `verifyPeerMulti`). **No Kibitz server
participates** — each browser fetches the provider's public keys and checks locally.

---

## 4. Why the binding is the point

Without step 2, a valid signature only proves *the token is genuine* — not *who is presenting it*.
The binding turns the bearer token into a **connection-bound** one:

- **Replay over another connection → rejected.** Capture alice's token and present it over *your*
  connection: your DTLS cert has a different fingerprint, so `SHA-256(yourFp + "|" + room)` ≠ the
  nonce minted for alice's cert. The token is refused. There is no way to present alice's token
  over a connection alice doesn't control.
- **Man-in-the-middle → rejected.** A MITM that terminates DTLS presents *its own* cert to each
  side, so the fingerprint each peer sees is the attacker's — the binding fails. (This is the same
  property the emoji **safety code / SAS** gives, now automatic — see §6.)
- **No server to trust or attack.** Verification is pure client-side crypto over public keys;
  there's no backend that could be compromised, subpoenaed, or relied upon to vouch.

So a verified peer isn't "someone who showed a valid alice token" — it's "the entity that, at
sign-in, controlled the private key of the certificate securing *this exact* end-to-end-encrypted
channel, and that entity is alice."

The *same* staple-to-the-live-cert idea is reused beyond identity tokens. A **host moderation
command** carries the host's own canonical fingerprint in its signed payload (`hostKey.ts`
`signHostCommand`, hostKey.ts:84), and every verifier rejects it unless that fingerprint matches
the connection it actually handshook with (hostKey.ts:131). So a captured `mod` command is just
as **unreplayable on another connection** as a captured identity token — the binding makes both
"only valid for whoever holds *this* certificate" (see §8).

---

## 5. Room salting

The nonce input includes the **room id** (`… + "|" + roomId`). A binding minted in room A therefore
won't verify in room B even against the same cert, so a token captured in one room can't be carried
into another. Both peers derive the salt from the **normalized** room id, so two participants whose
URLs differ only by casing still agree.

---

## 6. Composition with the safety code (SAS)

Kibitz already lets two people compare an emoji **safety code** derived from their cert
fingerprints to rule out a man-in-the-middle (`safetyCode.ts`). Cert-binding reuses the **same
fingerprints**, so "this is really alice" and "there's no MITM on this channel" collapse into a
single guarantee: a passing binding *is* a passing SAS, checked automatically by the crypto instead
of by humans reading emoji aloud.

---

## 7. What it does **not** do (limits)

- **Online-only, fail-closed.** Verifying needs the provider's public keys (JWKS over the
  internet). On an offline/LAN call the keys are unreachable, so verification **fails closed**
  (denies) — `require` rooms are online-only by design.
- **Point-in-time.** It proves "authenticated within the token's lifetime (~1h)," not a continuous
  liveness guarantee.
- **RS256 / JWKS only.** Algorithm-confusion (`alg:"none"`, HS\* with the public key as an HMAC
  secret, ES\*) is rejected — the verifier pins the algorithm and never derives it from the token.
- **It authenticates the *channel operator*, not the *human's intent*.** It says the connection is
  operated by the holder of alice's verified identity (which may be alice's browser, or an
  [authorized agent](./agent-platform.md) using alice's-or-its-own identity).

---

## 8. Where admission, badge, the roster gate, and host commands use it

The same primitive runs at several moments — for **identity** (binding an OIDC token to the cert)
and, reusing the same `canonicalFingerprint` anchor, for **host authority** (binding a moderation
command, or a host-election token, to the cert). All client-side, no server:

| Moment | Caller | Effect |
| --- | --- | --- |
| **Admission** (verified-only rooms) | the authority's `makeGateVerify` → `verifyPeerMulti` | a joiner is rostered only if their token verifies + binds; an unverified peer is never added |
| **Per-peer badge + mutual pre-share** | `useCall.getIdentity` → `verifyPeerMulti` (poll) | drives the ✓ badge and the [verified-roster](./verification.md#7-verified-roster--no-privileged-host-optional) "hold content until everyone's verified" gate |
| **Self-verify** | `useCall.signInIdentity` → `selfVerify` | lights your own badge only from a real verify, never the raw payload |
| **Host moderation commands** | `hostKey.ts` `signHostCommand` → `verifyHostCommand` | a `mod` command (lock/kick/admit…) is enacted only if its signed payload's `fp` matches the live `remoteFp` via `canonicalFingerprint` (hostKey.ts:84,131), plus room-bound + fresh — so a captured command can't be replayed on another connection (see §4) |
| **OIDC host election** | `useCall.getIdentity` → `room.ts` `declareHost` | a member is marked the verified host only after the authority verifies their **cert-bound** OIDC token against the committed host email (`nonce = hash(fingerprint)`, the same binding applied to host election, room.ts:745-750) |

---

## 9. Code map

| Piece | File |
| --- | --- |
| Nonce derivation + binding check | `src/core/oidcBinding.ts` (`nonceForFingerprint`, `bindingMatches`, `canonicalFingerprint`) |
| OIDC token verify (RS256, alg-pinned, JWKS) | `src/core/oidcVerify.ts` |
| Compose: signature + `email_verified` + binding | `src/core/identity.ts` (`verifyPeerIdentity`, `verifyPeerMulti`) |
| Reading the live cert fingerprints | `src/core/safetyCode.ts` |
| Cert-bound host commands (reuses `canonicalFingerprint`) | `src/core/hostKey.ts` (`signHostCommand`, `verifyHostCommand`), enacted in `src/core/room.ts` (`handleMod`, `declareHost`) |
| Drivers (admission / badge / self) | `src/widget/Widget.tsx` (`makeGateVerify`), `src/react/useCall.ts` (`getIdentity`, `signInIdentity`) |

**Status:** built and shipped (the L3 identity work). `bindsFingerprint: true` on the OIDC and
email-code methods. The same cert-binding anchor secures host moderation commands and OIDC host
election (§4, §8).
