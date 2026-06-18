import type { Participant } from '../widget/Widget'

// The Kibitz Agent SDK (draft v0) — a thin, transport-agnostic wrapper that turns the
// headless composable-engine controller into a clean perceive/act surface for an AI agent.
// See docs/agent-protocol.md. It speaks the envelope vocabulary over the existing opaque
// data channel; it adds NO new transport. Pure adaptation, so it's unit-testable with a
// fake controller and reusable from a browser page, a Node-WebRTC runtime, or an MCP server.

/** Reserved envelope key. Anything without it is raw app data → delivered to `onData`. */
const K = '__kib_agent'
type Envelope =
  | { [K]: 'chat'; text: string }
  | { [K]: 'view'; view: unknown }
  | { [K]: 'act'; action: unknown }

const isEnvelope = (d: unknown): d is Envelope =>
  typeof d === 'object' && d !== null && typeof (d as Record<string, unknown>)[K] === 'string'

export type AgentParticipant = Participant

export interface ChatMessage {
  /** Sender's participant id. */
  from: string
  /** Sender's display name (resolved from the live roster, '' if unknown). */
  name: string
  text: string
}

/** An app self-describing the shape of its messages / view, broadcast over the engine's schema
 *  channel so an agent can discover how to read them without out-of-band docs. */
export interface AgentSchema {
  /** Publisher's participant id. */
  from: string
  /** Stable schema identifier (e.g. 'whist.view'). */
  name: string
  /** App-defined version (e.g. '1.0.0'). */
  version: string
  /** The schema document (JSON Schema / sample / any structured shape). */
  schema: unknown
}

/** The minimal slice of the composable-engine controller the agent needs. `MountedWidget`
 *  satisfies this structurally, as does a fake in tests. */
export interface AgentController {
  broadcast(data: unknown): void
  sendTo(id: string, data: unknown): void
  onMessage(cb: (data: unknown, from: string) => void): () => void
  getParticipants(): AgentParticipant[]
  on(event: 'participants', cb: (people: AgentParticipant[]) => void): () => void
  setMeta(meta: Record<string, unknown>): void
  leave(): void
  // Schema discovery (optional — older controllers / test fakes may omit it; the agent then
  // simply reports no schemas). Lets an agent learn an app's message/view shape on the fly.
  getSchemas?(): readonly AgentSchema[]
  onSchema?(cb: (s: AgentSchema) => void): () => void
}

export interface AgentOptions {
  /** Watch-only: the action methods (`say`/`act`/`send`) are disabled, and the agent
   *  tags itself so the app/host can ignore any action it might still attempt. Default false. */
  readOnly?: boolean
  /** DISCLOSURE (shown to humans in the consent sheet, honesty not enforcement): the model/backend
   *  this agent routes what it perceives to, e.g. 'Claude'. Setting it implies room content LEAVES
   *  the E2EE room when the agent reads — so the human can consent with eyes open. */
  backend?: string
  /** Force the egress disclosure even without a named backend. A `backend` implies it. */
  egress?: boolean
}

export interface AgentSession {
  /** Subscribe to chat lines from others. Returns an unsubscribe fn. */
  onChat(cb: (m: ChatMessage) => void): () => void
  /** Subscribe to app-state snapshots (the `view` envelope an app publishes). */
  onView(cb: (view: unknown) => void): () => void
  /** The most recent app `view` snapshot, or null if none seen yet. An agent reacting to
   *  a chat line needs the current state to answer about it — the kibitzer revealed this. */
  getView(): unknown
  /** Subscribe to RAW app data (anything not a Kibitz agent envelope), with the sender id. */
  onData(cb: (data: unknown, from: string) => void): () => void
  /** The roster changed. */
  onRoster(cb: (people: AgentParticipant[]) => void): () => void
  /** Current roster snapshot. */
  getRoster(): AgentParticipant[]
  /** Every app schema published so far (yours + every peer's) — how to interpret the app's
   *  messages / view. Empty if the host app publishes none (or the controller predates discovery). */
  getSchemas(): readonly AgentSchema[]
  /** Subscribe to schemas as apps publish them. Returns an unsubscribe fn (no-op if unsupported). */
  onSchema(cb: (s: AgentSchema) => void): () => void
  /** Say a chat line (disabled when readOnly). */
  say(text: string): void
  /** Request an app action — the app decides whether to honor it (disabled when readOnly). */
  act(action: unknown): void
  /** Send raw opaque data to everyone, or one peer (disabled when readOnly). */
  send(data: unknown, to?: string): void
  /** Whether this session may act. */
  readonly canAct: boolean
  /** Leave the room. */
  leave(): void
}

/**
 * Wrap a headless controller as an agent session. Tags `meta.role='agent'` (+ `readOnly`)
 * so the room can reason about it. The controller is assumed already joined (mount with
 * `headless:true, startOpen:true`, or the host runner does the join).
 */
