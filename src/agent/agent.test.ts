import { describe, it, expect } from 'vitest'
import {
  cooldown,
  createAgent,
  createAgentFromBridge,
  type AgentController,
  type AgentParticipant,
  type AgentSchema,
  type AppBridge,
  type ChatMessage,
} from './agent'

// A controllable fake of the composable-engine controller: capture what's broadcast/sent,
// and let tests deliver inbound messages + roster changes. `withSchemas` opts the controller
// into the (optional) schema-discovery surface so we can test both shapes.
function fakeController(roster: AgentParticipant[] = [], opts: { withSchemas?: boolean } = {}) {
  const sent: { to?: string; data: unknown }[] = []
  // The real controller's onMessage is ADDITIVE (multi-listener) — mirror that, since
  // createAgent registers several (internal view-tracking + each subscription).
  const msgCbs = new Set<(data: unknown, from: string) => void>()
  const schemaCbs = new Set<(s: AgentSchema) => void>()
  const schemas: AgentSchema[] = []
  let onParts: ((p: AgentParticipant[]) => void) | undefined
  let meta: Record<string, unknown> | undefined
  let left = false
  const controller: AgentController = {
    broadcast: (data) => sent.push({ data }),
    sendTo: (to, data) => sent.push({ to, data }),
    onMessage: (cb) => (msgCbs.add(cb), () => msgCbs.delete(cb)),
    getParticipants: () => roster,
    on: (_e, cb) => ((onParts = cb as (p: AgentParticipant[]) => void), () => (onParts = undefined)),
    setMeta: (m) => (meta = m),
    leave: () => (left = true),
    ...(opts.withSchemas
      ? {
          getSchemas: () => schemas,
          onSchema: (cb: (s: AgentSchema) => void) => (schemaCbs.add(cb), () => schemaCbs.delete(cb)),
        }
      : {}),
  }
  return {
    controller,
    sent,
    deliver: (data: unknown, from: string) => msgCbs.forEach((cb) => cb(data, from)),
    deliverSchema: (s: AgentSchema) => (schemas.push(s), schemaCbs.forEach((cb) => cb(s))),
    roster: (p: AgentParticipant[]) => onParts?.(p),
    getMeta: () => meta,
    didLeave: () => left,
  }
}

const person = (id: string, name: string): AgentParticipant => ({
  id,
  isSelf: false,
  name,
  avatar: '',
  camOn: false,
  speaking: false,
  stream: null,
  meta: {},
  role: 'guest',
})

describe('createAgent — perception', () => {
  it('delivers chat envelopes with the sender name resolved from the roster', () => {
    const f = fakeController([person('p1', 'Alice')])
    const a = createAgent(f.controller)
    const got: unknown[] = []
    a.onChat((m) => got.push(m))
    f.deliver({ __kib_agent: 'chat', text: 'nice lead' }, 'p1')
    expect(got).toEqual([{ from: 'p1', name: 'Alice', text: 'nice lead' }])
  })

  it('routes app `view` snapshots to onView and remembers the latest via getView()', () => {
    const f = fakeController()
    const a = createAgent(f.controller)
    const views: unknown[] = []
    a.onView((v) => views.push(v))
    expect(a.getView()).toBeNull() // nothing seen yet
    f.deliver({ __kib_agent: 'view', view: { turn: 2 } }, 'host')
    f.deliver({ __kib_agent: 'view', view: { turn: 3 } }, 'host')
    expect(views).toEqual([{ turn: 2 }, { turn: 3 }])
    expect(a.getView()).toEqual({ turn: 3 }) // latest — what an agent answers a chat about
  })

  it('passes RAW (non-envelope) data to onData, and never leaks envelopes into it', () => {
    const f = fakeController()
    const a = createAgent(f.controller)
    const raw: { data: unknown; from: string }[] = []
    a.onData((data, from) => raw.push({ data, from }))
    f.deliver({ move: '7♠' }, 'p2') // raw app data
    f.deliver({ __kib_agent: 'chat', text: 'hi' }, 'p2') // an envelope — must NOT reach onData
    expect(raw).toEqual([{ data: { move: '7♠' }, from: 'p2' }])
  })

  it('forwards roster changes', () => {
    const f = fakeController()
    const a = createAgent(f.controller)
    const seen: AgentParticipant[][] = []
    a.onRoster((p) => seen.push(p))
    const next = [person('p1', 'Alice')]
    f.roster(next)
    expect(seen.at(-1)).toEqual(next)
  })
})

