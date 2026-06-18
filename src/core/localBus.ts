import type { AuthorityWire, ClientWire } from './protocol'
import type { AuthorityTransport, ClientTransport } from './transport'
import type { RoomTransport } from './room'

/**
 * An in-memory room transport — the SAME star wire as PeerJS (transport.ts), but with
 * no network. Pass it as `joinRoom(room, { transport: bus })` to run the REAL PRESENCE
 * engine (authority roster, lobby, lock, kick) entirely in-process, so apps can
 * unit-test membership/gating deterministically. (Content — chat/co-browse/sendTo — is
 * peer-to-peer over the media data mesh, not this transport.)
 *
 *   const bus = createLocalBus()
 *   const host  = joinRoom('demo', { transport: bus })
 *   const guest = joinRoom('demo', { transport: bus })
 *   // …drive host/guest's setSelf, assert the roster each sees — no broker, no media.
 *
 * The first claimer becomes the authority; later joiners connect as participants.
 * Connection/open fire on a microtask (so handlers are registered first); messages
 * deliver synchronously. Closing the authority frees the room — the engine's own
 * migration loop then re-claims, exactly as it would on a real network.
 */

interface AuthHandlers {
  onConnect?: (id: string) => void
  onMessage?: (id: string, msg: ClientWire) => void
  onDisconnect?: (id: string) => void
}
interface ClientHandlers {
  onOpen?: () => void
  onMessage?: (msg: AuthorityWire) => void
  onGone?: (reason: string) => void
}
interface RoomState {
  authority: AuthHandlers | null
  clients: Map<string, ClientHandlers>
  nextId: number
}

export function createLocalBus(): RoomTransport {
  const rooms = new Map<string, RoomState>()
  const ensure = (room: string): RoomState => {
    let s = rooms.get(room)
    if (!s) {
      s = { authority: null, clients: new Map(), nextId: 1 }
      rooms.set(room, s)
    }
    return s
  }

  return {
    claim(room) {
      const s = ensure(room)
      if (s.authority) return Promise.resolve('taken' as const)
      const h: AuthHandlers = {}
      s.authority = h
      const transport: AuthorityTransport = {
        onConnect: (cb) => (h.onConnect = cb),
        onMessage: (cb) => (h.onMessage = cb),
        onDisconnect: (cb) => (h.onDisconnect = cb),
        send: (id, msg) => s.clients.get(id)?.onMessage?.(msg),
        broadcast: (msg, exceptId) => s.clients.forEach((c, id) => id !== exceptId && c.onMessage?.(msg)),
        // No real DTLS in-memory — hand back a deterministic stub fp per connection so a
        // gate's verify() still runs (the real cert-binding is covered by identity tests).
        remoteFingerprint: (id) => Promise.resolve(s.clients.has(id) ? `fp:${id}` : null),
        close: () => {
          if (s.authority !== h) return // a newer authority already took over
          s.authority = null
          // Free the room → every connected client is told the authority is gone, so
          // the engine's reclaim loop races for it (in-memory host migration).
          const orphaned = [...s.clients.values()]
          s.clients.clear()
          orphaned.forEach((c) => c.onGone?.('authority gone'))
        },
      }
      return Promise.resolve({ transport })
    },

    connect(room) {
      const s = ensure(room)
      const id = `c${s.nextId++}`
      const h: ClientHandlers = {}
      s.clients.set(id, h)
      // Fire connect/open AFTER the caller has registered its handlers (this same call
      // stack). The authority sees a new connection; we see the channel open.
      queueMicrotask(() => {
        if (!s.clients.has(id)) return // closed before it opened
        s.authority?.onConnect?.(id)
        h.onOpen?.()
      })
      return {
        onOpen: (cb) => (h.onOpen = cb),
        onMessage: (cb) => (h.onMessage = cb),
        onGone: (cb) => (h.onGone = cb),
        send: (msg) => s.authority?.onMessage?.(id, msg),
        close: () => {
          if (s.clients.delete(id)) s.authority?.onDisconnect?.(id)
        },
      } satisfies ClientTransport
    },
  }
}
