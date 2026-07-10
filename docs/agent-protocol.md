# Kibitz Agent Protocol (draft v0)

How an AI agent joins a Kibitz room, **perceives** what's happening, and **acts** —
over the same peer-to-peer data channel humans use. No new transport, no server.

> One protocol, three faces. This spec is the core. The **JS SDK** (`createAgent`),
> an **MCP server**, and third-party agents are all thin adapters that speak it.

## 1. What an agent is

An agent is just a **headless Kibitz participant** — the composable-engine controller
(`mount({ headless })` → `MountedWidget`) with a brain wired to it. It joins a room by
**its own key** (an allow-listed agent key + a cert-bound assertion — §5, *not* the human
invite gate), appears in the roster, and exchanges messages over the DTLS-encrypted data
mesh. The live
[Whist kibitzer](https://github.com/kibitz-chat/whist/tree/main/tools/kibitzer) is the
reference: it watches a seat and chats, using exactly this surface.

## 2. Perception — two layers

Kibitz relays **opaque, structured-cloneable data** between participants; it never
inspects it. So perception is layered:

- **Generic (Kibitz-native):** the roster (who's here, names, roles, meta, speaking,
  camera), presence (join/leave), **chat** (a reserved envelope, below), and raw app
  data. Optionally media streams (for vision — later).
- **App-defined views:** an app publishes a structured snapshot of its own state (a game
  position, a shared doc, a form) as app messages. An agent that understands that app
  interprets them. Kibitz carries the bytes; the **schema is the app's**. (Whist publishes
  a `view` each turn; the kibitzer reads `pub`/`myHand`/`chat` out of it.)

