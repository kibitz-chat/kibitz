# Compatibility policy

How Kibitz evolves without breaking what's deployed. Kibitz is **serverless and peer-to-peer**:
there is no server in the middle to translate between versions, so two *browsers* on different
builds must interoperate directly, and links/tokens created by an old build must keep working.
That makes a small set of **contracts** sacred — and everything else free to change.

The contracts are pinned by golden fixtures in [`src/core/conformance.test.ts`](src/core/conformance.test.ts).
If a fixture there fails, you changed a contract — read that file's header before "fixing" it.

## Contracts vs. internals

Change freely: `useCall`, the React tree, the mesh internals, the build, UI, CSS. Constrain only:

| Contract | Where | Rule |
|---|---|---|
| **Wire protocol** | `core/protocol.ts` (`ContentMsg`/`ClientWire`/`AuthorityWire`) | **Additive only.** Add new `k`/`t` kinds and new *optional* fields. Never remove, rename, or change the meaning of an existing field. |
| **Room-id derivation** | `core/transport.ts` → `kbz-v1-…` | **Frozen.** The `v1` prefix is the namespace that lets two clients meet. Bumping it splits every room (a `v1` peer and a `v2` peer never connect). |
| **Links & tokens at rest** | gate link params (`g/gn/gk/gm/gc`), `?grant=`, invite tokens, the cert-binding nonce | **Version-tagged; never reinterpreted.** A bookmarked verified-room link or an outstanding signed token must keep resolving. Accept all historical forms; add new ones beside them. |
| **Embed / headless API** | `mount(options)` + `data-*` + `MountedWidget` | **SemVer.** Additive options; deprecate, don't remove; an unknown option is ignored. |
| **`/widget.js`** | the rolling latest build | "Latest, may evolve." Pin via a versioned build (below) when you need stability. |

**Why additive works:** `asContent()` returns `null` for an unknown `k`, so an old build silently
drops a message it doesn't understand. The whole 0.1 capability/identity wave (`idtoken`, `caps`,
`schema`, join gates, email-OTP) shipped this way — new message kinds old peers ignore, no
`kbz-v1-` bump.

## The serverless twist: mixed-build rooms

Deploys aren't atomic and embedders cache, so two builds **will** share a room. Rules:

1. **Never make a new feature *required* for the baseline call.** It must degrade when an old peer
   is present (e.g. an old peer that ignores `caps` just enforces kind-defaults locally — the call
   still works; the new peer simply doesn't get the new guarantee against the old one).
2. **Advertise + down-level (live).** Every peer rides its `engine` version + a `features` tag
   list on the roster — carried under a reserved `~kbz` meta key (so the app's own `meta`
   namespace stays clean) and surfaced as `participant.engine` / `participant.features`. A newer
   peer can read what an older one supports (e.g. `caps.v1`, `schema.v1`) and negotiate to the
   intersection rather than assuming support, instead of guessing from behavior.
3. **Test version skew**, not just two copies of the same build — old `widget.js` ↔ new.
   [`src/core/versionSkew.test.ts`](src/core/versionSkew.test.ts) pins this in CI: a HEAD engine
   and a *frozen v0.1.0-shaped* peer share a room over `createLocalBus` — a new `schema` message is
   dropped by the old decoder (forward-compat) while every shipped kind still decodes (the live
   decoder is a superset, never narrower), and the `~kbz` engine block degrades cleanly both ways.
   (The live two-bundle check belongs in the Playwright e2e matrix; this guards the wire contract.)

## Keeping old versions live (static-hosting strategy)

Because Kibitz is a **static site**, it can host every build at an **immutable, versioned path**
*and* keep the rolling latest:

```
/widget.js            → rolling latest (auto-updates; can't carry a fixed SRI hash)
/v0.1.0/widget.js     → frozen forever; SRI-able; pin this for production
/v0.2.0/widget.js     → …
```

This solves **two** different problems — but note what it does and does **not** do:

- ✅ **Embed pinning / integrity.** An integrator pins `…/v0.1.0/widget.js` + an `integrity=` hash
  and gets exactly the build they tested, forever. (Better than "self-host to pin".)
- ✅ **Optional: pin the version *in the room link*** (e.g. `?v=0.1.0`). If the loader routes every
  joiner of a room to the same versioned build, then **everyone in a room runs identical code —
  zero intra-room wire skew.** Skew then only exists *across* rooms, which never talk, so it's
  harmless.
- ❌ **It does NOT replace the additive-wire rules.** Unlike a client-server app, there is no
  translator: two people in a call still talk wire-to-wire. Keeping old builds alive makes old
  clients live *longer*, which makes forward/backward wire-compat **more** important, not less.
- ⚠️ **Security floor.** Pinning a room to an old build means security fixes don't reach it. So a
  pin-the-version scheme needs a **minimum-supported-version floor**: a room pinned below the
  floor is force-upgraded (reload to latest) regardless of its `?v=`. Always-latest (`/widget.js`)
  is the opposite trade — instant security propagation, at the cost of intra-room skew during the
  rollout window (handled by the additive rules + the stale-chunk reload in `core/staleChunk.ts`).

**Status:** versioned hosting is **live** — each release is frozen at `kibitz.chat/v<version>/widget.js`
(committed under `public/v<version>/`, served on every deploy), so embedders can pin + SRI today
(see docs §5; `scripts/freeze-release.mjs` cuts a new one). The default embed is still **always-latest**
(`/widget.js`). The **pin-the-version-in-the-link** option (zero intra-room skew) is the next step to
adopt when it's worth the "rooms can go stale" trade.

### The kill-switch: minimum-supported-version floor (live)

Pinning lets a build live forever, so a build is also baked with its SemVer (`__APP_VERSION__`) and
checks a small static **`/min-version.json`** at the origin it was served from, at boot
(`core/minVersion.ts`). If its version is **below** `min`, it treats itself as **retired** — the
engine refuses to connect and shows a "reload to update" notice. **Fail-open** by design: a missing
file / network error / no `min` ⇒ run (a blip never bricks a call); the default ships `min: 0.0.0`
(nothing retired). To retire a vulnerable build, raise `min` in `public/min-version.json` and deploy.
Each deployment controls its own floor (a self-hoster's build checks *their* origin's file).

## Shipping fast under these rules

- **Feature-flag → bake → progressive default.** New behavior ships additive / default-off, gets a
  2-device interop test (with version skew), then becomes default. (How the capability/identity
  wave shipped.)
- **Conformance fixtures** (`conformance.test.ts`) are the enforcement: refactor `protocol.ts`
  freely; the moment you break a shipped shape, an id, a link, or the nonce, CI screams.
- **The `kbz-v1-` bump is the once-a-decade nuclear option.** If you ever truly need an
  incompatible break, bump the prefix and run two ecosystems in parallel (old rooms on the old
  build, new rooms on `kbz-v2-`); optionally have the authority claim both ids during a window.

## When breaking is correct

Additive by default — but a **security** change that must reject non-conforming peers is a
*deliberate* incompatibility, and that's right (the authority-level identity gate denying old
unverified clients; media gating that fails closed). The rule isn't "never break"; it's "break only
when the security model requires it, do it consciously, and record it here."

## Changelog

Breaking changes and the deprecations leading to them are recorded in [CHANGELOG.md](CHANGELOG.md).
