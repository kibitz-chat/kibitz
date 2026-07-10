import { describe, it, expect, vi } from 'vitest'
import { createVoiceMesh, type RosterMember } from './mesh'

/**
 * Fake PeerJS network for the data mesh: peers register an 'connection' handler;
 * `connect(from,to)` makes a linked pair of fake DataConnections, delivers the far
 * end to the target's handler, and opens both on a microtask. Media (`call`) is a
 * no-op here — we're exercising the data channel only.
 */
const tick = () => new Promise((r) => setTimeout(r, 0))
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

class FakeConn {
  peer: string
  label: string
  open = false
  sent: unknown[] = [] // every msg sent from THIS end (lets a test prove which channel carried what)
  other: FakeConn | null = null
  private h: Record<string, ((a?: unknown) => void)[]> = {}
  constructor(peer: string, label = '') {
    this.peer = peer
    this.label = label
  }
  on(ev: string, cb: (a?: unknown) => void) {
    ;(this.h[ev] ||= []).push(cb)
  }
  emit(ev: string, arg?: unknown) {
    ;(this.h[ev] || []).forEach((f) => f(arg))
  }
  doOpen() {
    this.open = true
    this.emit('open')
  }
  send(msg: unknown) {
    this.sent.push(msg)
    this.other?.emit('data', msg)
  }
  close() {
    this.open = false
    this.emit('close')
  }
}

function makeNet() {
  const onConn: Record<string, (c: FakeConn) => void> = {}
  const conns = new Map<string, FakeConn>() // `${from}->${to}[:label]` → the near (initiator) conn; re-dials overwrite
  const dials: string[] = [] // every connect target, in order (so a test can prove a re-dial did / didn't happen)
  const holdOpen = new Set<string>() // targets whose conns CONNECT but never OPEN — the ICE-up-never-open WS-flap limbo
  return {
    conns,
    dials,
    holdOpen,
    register: (id: string, cb: (c: FakeConn) => void) => (onConn[id] = cb),
    connect(fromId: string, toId: string, label = ''): FakeConn {
      const near = new FakeConn(toId, label)
      const far = new FakeConn(fromId, label) // the far end carries the SAME label so the receiver routes it
      near.other = far
      far.other = near
      conns.set(`${fromId}->${toId}${label ? ':' + label : ''}`, near)
      dials.push(toId)
      queueMicrotask(() => {
        onConn[toId]?.(far) // the target accepts the incoming connection
        if (holdOpen.has(toId)) return // simulate the limbo: connected but the data channel never fires 'open'
        near.doOpen()
        far.doOpen()
      })
      return near
    },
  }
}

function makePeer(id: string, net: ReturnType<typeof makeNet>) {
  const h: Record<string, ((a?: unknown) => void)[]> = {}
  net.register(id, (c) => (h['connection'] || []).forEach((f) => f(c)))
  return {
    connect: (toId: string, opts?: { label?: string }) => net.connect(id, toId, opts?.label),
    call: () => undefined, // media no-op for these tests
    on: (ev: string, cb: (a?: unknown) => void) => void (h[ev] ||= []).push(cb),
    off: (ev: string, cb: (a?: unknown) => void) => void (h[ev] && (h[ev] = h[ev].filter((f) => f !== cb))),
    destroy: () => {},
  } as never // structurally satisfies the bits of Peer the data mesh uses
}

const roster = (...ids: string[]): RosterMember[] => ids.map((id) => ({ id, cam: false }))

