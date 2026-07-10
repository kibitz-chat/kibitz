# Claimed identity — open-room "declare who you are"

Status: **BUILT** (Phases 1–4), deployed live, e2e-verified. Not in the published docs allowlist
(`scripts/render-docs.mjs`) — engineering spec, not user copy.

As-built: the open-room claim list rides the link as `?gd=email1,email2[,Guest]` (`core/joinGateLink.ts`,
read before the open-mode early return); the claim itself is `meta.claim` (`core/claim.ts`,
`{kind:'email',email}|{kind:'guest'}`); the pre-join "Who are you?" pick + Join gating live in the
Widget; the muted `.tag-claim` chip + the verify-panel "Claims to be…" line keep it visibly weaker than
the ✓ (proof wins via render precedence); CreatePage's "Declare (unverified)" method emits the link, and
`App.tsx` re-reads `gd` per render so in-app create flows the pick (a hash change, no reload).
Guard: `e2e/claimed-identity.mjs` (create→pick→join→claimed-chip, local build). NOTE: all four phases
(1–4, including the create UI + verify copy) are now deployed live.

## Summary

Today a participant is either **verified** (a Google/OIDC email, cert-bound, shown with a ✓) or an
anonymous guest with a free **nickname** and nothing else. This adds the missing middle: in an **open**
room, a joiner can **claim** an identity by picking from the room's **invited email list** (or a literal
**"Guest"** entry). The claim is unverified — shown with a distinct "not verified" treatment — and can be
**upgraded to the ✓** by signing in. It reuses the existing verified-roster machinery, relaxed from "must
verify" to "claim now, verify optional."

## The model: three identity layers

1. **Nickname** — a free display label. Exists in **both** room types. *Already implemented* (the pre-join
   "Your name" field, `Widget.tsx:~3501`, `maxLength 14`). Not "identity" — a name tag.
2. **Claimed email** — a self-asserted identity, **open rooms only**. Pick an invited email (or "Guest")
   from the room's list. Unverified, spoofable, rendered with a distinct unverified marker.
3. **Verified email (✓)** — cryptographically proven (OIDC ID token, cert-bound via the DTLS fingerprint,
   checked peer-to-peer). Works in **any** room; it's the gate in closed rooms.

Layers **2 and 3 are the same identifier (an email) at two trust levels** — the *ladder*. A claimed
`alice@acme.com` upgrades to a verified ✓ `alice@acme.com` by signing in. A nickname (layer 1) has no
verified rung — nothing issues or proves a free name — which is exactly why the claim list is **emails**,
not names.

Room mapping:
- **Open room** → nickname (1) + *optionally* a claimed (2) or verified (3) identity.
- **Closed room** → verified-only gate (3). Unverified claims have no role (a claim can't satisfy a
  "verified-only" door).

## Scope

**In:** an open room whose creator commits an **invited email list** (+ optional "Guest"); a **pre-join
pick** of one entry (the claim); rendering the claim with an unverified marker; the **✓ upgrade** path;
the labeling rules that keep layer 2 from ever looking like layer 3.

**Out (deliberately):**
- **Closed rooms** — unchanged; they keep the existing verified gate (`require: true`).
- **Bug 2 / simple names mode** (`g=names`, the held name-picker) — *not fixed*. It's a `require`-gate on
  an unverified claim, which is a contradiction (a spoofable claim can't actually close a room). M replaces
  its use case via an *open* room + pre-join pick. Leave simple names mode as-is or deprecate it; see Open
  decisions.
- **L** — mid-call "introduce," selective/directed disclosure, verified-but-pseudonymous. Separate roadmap
  (overlaps the parked privacy-hardening plan). M is broadcast-only.

## User flows

**Create.** In `CreatePage`, the verified-roster invite editor gains an **open + declare** posture: commit
the same per-invitee **email** list but with `require: false` (open), and allow adding a literal **"Guest"**
entry. Output is the existing signed manifest in the link — just open instead of gated.

**Join.** The pre-join panel (where the nickname field lives) shows the committed list as a **"Who are
you?"** pick: choose an invited email **or "Guest"**, set the nickname, then Join. The pick sets the claim;
the room is open so there's no hold/gate. "Guest" is reusable (many people can be Guest — the nickname
disambiguates); named entries are reusable too (see Open decisions for an optional claim-once nicety).

**Upgrade.** An admitted claimed peer taps **Verify** → signs in → the claim becomes a ✓. If the verified
email **matches** the claim, it's a seamless upgrade; if it **differs**, *proof wins* — show the verified ✓
email and flag the mismatch (don't silently keep the claim).

**Example.** Creator invites `alice@acme.com`, `bob@acme.com`, adds `Guest`.
- Alice → picks `alice@acme.com`, nickname "Alice" → **Alice · alice@acme.com (unverified)** → taps Verify →
  **Alice · ✓ alice@acme.com**.
- Walk-in → picks `Guest`, nickname "Dave" → **Dave · Guest**. Another → **Sara · Guest**.

## The one hard rule

**`✓` means verified, full stop.** A claimed email (layer 2) must render in a visibly weaker treatment
that can never be mistaken for the ✓ (layer 3). The two are different fields, so they can't blur by
accident; the UI must keep them visually distinct everywhere a claim can appear.

## Data model

- The claim rides the participant's existing **`meta`** (e.g. `meta.claim = { kind: 'email', email }` or
  `{ kind: 'guest' }`), self-asserted alongside the nickname, through the path that already exists:
  `setSelf(on, cam, name, avatar, voiceId, meta)` → roster `member.meta`. **No new wire protocol; no
  admission/gate change** — the claim is just self-asserted display data.
