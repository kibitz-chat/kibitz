import { describe, it, expect } from 'vitest'
import { createVoiceMesh, type RosterMember } from './mesh'

/**
 * Fake PeerJS network for the data mesh: peers register an 'connection' handler;
 * `connect(from,to)` makes a linked pair of fake DataConnections, delivers the far
 * end to the target's handler, and opens both on a microtask. Media (`call`) is a
 * no-op here — we're exercising the data channel only.
 */
const tick = () => new Promise((r) => setTimeout(r, 0))

class FakeConn {
  peer: string
  open = false
  other: FakeConn | null = null
  private h: Record<string, ((a?: unknown) => void)[]> = {}
  constructor(peer: string) {
    this.peer = peer
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
    this.other?.emit('data', msg)
  }
  close() {
    this.open = false
    this.emit('close')
  }
}

function makeNet() {
  const onConn: Record<string, (c: FakeConn) => void> = {}
  return {
    register: (id: string, cb: (c: FakeConn) => void) => (onConn[id] = cb),
    connect(fromId: string, toId: string): FakeConn {
      const near = new FakeConn(toId)
      const far = new FakeConn(fromId)
      near.other = far
      far.other = near
      queueMicrotask(() => {
        onConn[toId]?.(far) // the target accepts the incoming connection
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
    connect: (toId: string) => net.connect(id, toId),
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
})
