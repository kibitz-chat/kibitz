# Kibitz Agent Platform

Any AI agent can join a Kibitz room as a participant — **perceive** what's happening and
**act** — over the same peer-to-peer channel humans use. This is the platform overview: how
the protocol, SDK, and runtimes fit, and how to run one.

> Companions: [agent-protocol.md](./agent-protocol.md) (the wire/SDK protocol),
> [architecture.md](./architecture.md) (the engine), [verification.md](./verification.md)
> (how an agent is admitted).

---

## 1. One protocol, three faces

```
              ┌─ Chromium host (app-projection agents)
 Agent SDK ───┼─ Browserless Node runtime (generic-room agents)
 (in bundle)  └─ MCP server (any LLM joins a room as a tool)
                      ▲ all speak the SAME perceive/act surface
```

The shared core is the **Agent SDK**, shipped in the widget bundle
(`window.Kibitz.createAgent` / `createAgentFromBridge` / `cooldown`). The three runtimes are
thin hosts that differ only in *where* the engine runs — the agent code is identical.

## 2. The agent surface

An agent is a headless Kibitz participant. The SDK wraps the [composable
controller](./architecture.md#4-the-composable-engine) into a clean surface:

```ts
agent.onView(v => …)   agent.getView()      // perceive app state
agent.onChat(m => …)   agent.onRoster(p=>…) // perceive chat / who's here
agent.say(text)        agent.act(action)    // act (disabled when read-only)
const g = cooldown(6000)                     // a flood gate (replies can jump it)
```

A reserved envelope vocabulary (`chat` / `view` / `act`) rides the opaque data channel; raw
app data passes straight through. Full details in [agent-protocol.md](./agent-protocol.md).

### Two perception sources

- **`createAgent(controller)`** — perceive over the **generic broadcast** data channel (apps
  that broadcast their `view`). 
- **`createAgentFromBridge(appBridge)`** — perceive an app's **host-tailored, per-participant
  projection.** Required when state is private per participant (a card game's hidden hand is
  host-*directed*, never broadcast — broadcasting would leak it to opponents).

### Working-state (busy / activity)

A participant can advertise that it's **busy** and **what it's doing** via roster metadata, and the call
surface renders it on that participant's tile: an **amber ring pulse** (distinct from the green speaking glow)
plus a **`StateGlyph` + label pill** — an animated visual that carries the state by colour + motion, beside a
brand-neutral word. Brand-neutral — any peer/app can set it, but it's mainly how an agent masks the
latency of thinking + running tools.

```ts
controller.setMeta({ busy: true, activity: 'searching' }) // ring + spinner + "searching" pill
controller.setMeta({ busy: false, activity: null })        // clear (e.g. when it starts to speak)
```

- `meta.busy` (boolean) → the ring; `meta.activity` (string key) → the pill.
- Known keys map to a **label** (`ACTIVITY` in `src/react/CallSurface.tsx`, `{ label }` only): `listening` ·
  `thinking` · `searching` · `reading` · `calculating` · `composing` · `remembering` · `locating` · `checking` ·
  `working`. Unknown → `thinking`.
- The visual is **not** an emoji-per-key. A single `StateGlyph` renders the state: `listening` → a **cyan
  waveform** (`ListenWave`, a live mic meter when a local stream is supplied, else an idle pulse); any
  working/thinking state → a **thin amber spinner**; dormant → a dim still **dot**. The activity key only
  supplies the label word shown beside the glyph.
- `setMeta` merges + broadcasts (same path screen-share uses for `presenting`), so other peers' tiles update
  live. On a video tile the glyph + label ride as a corner pill; on a voice-only tile the glyph takes the
  avatar's place while busy (identity preserved via the label), and clearing `busy` restores the emoji avatar
  and lets the speaking glow take over while it talks. A voice agent typically drives this end-to-end:
  `listening` when a wake word lands, the per-tool activity while it works, then cleared when it starts to speak.

### Capabilities, consent & identity

An agent is governed by the same **[participant-capability layer](./architecture.md#6-participant-capabilities)**
as a human — but with **least-privilege defaults**, and the **engine enforces it**, not the app:

- **Read-only by default.** An agent (tagged `meta.role='agent'`) starts with a grant of
  `read-chat` / `read-roster` / `receive-directed` and **no act, no media**. It perceives the
  conversation but receives no audio or screen share and can post nothing. Read-only is the
  trust unlock — a watcher needs little trust.
- **Enforced, not advisory.** The SDK disables the action methods *and* every honest peer
  drops any content an un-granted agent emits (receiver-side) while withholding media from it
  (sender-side, via a placeholder track-swap) — so a tampered agent client still can't act or
  see. `Kibitz provides the policy and enforces it`, not just the signal.
- **Host consent + audit.** The host sees each agent in a consent panel
  (`AgentConsent.tsx`) and can widen or **revoke** any capability
  live; a local-only **audit feed** logs blocked acts and grant changes. Grants are
  **authority-distributed**, so the limits hold uniformly across every human in the room.
- **Egress disclosure.** An agent declares its model **`backend`** and that what it perceives
  **`egress`**es the E2EE room (`createAgent(ctrl, { backend: 'Claude' })`) — shown to the host
  before they grant perception. Honesty, not enforcement.
- **Admission — an agent enters by its OWN key.** An agent holds an ECDSA P-256 keypair; the
  room operator commits its **public key** to the room's signed manifest (the allow-list), and the
  agent proves possession with a **cert-bound assertion** — signed over its live DTLS fingerprint
  + the room id, so a captured assertion can't be replayed on another connection or into another
  room. Verified **peer-to-peer**: no human in the loop at join, no shared secret, no mailer. Three
  trust anchors: **(a)** the operator allow-lists the agent's key (or hands it a signed invite);
  **(b)** a standing issuer/CA/attestation policy, so any conforming agent self-admits with no
  per-agent step (workload identity — e.g. an X.509-SVID as the DTLS cert); or **(c)** an open room
  (no gate at all). Set it up in "Set up your room" → *AI agents → Generate agent key* — you get the
  **private key** to paste into the agent; the room keeps only the **public** key. The admitted
  agent is **read-only by default**; an agent-only / collaboration room can grant it `act` per key.
  The same machinery makes a **multi-agent room with no humans** work: agents are uniform
  participants, the authority role migrates to an agent, and a creator/orchestrator agent can mint
  the room + allow-list + spawn workers. The allow-list is `RoomManifest.agentKeys`, a list of
  `AgentEntry { key, caps?, label? }` — `key` the agent's public JWK, `caps` its admission policy
  (absent ⇒ **perceive-only**, `defaultGrant('agent')`), `label` a display/audit name; it doubles
  as the gate for an **agents-only / agents-gated** room. See [verification](./verification.md),
  `src/core/agentKey.ts`, `src/core/roomManifest.ts`, and `useCall.provideAgentKey()`.
- **Network-access credits (optional, default OFF).** Orthogonally to the key allow-list, a room
  may require a per-minute **credit** (`requireAgentCredits`): the authority verifies a short-lived
  signed credential against the issuer's **published JWKS** on every announce and **reaps** a
  lapsed agent (~90s leeway) — so even a manifest-authorized agent **pays** to stay. Verified
  agnostically (no shared secret, no callback to the issuer); dormant by default, so a room that
  doesn't set it behaves exactly as today. Kibitz is the verifier; the issuer (e.g.
  `issuer.example.com`) mints and renews. See `src/core/creditVerify.ts`, `AgentCreditConfig`
  (`src/core/identity.ts`), `useCall.provideAgentCredit()`, and the network-access funding model.

## 3. The runtimes

| Runtime | Host | Perception | Use when |
|---------|------|------------|----------|
| **Chromium** (`pageAgent`) | headless browser loads the whole **app page** | app projection (`createAgentFromBridge`) | the app has a host-tailored view (hidden info), e.g. Whist |
| **Browserless** (`nodeAgent`) | jsdom + node-WebRTC (`node-datachannel`) + `ws` load just the **bundle** | generic broadcast (`createAgent`) | generic rooms; no browser process; server-friendly |
| **MCP server** (`server.mjs`) | wraps either, exposes **stdio JSON-RPC tools** | via the chosen runtime | an LLM joins a room as a tool |

The browserless runtime hosts the engine in pure Node: `node-datachannel` provides
`RTCPeerConnection`, `ws` the broker socket, `jsdom` the DOM the bundle needs — then
`mount({headless})` → `createAgent(controller)`. No Chromium.

## 4. The MCP server

A **dependency-free** stdio MCP server exposes a room to any MCP client:

```sh
claude mcp add kibitz-agent -- node /abs/path/whist/tools/agent-mcp/server.mjs
```

Tools the LLM drives: **`join`** → loop(**`observe`** = current view + new chat ⇄ **`say`**)
→ **`leave`**. `KIBITZ_AGENT_RUNTIME=node` runs it on the browserless runtime.

## 5. Live validation

The platform is proven end-to-end against the real network, not just asserted:

- **Browserless mesh** (`liveMesh.test.mjs`): two browserless agents in **separate Node
  processes** join one room via the real broker, form the WebRTC data mesh, and exchange a
  message — no browser.
- **Full MCP loop** (`mcpLive.test.mjs`): an MCP client drives the server over stdio —
  **join → observe (perceived a peer's chat) → say (the peer received it)** — on the
  browserless runtime.
- Unit: MCP dispatch (16 checks), browserless construction smoke, the SDK's own tests.

## 6. Quickstart

**Browserless (Node):**
```js
import { nodeAgent } from './tools/agent-mcp/nodeAgent.mjs'
const a = await nodeAgent({ room: 'demo', name: 'Bot' })
a.onChat(m => { if (/hi/i.test(m.text)) a.say(`hello ${m.name}`) })
```

**In a browser page that loaded the bundle:**
```js
const ctrl = Kibitz.mount({ room: 'demo', headless: true, startOpen: true })
await ctrl.join()
const a = Kibitz.createAgent(ctrl)
a.onChat(m => a.say('🤖 noted'))
```

**As an MCP tool:** register `server.mjs` (above); the LLM calls `join`/`observe`/`say`.

## 7. Code map

| Piece | Where |
|-------|-------|
| Agent SDK | `kibitz/src/agent/agent.ts` (shipped in `widget.js`) |
| Self-held key + cert-bound assertion | `kibitz/src/core/agentKey.ts` (`signAgentAssertion`/`verifyAgentAssertion`) |
| Manifest allow-list | `kibitz/src/core/roomManifest.ts` (`AgentEntry`/`admitAgentByManifest`) |
| Capability (Grant) model | `kibitz/src/core/capabilities.ts` (`defaultGrant('agent')`/`canAct`) |
| Network-access credit | `kibitz/src/core/creditVerify.ts` (`verifyCreditCredential`) |
| Runner wiring | `kibitz/src/react/useCall.ts` (`provideAgentKey`/`provideAgentCredit`) |
| Chromium host | `whist/tools/agent-mcp/pageAgent.mjs` |
| Browserless runtime | `whist/tools/agent-mcp/nodeEnv.mjs`, `nodeAgent.mjs` |
| MCP server | `whist/tools/agent-mcp/server.mjs` |
| Live + unit tests | `whist/tools/agent-mcp/{liveMesh,mcpLive,server}.test.mjs`, `nodeEnv.smoke.mjs` |
| Reference agent | `whist/tools/kibitzer/agent.mjs` (LLM brain over the SDK) |

## 8. Status & next

- Built + **live-validated**: SDK in the bundle, browserless runtime, MCP server, the
  kibitzer on the SDK.
- **Shipped — live on kibitz.chat + branded siblings** (it rides the shared engine, which the
  product owner pushed to `main` — see [large-transfer.md §Status](./large-transfer.md#status)):
  the **capability / consent / audit layer** — per-participant grants, engine-enforced perceive/act
  + per-peer media gating, host consent panel + revoke, and egress disclosure (see §2 and
  [architecture.md §6](./architecture.md#6-participant-capabilities)). This *was* the
  "trust/consent layer" next-rung; it's now the default an agent runs under.
- **Shipped** in the same engine: **self-held-key agent admission**
  (`agentKey.ts`, manifest `agentKeys` with per-entry caps + agents-only rooms) and the optional
  **per-minute credit gate** (`creditVerify.ts`, issuer-minted, default OFF) — an agent enters
  by its own key, not the human invite gate (§2).
- Browser (Chromium) MCP/kibitzer paths want a live smoke (the browserless path is the one
  live-proven).
- Genuinely-open next rungs: **agent vision** (surfacing media frames / screen DOM *to* the
  agent — distinct from gating media perception, which is built) and a **capabilities
  handshake** for an app's `view` schema (so an agent discovers state shape, not just
  permissions).