describe('data mesh — peer-to-peer content, no authority relay', () => {
  it('delivers a broadcast directly to the other peer (glare-free single dial)', async () => {
    const net = makeNet()
    const a = createVoiceMesh({ peer: makePeer('a', net), selfId: 'a', onRemote: () => {} })
    const b = createVoiceMesh({ peer: makePeer('b', net), selfId: 'b', onRemote: () => {} })
    const aGot: [string, unknown][] = []
    const bGot: [string, unknown][] = []
    a.onData((from, m) => aGot.push([from, m]))
    b.onData((from, m) => bGot.push([from, m]))
    a.setRoster(roster('a', 'b'))
    b.setRoster(roster('a', 'b'))
    await tick()
    a.broadcastData({ k: 'chat', text: 'hi' })
    b.broadcastData({ k: 'chat', text: 'yo' })
    await tick()
    expect(bGot).toEqual([['a', { k: 'chat', text: 'hi' }]])
    expect(aGot).toEqual([['b', { k: 'chat', text: 'yo' }]])
    a.close()
    b.close()
  })

  it('buffers a message sent before the connection opens, then flushes it', async () => {
    const net = makeNet()
    const a = createVoiceMesh({ peer: makePeer('a', net), selfId: 'a', onRemote: () => {} })
    const b = createVoiceMesh({ peer: makePeer('b', net), selfId: 'b', onRemote: () => {} })
    const bGot: unknown[] = []
    b.onData((_from, m) => bGot.push(m))
    a.setRoster(roster('a', 'b'))
    b.setRoster(roster('a', 'b'))
    a.broadcastData({ k: 'chat', text: 'early' }) // before the link is open
    await tick()
    expect(bGot).toEqual([{ k: 'chat', text: 'early' }])
    a.close()
    b.close()
  })

  // The BULK content channel can drop UNEXPECTEDLY mid-session (PeerJS closes the whole DataConnection when a
  // dataChannel.send() throws on a congested / TURN-relayed link; an ICE blip closes it too). The initiator
  // re-dials it after a short backoff so transfers/content flow again (and a single message rides the sig
  // fallback while bulk is down, so it's never lost).
  it('self-heals an unexpectedly-dropped BULK link (the initiator re-dials it)', async () => {
    const net = makeNet()
    const a = createVoiceMesh({ peer: makePeer('a', net), selfId: 'a', onRemote: () => {} })
    const b = createVoiceMesh({ peer: makePeer('b', net), selfId: 'b', onRemote: () => {} })
    const bGot: unknown[] = []
    b.onData((_f, m) => bGot.push(m))
    a.setRoster(roster('a', 'b')) // a < b ⇒ a is the initiator (a dials b's sig, then bulk on the cap handshake)
    b.setRoster(roster('a', 'b'))
    await tick()
    a.broadcastData({ k: 'chat', text: 'one' })
    await tick()
    expect(bGot).toContainEqual({ k: 'chat', text: 'one' }) // delivered over bulk
    const dialsBefore = net.dials.filter((d) => d === 'b').length

    net.conns.get('a->b:bulk')!.close() // unexpected drop of the LIVE bulk link
    await wait(900) // past the 800ms re-dial backoff → the initiator re-dials bulk
    await tick()
    expect(net.dials.filter((d) => d === 'b').length).toBeGreaterThan(dialsBefore) // bulk re-dialled
    a.broadcastData({ k: 'chat', text: 'two' })
    await tick()
    expect(bGot).toContainEqual({ k: 'chat', text: 'two' }) // healed: content flows again
    a.close()
    b.close()
  })

  // A signaling-socket flap (WS close 1006) DURING setup can leave the sig DataConnection ICE-connected but with
  // its data channel never firing 'open' — peerjs reports NO close/error for that limbo, so wireLink's teardown
  // re-dial never runs and the peer is silent forever (confirmed on an iPhone PWA: pc0 ever=ø, pc1 ice=new). The
  // stuck-connect watchdog in the heartbeat is the only thing that reclaims it — past STUCK_MS it re-dials the
  // hung sig channel (dialer-only, so no glare), bounded by MAX_RECOVER so a hostile path can't churn.
  it('re-establishes a sig channel stuck in the ICE-up-never-open limbo (the WS-flap silent call)', async () => {
    vi.useFakeTimers()
    try {
      const net = makeNet()
      net.holdOpen.add('b') // b accepts the connection, but its data channel never fires 'open'
      const a = createVoiceMesh({ peer: makePeer('a', net), selfId: 'a', onRemote: () => {} })
      const b = createVoiceMesh({ peer: makePeer('b', net), selfId: 'b', onRemote: () => {} })
      a.setRoster(roster('a', 'b')) // a < b ⇒ a dials b's sig channel
      b.setRoster(roster('a', 'b'))
      await vi.advanceTimersByTimeAsync(50) // let the initial sig dial happen
      expect(net.conns.get('a->b')!.open).toBe(false) // connected but stuck — never opened
      const before = net.dials.filter((d) => d === 'b').length
      await vi.advanceTimersByTimeAsync(11000) // past STUCK_MS(8000) + a heartbeat tick → the watchdog fires
      expect(net.dials.filter((d) => d === 'b').length).toBeGreaterThan(before) // it re-established the hung sig channel
      await vi.advanceTimersByTimeAsync(40000) // keep it stuck → the watchdog must STOP (bounded, no churn)
      expect(net.dials.filter((d) => d === 'b').length).toBeLessThanOrEqual(before + 3) // MAX_RECOVER
      a.close()
      b.close()
    } finally {
      vi.useRealTimers()
    }
  })

  // The intermittent iOS-PWA case: the sig channel OPENS (peerjs reports open) but its SCTP is dead — no data
  // ever flows (no 'mh' keepalive), so the media offer never lands and the peer is silent. The never-opened check
  // skips it (conn.open is true), so the watchdog must catch it via staleness (SIG_DEAD_MS) and re-establish.
  it('re-establishes a sig channel that OPENED but went DEAD (no data — the stalled-SCTP case)', async () => {
    vi.useFakeTimers()
    try {
      const net = makeNet()
      // Only 'a' has a mesh; 'b' has no handler → a's channel to b OPENS (harness auto-opens) but b never sends
      // anything back, so a receives no 'mh' → its lastRecv goes stale → a sees the channel dead-but-open.
      const a = createVoiceMesh({ peer: makePeer('a', net), selfId: 'a', onRemote: () => {} })
      a.setRoster(roster('a', 'b')) // a < b ⇒ a dials b's sig
      await vi.advanceTimersByTimeAsync(50)
      expect(net.conns.get('a->b')!.open).toBe(true) // it DID open — the never-opened check would NOT catch this
      const before = net.dials.filter((d) => d === 'b').length
      await vi.advanceTimersByTimeAsync(11000) // past SIG_DEAD_MS with no data received → dead-but-open
      expect(net.dials.filter((d) => d === 'b').length).toBeGreaterThan(before) // re-established via the liveness check
      a.close()
    } finally {
      vi.useRealTimers()
    }
  })

  // A CLEAN connection (opens normally) is never touched by the stuck-connect watchdog — no spurious re-dials.
  it('leaves a healthy sig channel alone (no stuck-connect churn)', async () => {
    vi.useFakeTimers()
    try {
      const net = makeNet()
      const a = createVoiceMesh({ peer: makePeer('a', net), selfId: 'a', onRemote: () => {} })
      const b = createVoiceMesh({ peer: makePeer('b', net), selfId: 'b', onRemote: () => {} })
      a.setRoster(roster('a', 'b'))
      b.setRoster(roster('a', 'b'))
      await vi.advanceTimersByTimeAsync(50)
      const before = net.dials.filter((d) => d === 'b').length // sig + bulk
      await vi.advanceTimersByTimeAsync(30000) // many heartbeats — a healthy link must not be re-dialled
      expect(net.dials.filter((d) => d === 'b').length).toBe(before)
      a.close()
      b.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fires onDataLinkOpen on BULK connect AND again after a bulk re-dial (drives fast resume)', async () => {
    const net = makeNet()
    const a = createVoiceMesh({ peer: makePeer('a', net), selfId: 'a', onRemote: () => {} })
    const b = createVoiceMesh({ peer: makePeer('b', net), selfId: 'b', onRemote: () => {} })
    const opens: string[] = []
    a.onDataLinkOpen((id) => opens.push(id)) // transfers ride bulk ⇒ resume keys off BULK open
    a.setRoster(roster('a', 'b')) // a < b ⇒ a initiates
    b.setRoster(roster('a', 'b'))
    await tick()
    expect(opens).toEqual(['b']) // bulk link opened once
    net.conns.get('a->b:bulk')!.close() // unexpected drop of the bulk link
    await wait(900) // re-dial backoff elapses → the initiator re-dials bulk
    await tick()
    expect(opens).toEqual(['b', 'b']) // re-healed bulk fires again → useCall sends a fast xresume
    a.close()
    b.close()
  })

  it('does NOT re-dial a peer that cleanly left the roster', async () => {
    const net = makeNet()
    const a = createVoiceMesh({ peer: makePeer('a', net), selfId: 'a', onRemote: () => {} })
    const b = createVoiceMesh({ peer: makePeer('b', net), selfId: 'b', onRemote: () => {} })
    a.setRoster(roster('a', 'b'))
    b.setRoster(roster('a', 'b'))
    await tick()
    expect(net.dials.filter((d) => d === 'b').length).toBe(2) // dialled once for sig + once for bulk
    a.setRoster(roster('a')) // b leaves cleanly → both its links close AND leave the dialled sets
    await wait(900) // well past the re-dial backoff
    await tick()
    expect(net.dials.filter((d) => d === 'b').length).toBe(2) // no self-heal re-dial for a clean leave
    a.close()
    b.close()
  })

  it('sendData reaches only the addressed peer', async () => {
    const net = makeNet()
    const a = createVoiceMesh({ peer: makePeer('a', net), selfId: 'a', onRemote: () => {} })
    const b = createVoiceMesh({ peer: makePeer('b', net), selfId: 'b', onRemote: () => {} })
    const c = createVoiceMesh({ peer: makePeer('c', net), selfId: 'c', onRemote: () => {} })
    const bGot: unknown[] = []
    const cGot: unknown[] = []
    b.onData((_f, m) => bGot.push(m))
    c.onData((_f, m) => cGot.push(m))
    a.setRoster(roster('a', 'b', 'c'))
    b.setRoster(roster('a', 'b', 'c'))
    c.setRoster(roster('a', 'b', 'c'))
    await tick()
    a.sendData('b', { k: 'app', data: 1 })
    await tick()
    expect(bGot).toEqual([{ k: 'app', data: 1 }])
    expect(cGot).toEqual([]) // not the addressee
    a.close()
    b.close()
    c.close()
  })

  it('routes content over BULK and signaling/cap over SIG (head-of-line isolation)', async () => {
    const net = makeNet()
    const a = createVoiceMesh({ peer: makePeer('a', net), selfId: 'a', onRemote: () => {} })
    const b = createVoiceMesh({ peer: makePeer('b', net), selfId: 'b', onRemote: () => {} })
    a.setRoster(roster('a', 'b'))
    b.setRoster(roster('a', 'b'))
    await tick() // sig + cap handshake + bulk all up
    a.broadcastData({ k: 'chat', text: 'hi' })
    a.broadcastData({ k: 'xchunk', i: 0 })
    await tick()
    const sig = net.conns.get('a->b')!.sent
    const bulk = net.conns.get('a->b:bulk')!.sent
    // Content rode bulk, never the sig link.
    expect(bulk).toContainEqual({ k: 'chat', text: 'hi' })
    expect(bulk).toContainEqual({ k: 'xchunk', i: 0 })
    expect(sig).not.toContainEqual({ k: 'chat', text: 'hi' })
    // The capability handshake rode sig, never bulk — so a big bulk transfer can't head-of-line-block it.
    expect(sig).toContainEqual({ t: 'cap', bulk: 1 })
    expect(bulk.some((m) => (m as { t?: string }).t === 'cap')).toBe(false)
    a.close()
    b.close()
  })

  it('falls back to SIG for an OLD peer that never advertises bulk (no second dial)', async () => {
    const net = makeNet()
    const a = createVoiceMesh({ peer: makePeer('a', net), selfId: 'a', onRemote: () => {} })
    // "Old" peer b: accepts the incoming sig connection + records content, but never replies {t:'cap'}, so a
    // must never open a 'bulk' connection to it (old code can't tell the two connections apart).
    const bGot: unknown[] = []
    net.register('b', (c) =>
      c.on('data', (d) => {
        if (d && (d as { k?: string }).k) bGot.push(d)
      }),
    )
    a.setRoster(roster('a', 'b'))
    await tick()
    a.broadcastData({ k: 'chat', text: 'hi' }) // a is bulk-capable, b isn't → fall back to sig
    await tick()
    expect(bGot).toContainEqual({ k: 'chat', text: 'hi' }) // delivered over the sig link
    expect(net.dials.filter((d) => d === 'b').length).toBe(1) // sig only — NO bulk dial to the old peer
    a.close()
  })
})
