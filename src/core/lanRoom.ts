import type { CallMember } from './protocol'
import type { RoomLink, RoomStatus } from './room'
import { ensureGalaxyHub, type GalaxyHub } from './galaxyHub'
import { normalizeRoom } from './transport'

/**
 * The offline (LAN) twin of room.ts. Where the online room elects an authority
 * over the PeerJS broker, the LAN room needs none: the relay is an always-on box
 * (Pi / Android app), so peers just self-assemble.
 *
 * Each browser, on the relay's hub, periodically BROADCASTS its presence; every
 * peer builds the roster locally from those beacons and reaps the silent ones.
 * Media (lanMesh) signals directly over the hub. Identity = the hub id — stable
 * for the session, which is all a LAN call needs.
 *
 * Frames (opaque to the relay, which only routes them):
 *   hi      — a newcomer; prompts everyone to re-announce so it appears at once
 *   present — presence beacon (name/cam/avatar)
 *   bye     — leaving
 *   sig     — media handshake, routed to lanMesh
 *
 * Content (chat / co-browse / pay / ink) does NOT go through the hub — it rides the
 * peer-to-peer data channel on the lanMesh connections (see lanMesh.ts).
 */

type LanFrame =
  | { k: 'hi' }
  | { k: 'present'; name: string; cam: boolean; avatar: string; meta?: Record<string, unknown> }
  | { k: 'bye' }
  | { k: 'sig'; payload: unknown }

const BEACON_MS = 2500
const REAP_MS = 8000

export interface MeshSignal {
  send(to: string, payload: unknown): void
  onSignal(cb: (from: string, payload: unknown) => void): () => void
}

export interface LanRoom {
  link: RoomLink
  /** Mesh handshake channel (routes `sig` frames by hub id). */
  signal: MeshSignal
  /** Our identity in the call — the hub id as a string (the media peer id). */
  voiceId(): string
  status(): RoomStatus
  onChange(cb: () => void): void
  close(): void
}

interface Entry {
  member: CallMember
  seen: number
}

export function joinLanRoom(room: string): LanRoom {
  // multi-room: the relay scopes peers/to to this key, so one relay carries many calls. Normalized so the
  // SAME room name maps to the SAME offline room (and "" — an empty name — lands everyone in the shared room).
  const roomKey = normalizeRoom(room)
  let hub: GalaxyHub | null = null
  let status: RoomStatus = 'connecting'
  let closed = false

  const self = { on: false, cam: false, name: 'Guest', avatar: '', meta: undefined as Record<string, unknown> | undefined }
  const others = new Map<string, Entry>() // hubId(string) -> entry (excludes self)
  let rosterCb: ((m: CallMember[]) => void) | null = null
  let changeCb: (() => void) | null = null
  const sigCbs = new Set<(from: string, payload: unknown) => void>()

  const setStatus = (s: RoomStatus) => {
    if (closed && s !== 'closed') return
    status = s
    changeCb?.()
  }

  const myId = (): string => (hub ? String(hub.id) : '')

  const roster = (): CallMember[] => {
    const list = [...others.values()].map((e) => e.member)
    if (self.on && hub) list.unshift({ id: myId(), name: self.name || 'Guest', cam: self.cam, avatar: self.avatar, meta: self.meta })
    return list
  }
  const deliverRoster = () => {
    rosterCb?.(roster())
    changeCb?.()
  }

  const announce = () => {
    if (self.on && hub) {
      void hub.broadcast({ k: 'present', name: self.name || 'Guest', cam: self.cam, avatar: self.avatar, meta: self.meta } satisfies LanFrame)
    }
  }

  const onFrame = (from: number, raw: unknown) => {
    if (closed || !raw || typeof raw !== 'object') return
    const f = raw as LanFrame
    const fid = String(from)
    switch (f.k) {
      case 'hi':
        announce() // a newcomer — re-announce so they see us immediately
        break
      case 'present':
        others.set(fid, { member: { id: fid, name: f.name || 'Guest', cam: f.cam, avatar: f.avatar || '', meta: f.meta }, seen: now() })
        deliverRoster()
        break
      case 'bye':
        if (others.delete(fid)) deliverRoster()
        break
      case 'sig':
        for (const cb of sigCbs) cb(fid, f.payload)
        break
    }
  }

  let beacon: ReturnType<typeof setInterval> | null = null

  const connect = () => {
    setStatus('connecting')
    ensureGalaxyHub()
      .then((h) => {
        if (closed) return
        hub = h
        h.onFrame(onFrame)
        h.onClose(() => {
          if (closed) return
          hub = null
          setStatus('reconnecting')
          setTimeout(connect, 2000)
        })
        h.join(roomKey) // multi-room: scope this connection to our room BEFORE any peers()/broadcast (re-sent on every reconnect)
        setStatus('connected')
        void h.broadcast({ k: 'hi' } satisfies LanFrame) // pull everyone's presence
        announce()
        deliverRoster()
      })
      .catch(() => {
        if (closed) return
        setStatus('reconnecting')
        setTimeout(connect, 3000)
      })
  }
  connect()

  beacon = setInterval(() => {
    if (closed) return
    announce()
    const cutoff = now() - REAP_MS
    let changed = false
    for (const [id, e] of others) if (e.seen < cutoff) (others.delete(id), (changed = true))
    if (changed) deliverRoster()
  }, BEACON_MS)

  return {
    link: {
      setSelf: (on, cam, name, avatar, _voiceId, meta) => {
        self.on = on
        self.cam = cam
        self.name = name || 'Guest'
        self.avatar = avatar
        self.meta = meta
        if (on) announce()
        else if (hub) void hub.broadcast({ k: 'bye' } satisfies LanFrame)
        deliverRoster()
      },
      onRoster: (cb) => {
        rosterCb = cb
        cb(roster())
      },
    },
    signal: {
      send: (to, payload) => hub?.send(Number(to), { k: 'sig', payload } satisfies LanFrame),
      onSignal: (cb) => {
        sigCbs.add(cb)
        return () => sigCbs.delete(cb)
      },
    },
    voiceId: myId,
    status: () => status,
    onChange: (cb) => (changeCb = cb),
    close: () => {
      closed = true
      if (beacon) clearInterval(beacon)
      if (hub && self.on) void hub.broadcast({ k: 'bye' } satisfies LanFrame)
      status = 'closed'
    },
  }
}

// new Date()/Date.now() are fine in the browser; isolated here for clarity.
function now(): number {
  return Date.now()
}