export function createAgent(controller: AgentController, opts: AgentOptions = {}): AgentSession {
  const readOnly = !!opts.readOnly
  // Tag the participant as an agent so the room's capability layer gives it least-privilege
  // (read-only) by default + surfaces its egress disclosure in the host's consent sheet.
  controller.setMeta({
    role: 'agent',
    readOnly,
    ...(opts.backend ? { backend: opts.backend } : {}),
    ...(opts.backend || opts.egress ? { egress: true } : {}),
  })

  const nameOf = (id: string): string => controller.getParticipants().find((p) => p.id === id)?.name ?? ''

  // Track the latest app view so `getView()` can answer "what's the state right now?"
  let lastView: unknown = null
  controller.onMessage((data) => {
    if (isEnvelope(data) && data[K] === 'view') lastView = data.view
  })

  const guard = (fn: () => void) => {
    if (readOnly) throw new Error('Kibitz agent is read-only — actions are disabled')
    fn()
  }

  return {
    onChat: (cb) =>
      controller.onMessage((data, from) => {
        if (isEnvelope(data) && data[K] === 'chat') cb({ from, name: nameOf(from), text: data.text })
      }),
    onView: (cb) =>
      controller.onMessage((data) => {
        if (isEnvelope(data) && data[K] === 'view') cb(data.view)
      }),
    getView: () => lastView,
    onData: (cb) =>
      controller.onMessage((data, from) => {
        if (!isEnvelope(data)) cb(data, from)
      }),
    onRoster: (cb) => controller.on('participants', cb),
    getRoster: () => controller.getParticipants(),
    getSchemas: () => controller.getSchemas?.() ?? [],
    onSchema: (cb) => controller.onSchema?.(cb) ?? (() => {}),
    say: (text) => guard(() => controller.broadcast({ [K]: 'chat', text } satisfies Envelope)),
    act: (action) => guard(() => controller.broadcast({ [K]: 'act', action } satisfies Envelope)),
    send: (data, to) => guard(() => (to ? controller.sendTo(to, data) : controller.broadcast(data))),
    canAct: !readOnly,
    leave: () => controller.leave(),
  }
}

// ── App-bridge path ────────────────────────────────────────────────────────────
// Not every app perceives over a broadcast channel. When state is PRIVATE per participant
// (a card game's hidden hand, a DM), the host tailors and DIRECTS each participant's view —
// it must NOT be broadcast (that would leak the hand to opponents). Such apps already have
// a per-participant projection; `createAgentFromBridge` adapts THAT to the agent surface,
// so the agent code is identical whether perception comes from the generic channel
// (`createAgent`) or an app projection (`createAgentFromBridge`).

/** An app's own per-participant projection: the host-tailored view + chat + a chat action. */
export interface AppBridge {
  /** Subscribe to the app's view snapshots (delivered by the host to THIS participant). */
  onView(cb: (view: unknown) => void): () => void
  /** The current view, or null if none yet. */
  getView(): unknown
  /** Subscribe to chat lines from others (sender id + name + text). */
  onChat(cb: (m: ChatMessage) => void): () => void
  /** Say a chat line. */
  say(text: string): void
}

/** The agent surface over an app bridge: perception + chat. (No generic data channel,
 *  roster, or rich `act`/`send` — those need the full controller.) */
export interface BridgeAgent {
  onView(cb: (view: unknown) => void): () => void
  getView(): unknown
  onChat(cb: (m: ChatMessage) => void): () => void
  say(text: string): void
  readonly canAct: boolean
}

/** Wrap an app's per-participant projection as an agent. Same agent logic as `createAgent`;
 *  only the perception source differs (a host-tailored, privacy-preserving projection). */
export function createAgentFromBridge(bridge: AppBridge, opts: AgentOptions = {}): BridgeAgent {
  const readOnly = !!opts.readOnly
  return {
    onView: (cb) => bridge.onView(cb),
    getView: () => bridge.getView(),
    onChat: (cb) => bridge.onChat(cb),
    say: (text) => {
      if (readOnly) throw new Error('Kibitz agent is read-only — actions are disabled')
      bridge.say(text)
    },
    canAct: !readOnly,
  }
}

/**
 * A minimal rate gate so an agent doesn't flood the room — the kibitzer hand-rolls this,
 * so it belongs in the SDK. `ready(now)` is true once `ms` has elapsed since the last
 * `stamp(now)`; clock-injected (epoch-ms) so it's pure and testable. A "reply" path that
 * should jump the queue simply ignores it.
 */
export function cooldown(ms: number): { ready(now: number): boolean; stamp(now: number): void } {
  let last = -Infinity
  return {
    ready: (now) => now - last >= ms,
    stamp: (now) => {
      last = now
    },
  }
}