describe('createAgent — schema discovery (#4)', () => {
  it('surfaces published schemas via onSchema + getSchemas', () => {
    const f = fakeController([], { withSchemas: true })
    const a = createAgent(f.controller)
    const got: AgentSchema[] = []
    a.onSchema((s) => got.push(s))
    const schema: AgentSchema = { from: 'host', name: 'whist.view', version: '1.0.0', schema: { type: 'object' } }
    f.deliverSchema(schema)
    expect(got).toEqual([schema])
    expect(a.getSchemas()).toEqual([schema]) // the live snapshot reflects it too
  })

  it('degrades to empty / no-op when the controller predates schema discovery', () => {
    const f = fakeController() // no withSchemas → controller has no getSchemas/onSchema
    const a = createAgent(f.controller)
    expect(a.getSchemas()).toEqual([])
    const unsub = a.onSchema(() => {
      throw new Error('should never fire')
    })
    expect(typeof unsub).toBe('function') // a safe no-op unsubscribe
    expect(() => unsub()).not.toThrow()
  })
})

describe('createAgent — action', () => {
  it('say() broadcasts a chat envelope', () => {
    const f = fakeController()
    createAgent(f.controller).say('bold')
    expect(f.sent).toEqual([{ data: { __kib_agent: 'chat', text: 'bold' } }])
  })

  it('act() broadcasts an act envelope; send() can target one peer', () => {
    const f = fakeController()
    const a = createAgent(f.controller)
    a.act({ play: '7♠' })
    a.send({ ping: 1 }, 'p3')
    expect(f.sent).toEqual([
      { data: { __kib_agent: 'act', action: { play: '7♠' } } },
      { to: 'p3', data: { ping: 1 } },
    ])
  })

  it('tags itself role=agent in meta', () => {
    const f = fakeController()
    createAgent(f.controller)
    expect(f.getMeta()).toEqual({ role: 'agent', readOnly: false })
  })
})

describe('createAgent — read-only', () => {
  it('disables actions and tags readOnly; perception still works', () => {
    const f = fakeController()
    const a = createAgent(f.controller, { readOnly: true })
    expect(a.canAct).toBe(false)
    expect(f.getMeta()).toEqual({ role: 'agent', readOnly: true })
    expect(() => a.say('nope')).toThrow(/read-only/)
    expect(() => a.act({})).toThrow(/read-only/)
    expect(() => a.send({})).toThrow(/read-only/)
    expect(f.sent).toEqual([]) // nothing went out
    // but it can still perceive
    const got: unknown[] = []
    a.onChat((m) => got.push(m))
    f.deliver({ __kib_agent: 'chat', text: 'hi' }, 'p1')
    expect(got).toHaveLength(1)
  })
})

describe('createAgentFromBridge — app-projection path (e.g. a game with hidden hands)', () => {
  function fakeBridge() {
    let view: unknown = null
    const viewCbs = new Set<(v: unknown) => void>()
    const chatCbs = new Set<(m: ChatMessage) => void>()
    const said: string[] = []
    const bridge: AppBridge = {
      onView: (cb) => (viewCbs.add(cb), () => viewCbs.delete(cb)),
      getView: () => view,
      onChat: (cb) => (chatCbs.add(cb), () => chatCbs.delete(cb)),
      say: (t) => said.push(t),
    }
    return {
      bridge,
      said,
      pushView: (v: unknown) => ((view = v), viewCbs.forEach((cb) => cb(v))),
      pushChat: (m: ChatMessage) => chatCbs.forEach((cb) => cb(m)),
    }
  }

  it('passes view/getView/chat through and can say', () => {
    const f = fakeBridge()
    const a = createAgentFromBridge(f.bridge)
    const views: unknown[] = []
    const chats: ChatMessage[] = []
    a.onView((v) => views.push(v))
    a.onChat((m) => chats.push(m))
    f.pushView({ turn: 1 })
    expect(views).toEqual([{ turn: 1 }])
    expect(a.getView()).toEqual({ turn: 1 })
    f.pushChat({ from: 'p1', name: 'Alice', text: 'hi' })
    expect(chats).toEqual([{ from: 'p1', name: 'Alice', text: 'hi' }])
    a.say('nice')
    expect(f.said).toEqual(['nice'])
  })

  it('read-only disables say but keeps perception', () => {
    const f = fakeBridge()
    const a = createAgentFromBridge(f.bridge, { readOnly: true })
    expect(a.canAct).toBe(false)
    expect(() => a.say('x')).toThrow(/read-only/)
    expect(f.said).toEqual([])
  })
})

describe('cooldown — agent rate gate', () => {
  it('blocks until the interval elapses since the last stamp', () => {
    const c = cooldown(6000)
    expect(c.ready(0)).toBe(true) // nothing stamped yet
    c.stamp(1000)
    expect(c.ready(5000)).toBe(false) // only 4s elapsed
    expect(c.ready(7000)).toBe(true) // 6s elapsed
  })
})

describe('createAgent — lifecycle', () => {
  it('leave() leaves the room', () => {
    const f = fakeController()
    createAgent(f.controller).leave()
    expect(f.didLeave()).toBe(true)
  })

  it('the real headless controller (MountedWidget) satisfies AgentController (compile-time)', () => {
    // If MountedWidget ever drifts from what the agent needs, this fails to compile.
    const fits = (w: import('../widget').MountedWidget): AgentController => w
    expect(typeof fits).toBe('function')
  })
})