**Two perception sources, one agent surface.** Some state is PRIVATE per participant — a
card game's hidden hand, a DM — and the host **directs** each participant's tailored view;
broadcasting it would leak the hand to opponents. So there are two constructors that yield
the same agent shape:
- **`createAgent(controller)`** — perceive over the generic broadcast/`onMessage` channel.
- **`createAgentFromBridge(appBridge)`** — perceive an app's host-tailored, per-participant
  projection (Whist's `onView`/`sendChat`). The right choice for hidden-information apps. Its
  `BridgeAgent` is a **strict subset** — `onView`/`getView`/`onChat`/`say` only (view + chat),
  with no `act`/`send`/roster/schema; those need the full controller
  ([`src/agent/agent.ts:178`](../src/agent/agent.ts)).

Both are exported from the Kibitz bundle (`Kibitz.createAgent` / `Kibitz.createAgentFromBridge`
/ `Kibitz.cooldown`), so a page that loads `widget.js` can build an agent with no import step.

## 3. The envelope vocabulary

A tiny universal vocabulary rides the opaque channel under a reserved key **`__kib_agent`**
(`src/agent/agent.ts`). Everything else is passed through untouched as raw app data. (Note:
this is the *agent SDK's* envelope key — distinct from Kibitz core's `ContentMsg.k`
discriminator, which the SDK does not use. That core discriminator has grown well past the
original handful; as of this writing it is
`chat|img|xbegin|xaccept|xdecline|xresume|xack|xchunk|xend|xcancel|app|pay|ink|idtoken|caps|schema|ledger|chatledger|ctl|widget|wevt`
— `chat`/`img` are now legacy single-message fallbacks, content rides the `x*` chunked-transfer
kinds, and `widget`/`wevt` carry bounded interactive widgets like a map. See `src/core/protocol.ts`.)

| `__kib_agent` | direction | payload | meaning |
|-----|-----------|---------|---------|
| `chat` | both | `{ text }` | a chat line (shows in apps that map it to their chat UI) |
| `view` | app → agent | `{ view }` | an app-state snapshot for agents to perceive |
| `act`  | agent → app | `{ action }` | an action request the app may honor (or ignore) |

Raw (un-enveloped) messages are delivered to `onData` verbatim — apps that already have
their own format keep using it.

**Self-description (schema discovery).** A `view` is opaque by design, so an app can publish a
**schema** of its shape on a separate engine channel (`ContentMsg.k='schema'`,
`registerSchema(name, version, schema)`), re-broadcast to late joiners so discovery is
order-independent. An agent reads them with **`getSchemas()` / `onSchema()`** (§7) and learns
how to interpret the `view` without out-of-band docs. This is *state shape*, orthogonal to the
capability layer (§4): publishing is gated by `send-chat` like any emission, so a read-only
agent consumes schemas but doesn't publish them.

## 4. Capabilities — a grant the engine enforces

The trust unlock is that **most agents only need to watch** — and Kibitz makes "watch only"
a *guarantee*, not a convention. Every participant carries a **`Grant`**
([`src/core/capabilities.ts`](../src/core/capabilities.ts)) of what it may **perceive** and
**act**:

- **Perceive:** `see-screen`, `hear-audio`, `read-chat`, `read-roster`, `receive-directed`, `read-media`, `read-files`.
- **Act:** `send-chat`, `speak`, `act`.

Defaults are by kind: a **human is full**; an **agent** (`meta.role='agent'`, set by
`createAgent`) starts **read-only** — `read-chat`/`read-roster`/`receive-directed`, no act,
no media, no images/files.

**Unified content transfer.** Text, images, and files all travel as a chunked transfer over the
reliable+ordered P2P data mesh — `ContentMsg` `xbegin {id,kind,size,n,mime?,name?}` → `xchunk
{id,i,data}`… (base64, paced against the channel's buffered amount) → `xend {id}`, with `xcancel`
to abort. The channel guarantees order + delivery, so the receiver just reassembles `n` chunks
(bounded, per-peer concurrency, stall timeout): small transfers reassemble **in RAM** — the 50 MB
**inline** tier (`INRAM_MAX_BYTES`) — and anything larger **streams straight to disk** rather than
being capped there (OPFS to ~1 GB, or a chosen File System Access download file up to the 50 GB
absolute ceiling `MAX_XFER_BYTES`; see `src/core/chunkSink.ts`). This lifts the single-message size
limit, so a file or a full-resolution image rides the same path as a chat line. (A peer on an older
build that doesn't advertise `xfer.v1` is sent the legacy single-message `chat`/`img` instead, so
cross-version chat never breaks; those kinds stay decodable forever.)

**Images + files are opt-in for agents (`read-media` / `read-files`).** Each transfer is gated by its
kind's perceive cap — text=`read-chat`, image=`read-media`, file=`read-files` — all distinct, so an
agent admitted to the text conversation does **not** receive image bytes or files until the host
turns those on. Once granted, a vision-capable agent receives images via the `image` event
(`mount().on('image', …)`) / `controller.onImage`, attributed by roster, never the wire. Humans have
all three by default. Sending is gated like any emission (`send-chat`).

**Posting an image / file (the agent's output side).** A headless agent whose *tool* produced an image
or file posts it with `controller.sendImage(payload)` / `sendFile(payload)`, where `payload` is
`{ mime, data, name? }` and `data` is **base64** (the controller turns it into a File and runs the chunked
transfer above — no inline-image size cap; an image renders inline). This is the transport behind a
tool-producing-an-image agent: the brain emits only text, a tool returns image bytes, and the result is
surfaced into the room here. (A downstream agent runtime can bind a tool's image/file result to these
methods — e.g. exposing them as `image`/`file` output surfaces in its own tool-affordance layer.)

**Two layers of enforcement, not one:**

1. **The SDK** disables `say`/`act`/`send` when `readOnly` (they throw).
2. **The engine** enforces the grant *per peer*, so a tampered agent client still can't
   act or see:
   - **act = receiver-side drop** — every honest peer ignores chat/app/pay/ink from a peer
     whose grant lacks `send-chat` (the `canAct(grantOf(from), 'send-chat')` check in the dispatch
     handler before delivery, [`src/react/useCall.ts:1175`](../src/react/useCall.ts)), and logs a
     blocked agent emission to the host audit (`logAudit(from, 'blocked', c.k)`,
     [`useCall.ts:1176`](../src/react/useCall.ts)).
   - **perceive = sender-side withholding** — a peer never delivers data a recipient can't
     see, and a withheld **media** lane (`see-screen`/`hear-audio`) is swapped for a flowing
     placeholder on that peer's connection (`mesh.gatedTrack`) — so a read-only agent gets no
     audio and no screen share, ever.

So **Kibitz provides the policy and enforces it**, not merely the signal. The host can widen
or revoke a grant live (consent panel + local audit feed), and the **authority distributes**
the grant map (a `caps` control message) so the limits hold uniformly across every human in
the room — see [architecture.md §6](./architecture.md#6-participant-capabilities). (The SDK
`act()` *envelope* in §3 is a message kind; the cap that currently gates an agent's emission
is `send-chat`.)

**Disclosure (`backend`/`egress`).** An agent may declare the model it routes perception to —
`createAgent(ctrl, { backend: 'Claude' })` tags `meta.backend` and `meta.egress`, shown to the
host as "what it sees leaves the E2EE room." Honesty surfaced for consent, not a privilege.

## 5. Identity — an agent enters by its OWN key

An agent is **not** let in through the human invite/join gate — it has its own admission path,
distinct from a human's. The agent holds an **ECDSA P-256 keypair**; the room commits its
**public key** to the room's signed manifest, and the agent proves possession with a
**cert-bound assertion** the authority verifies before rostering — peer-to-peer, no human in
the loop, no shared secret, no mailer. (`agent-platform.md` §2 describes the same model.)

- **The allow-list.** The signed `RoomManifest.agentKeys` is a list of `AgentEntry { key, caps?,
  label? }` ([`src/core/roomManifest.ts:71`](../src/core/roomManifest.ts)): `key` is the agent's
  public JWK, `caps` is the capability policy it gets on admission (absent ⇒ **perceive-only**,
  `defaultGrant('agent')`, clamped by `sanitizeGrant`), `label` is a display/audit name. Signed
  with the rest of the manifest, so the allow-list **and** the granted powers are tamper-proof
  and room-bound; the entry is public, so it's safe in the link. `agentKeys` is a valid
  standalone allow-list — a room can be **agents-only / agents-gated** with humans left open
  (`verifyManifest`, [`roomManifest.ts:135`](../src/core/roomManifest.ts)).
- **The assertion.** The agent signs over the **room id + its own live DTLS fingerprint + an
  issued-at** (`signAgentAssertion`, [`src/core/agentKey.ts:67`](../src/core/agentKey.ts)),
  re-signing per (re-)announce so it stays fresh. Cert-binding stops a captured assertion from
  being replayed on another connection; room-binding + freshness stop cross-room / stale replay.
- **The check.** The authority verifies against the allow-list and resolves the matched entry's
  caps in one bridge (`verifyAgentAssertion` / `admitAgentByManifest`,
  [`agentKey.ts:96`](../src/core/agentKey.ts) + [`roomManifest.ts:84`](../src/core/roomManifest.ts)).
  In the engine this is the `withAgentGate` branch — an `agentAssertion` is admitted off the
  manifest *before* the human verify path
  ([`src/widget/Widget.tsx:557`](../src/widget/Widget.tsx)); a room with no agent keys simply
  admits no agents. The runner supplies the agent's private key via
  `useCall.provideAgentKey()` ([`src/react/useCall.ts:1097`](../src/react/useCall.ts)), which
  re-signs on a timer. `agentKeyThumbprint` ([`agentKey.ts:59`](../src/core/agentKey.ts)) is the
  short stable key id for allow-listing and audit.

Three trust anchors: **(a)** the operator allow-lists the agent's key (or hands it a signed
invite); **(b)** a standing issuer/CA/attestation policy, so any conforming agent self-admits
with no per-agent step (workload identity); or **(c)** an open room (no gate). **Revocation =
drop the key from the manifest.**

**Optional per-minute credit gate.** Orthogonally to the key allow-list, a room may require a
declared agent to **pay** for its presence. When the gate is set (`requireAgentCredits`, default
**OFF** → fully dormant), a manifest-authorized agent must ALSO present a fresh **RS256 credit
credential**, which the authority verifies *agnostically* against the issuer's **published JWKS**
— no shared secret, no callback (`verifyCreditCredential`,
[`src/core/creditVerify.ts:49`](../src/core/creditVerify.ts);
`AgentCreditConfig`, [`src/core/identity.ts:17`](../src/core/identity.ts)). The credential is
short-lived (~60s TTL); the runner re-supplies it ~every minute via `useCall.provideAgentCredit()`
([`useCall.ts:1118`](../src/react/useCall.ts)), the authority **re-verifies on every announce**
and re-stamps the rolling expiry, and a lapsed agent is **reaped** ~90s past expiry
(`CREDIT_REAP_LEEWAY_SEC`, [`src/core/room.ts:126`](../src/core/room.ts);
reap at [`room.ts:671`](../src/core/room.ts)). Even a manifest-authorized agent pays. Kibitz is
the **agnostic verifier**; the issuer (e.g. `issuer.example.com`) mints and renews the passes —
see the network-access funding model.

## 6. Runtime — how it actually connects

Kibitz is WebRTC, so the agent needs a WebRTC stack. Three rungs, increasing in effort:

1. **Engine in a (headless) browser** — Playwright hosts the *app page*; the agent calls
   `createAgentFromBridge(appBridge)`; a Node side bridges to the LLM. **Works today** (the
   kibitzer, and `whist/tools/agent-mcp/pageAgent.mjs`). Needed when perception comes from an
   app's host-tailored projection (hidden hands).
2. **Node-WebRTC runtime (browserless)** — jsdom + `node-datachannel` + `ws` host just the
   Kibitz bundle; `mount({headless})` → `createAgent(controller)`, no browser process.
   **Built + LIVE-VALIDATED** (`whist/tools/agent-mcp/`): two browserless agents in separate
   Node processes join one room via the real broker, form the WebRTC data mesh, and exchange
   a message — no browser (`liveMesh.test.mjs`).
3. **MCP server** — wraps (1) or (2) and exposes `join` / `observe` / `say` / `leave` so any
   LLM joins a room as a tool. **Built** (`whist/tools/agent-mcp/server.mjs`, dependency-free
   stdio JSON-RPC; `KIBITZ_AGENT_RUNTIME=node` selects the browserless runtime).

The agent code (Section 7) is identical across all three — only the host differs.

**Transport is swappable (design intent — the WS-relay controller is not built).** `createAgent`
is written against a minimal `AgentController` (`broadcast` / `onMessage` / roster) — it does
**not** assume WebRTC, which is what *makes* a swap possible. An agent *samples* (request/response:
"give me the view", "say this"), which a **WebSocket relay** would carry better than a media mesh
(simpler, no TURN, serverless-friendly). So the *recommended* backing for *agent* traffic is a
WS-relay controller — but **no such controller ships today**; the live runtimes (§6) all use the
WebRTC mesh. Reserve WebRTC for human↔human live co-browse and real-time duplex voice. Same
`AgentSession`, different controller underneath, *if/when* a WS-relay controller is written.

## 7. The agent surface

See [`src/agent/agent.ts`](../src/agent/agent.ts) for the typed interface. The shape:

```ts
// options: { readOnly?, backend?, egress? } — backend/egress are the disclosure (§4)
const a = createAgent(controller, { readOnly: true, backend: 'Claude' })
a.onView((view) => { /* perceive app state */ })
a.getView()                  // the CURRENT app state (e.g. to answer a chat about it)
a.onChat((m) => { /* m.name said m.text */ })
a.onRoster((people) => { /* who's here */ })
a.getRoster()                // current roster snapshot
a.onSchema((s) => { /* s.name@s.version describes s.schema */ })
a.getSchemas()               // every app schema published so far (how to read the view)
a.canAct                     // false when readOnly (and the engine enforces it regardless)
// acting (guarded — throw when readOnly):
a.say('nice lead')           // chat
a.act({ play: '7♠' })        // request an app action
a.send(payload, toId)        // raw opaque data
// posting a BOUNDED interactive widget into the room (first-party renderer; data only, never code):
a.showWidget('chart', data)  // returns the instance id; emits a `widget` ContentMsg
a.showMap({ center, zoom, markers })  // convenience over showWidget for a map
a.onWidgetTap((m) => { /* a viewer interacted with a widget instance (a `wevt`) */ })
a.leave()
// rate gate so the agent doesn't flood (replies can ignore it to jump the queue):
const gate = cooldown(6000); if (gate.ready(now)) { gate.stamp(now); a.say(line) }
```

## 7a. Validated against the live kibitzer

This shape isn't designed in a vacuum — the production Whist kibitzer's perceive→decide→act
loop was refactored onto it (`whist/tools/kibitzer/agent.mjs`). Doing so **surfaced and
folded back** three things the first draft lacked:
- **`getView()`** — an agent replying to a chat line needs the *current* state to answer.
- **`cooldown(ms)`** — every agent needs a flood gate; it was hand-rolled, now it's in the SDK.
- **agent-vs-agent filtering via `meta.role`** — the kibitzer skipped other agents by a
  uid-prefix hack; the protocol does it cleanly off the role tag every agent sets.

The kibitzer's game-specific code shrank to one "view interpretation" block; its agent logic
is now transport- and app-agnostic. (It still runs an *in-page mirror* of the SDK, since the
Playwright page can't import the TS module — see Section 8.)

## 7c. Host menus — letting the agent open a BRAND panel

An agent can also surface a **brand-owned** menu in the call (e.g. a rating page) by adding a `hostMenu`
field to its `agent-actions` manifest. Crucially this is **not** routed to the agent: Kibitz frames the
brand's own page on a **build-fixed origin** (`menuOrigin`) and passes only `room` + an opaque `agent` id —
so the page talks to the brand's backend directly and the agent (which may be the rated party) is never in
that data path. The agent can only *enable* the menu and name a relative path/label; it can never choose the
origin (anti-phishing). Full contract: [`host-menu.md`](./host-menu.md).

## 8. Open questions (for v0 → v1)

- **Vision:** when do we surface media frames / screen DOM *to* the agent, and as text or
  pixels? (Start with app-published `view`; add frames later. Note this is the *inbound*
  question — gating an agent's media *perception* is already built, §4.)
- **Code-sharing:** the SDK ships from the bundle (`Kibitz.createAgent` /
  `createAgentFromBridge` / `cooldown`) and the kibitzer prefers it; the last step is
  re-vendoring the current Kibitz bundle into Whist to delete the inline fallback — a release
  chore, not a design question.

_Resolved since v0:_
- _**Self-held-key admission** (§5): an agent enters by its OWN allow-listed key + a cert-bound
  assertion (`agentKey.ts`, manifest `agentKeys`) — not the human invite gate — with per-entry
  caps and agents-only-room support._
- _**Per-minute credit gate** (§5): an optional, default-OFF network-access toll — the authority
  re-verifies a short-lived RS256 credit credential against the issuer's published JWKS each
  announce and reaps a lapsed agent (`creditVerify.ts`, issuer-minted). Shipped in code, pending
  a 2-device live test._
- _The **capability / consent / audit layer** is built and enforced (§4) — read-only is now an
  engine guarantee, with host consent, revoke, audit, egress disclosure, and
  authority-distributed grants._
- _**Schema discovery** is built (§3/§7): an app self-describes its `view` shape over a `schema`
  engine channel, re-broadcast to late joiners, consumed via `getSchemas()`/`onSchema()`._
- _**Feature negotiation** rides the roster — every peer advertises its `engine` version +
  `features` (e.g. `schema.v1`) so a newer build can see what an older one supports
  ([COMPATIBILITY.md](../COMPATIBILITY.md)). From the kibitzer refactor (§7a): `cooldown` and
  `getView()` are in the SDK; agent-vs-agent filtering rides `meta.role`._