- The verified-identity map (`identities[p.id]`, source of the ✓, from the OIDC verify path) is **unchanged**
  and remains the *only* source of a ✓.
- The room stays **open** (`require: false`). M never touches `room.ts`'s `gateIdentity`/admission branch —
  the property that keeps it off the split-roster path.

## Rendering & labeling rules

- **Tile** (`CallSurface.tsx:~317-327`, the `tag-id` / `tag-claim` rows): verified → `✓ <email>` (unchanged). Claimed-email →
  a **muted/dashed chip** like `~ alice@acme.com`, **no checkmark**, with a "claims"/"unverified" cue.
  Guest → a plain `Guest` chip. Never a ✓ for a claim.
- **Verify panel** (`Widget.tsx:~3844`): verified → "✓ Verified as **email**". Claimed-email → "**Claims**
  to be alice@acme.com — *not verified*" + the existing sign-in to **upgrade to ✓**. Guest → "Joined as a
  guest."
- **Precedence:** a peer that is both claimed and verified shows the **✓** (verified wins; ignore/replace
  the claim, flag a mismatch if the emails differ).
- New CSS: one `.kw-claimed` style (muted, dashed, no check) reused by tile + panel + roster.

## Implementation — reuse the verified-roster, relaxed

The verified-roster already commits a per-invitee **email** list, shows a **"Who's in this room → pick
which invitee you are"** preview, and runs the OIDC verify per invitee. M is that flow with three changes:

1. **Open, not gated.** `require: false` so the pick is a *claim*, not an admission gate. (Likely a flag on
   `buildVerifiedRoster` / the descriptor, e.g. `open: true`.)
2. **Pre-join pick = claim.** Picking an entry sets `meta.claim` and proceeds to Join immediately (no
   verify required, no hold). The verify step becomes the optional upgrade.
3. **"Guest" entry.** A literal, reusable list entry; picking it sets `{ kind: 'guest' }`. Pick-only — a
   joiner picks a listed email or Guest; they can't type an arbitrary unlisted email (Guest is the escape
   hatch), keeping "declare from the list" honest.

The pick is a **pre-join form step** (alongside the nickname), *not* a post-connect held gate — so it does
not use, and does not need, the broken `g=names` held picker (bug 2). In a truly open room the engine
doesn't enforce the pick; "mandatory declare" is a client-side pre-join convention, which is appropriate
for the unverified tier (a peer with no claim simply shows as a bare nickname/Guest).

## Files to change (all UI / display; `room.ts` untouched)

- `src/demo/CreatePage.tsx` — an "open + declare" posture on the invite-roster editor (`require:false`) and
  an "add Guest" affordance (a literal list entry).
- `src/core/joinGateRuntime.ts` / `joinGateLink.ts` — carry `open`/Guest in the descriptor + manifest (no
  new admission logic; the room is open).
- `src/widget/Widget.tsx` — pre-join "Who are you?" pick (reuse the roster-preview component) → `meta.claim`;
  Verify-panel claimed-vs-verified copy; pass the claim to the tile.
- `src/react/CallSurface.tsx` — the claimed/Guest chip, visually distinct from ✓.
- `src/react/useCall.ts` — thread `meta.claim` through `setSelf` if not already carried.
- widget CSS — the `.kw-claimed` style.

## Trust & security

- Spoofable by design (anyone with the link can pick any entry). That's acceptable **because the labeling
  bounds it**: a claim never reads as proof, and the real owner can stand out via the ✓ upgrade.
- **Privacy:** showing claimed/invited emails reveals invited addresses to the room (the plaintext-roster
  posture). A hashed/sealed-email variant is possible but belongs with the privacy-hardening plan, not M.
- **Proof wins:** verification overrides a claim; a verified-≠-claimed mismatch is surfaced, not hidden.
- M makes **no change to who is admitted** (the room is open); it adds display + a `meta` field only.

## Test plan

- **Unit:** `meta.claim` flows to the roster member; precedence (verified wins over claim); pick-only
  rejects an unlisted email.
- **Render:** claimed-email → muted chip, never ✓; Guest → plain chip; verified → ✓; both → ✓ + mismatch
  flag when emails differ.
- **e2e (local build):** create an open declare-list room (+Guest); two peers pick an invited email and
  Guest respectively, each with a nickname → both show claimed, labeled unverified; one taps Verify →
  upgrades to ✓.

## Open decisions (small, non-blocking)

1. **Name-only mode fate.** Keep `g=names` (a no-email flavor; would require fixing bug 2) or deprecate it
   now that the email-roster covers the use case. Lean: deprecate / leave broken; email-only.
2. **Claim-once nicety.** Optionally grey a *named* entry once someone claims it (Guest stays unlimited).
   UX only, still spoofable — skip for v1.
3. **Private emails.** A hashed/pseudonymous email mode so the link/roster doesn't leak invited addresses —
   defer to the privacy-hardening plan.
4. **Mismatch UX.** Exact treatment when a verified email ≠ the claim (replace + toast, or a one-time
   "you claimed X but verified Y" note).
