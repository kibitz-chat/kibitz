import { type DataConnection, Peer, type PeerJSOption } from 'peerjs'
import { setDiag, setDiagField, logSignalEvent } from './diag'
import { pcFingerprints } from './safetyCode'
import type { AuthorityWire, ClientWire } from './protocol'

/**
 * Room data transport: a star over PeerJS data connections. The room lives at a
 * DETERMINISTIC peer id derived from its name; whoever claims it is the authority.
 *
 * Ported from a production card-game app's battle-tested transport. The non-obvious rules, each
 * paid for with a real bug:
 * - keepAlive must be STOPPED before peer.destroy(): PeerJS emits 'disconnected'
 *   BEFORE setting `destroyed`, so a keep-alive reconnect fires mid-teardown and
 *   re-registers the id on the broker — leaving the room id held by a zombie and
 *   unclaimable forever.
 * - A locally-initiated DataConnection.close() emits 'close' on YOUR OWN handler.
 *   Reconnect logic must stale-guard its handlers and cancel pending retries on a
 *   successful open, or one transient blip becomes a self-sustaining ~3s flap loop
 *   (each retry's cleanup of the old connection breeds the retry that kills the
 *   healthy new one).
 * - A broker can accept a socket and then never assign the id (no open, no error)
 *   — every claim/connect needs its own timeout.
 */

const PREFIX = 'kbz-v1-'

/** Normalize a user-chosen room name into a broker-safe id segment. A null/undefined/empty name → '' (the
 *  default shared room, per the multi-room design), so a no-room join defaults cleanly instead of throwing. */
export function normalizeRoom(room: string | null | undefined): string {
  return (room ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/** The deterministic broker peer id a room name maps to — `kbz-v1-` + the normalized name.
 *  This is a CROSS-VERSION ABI: changing the PREFIX or normalization splits every room across
 *  builds (a v1 peer and a v2 peer never meet). Frozen by conformance.test.ts. */
export const peerIdFor = (room: string) => PREFIX + normalizeRoom(room)

/** Extra PeerJS config (e.g. own PeerServer host / TURN iceServers) — one place. */
export interface PeerConfig {
  host?: string
  port?: number
  path?: string
  secure?: boolean
  config?: RTCConfiguration // iceServers etc.
}

// PeerJS broker keepalive cadence. 25s (chosen to cut billed WS messages on the Cloudflare Durable Object)
// let the broker WebSocket idle out / get dropped on flaky mobile paths → `WS close 1006` → "join alone"
// (presence rides the broker). Back to PeerJS's 5s default: a flaky link is pinged often enough to hold the
// socket, which is worth the extra worker cost. The P2P presence ping (2.5s) is a separate liveness signal.
export const BROKER_PING_MS = 5000

function makePeer(id: string | undefined, cfg?: PeerConfig): Peer {
  setDiagField('broker', cfg?.host ?? 'PUBLIC-PEERJS') // ?debug: which signaling broker this peer is on
  // PeerJSOption's published type omits `pingInterval` (the runtime + constructor accept it), so widen.
  const opts: PeerJSOption & { pingInterval?: number } = cfg
    ? { host: cfg.host, port: cfg.port, path: cfg.path, secure: cfg.secure, config: cfg.config, pingInterval: BROKER_PING_MS }
    : { pingInterval: BROKER_PING_MS }
  const peer = id ? new Peer(id, opts) : new Peer(opts)
  // Surface the PeerJS error TYPE into the ?debug signaling log — it's what distinguishes a broker WS killed by
  // the network ('network' / 'socket-error' / 'server-error') from authority-id contention ('unavailable-id'),
  // the two causes of the `WS close 1006` "join alone".
  try {
    peer.on('error', (e) => logSignalEvent(`peer err: ${(e as { type?: string }).type ?? '?'}`))
  } catch {
    /* ignore */
  }
  return peer
}

/**
 * Keep a peer reachable across mobile tab backgrounding (reconnect on
 * 'disconnected' / on returning to the foreground). Returns a stopper that MUST be
 * called before destroying the peer — see module docs.
 */
export function keepAlive(peer: Peer): () => void {
  let stopped = false
  const reconnect = () => {
    if (stopped) return
    if (!peer.destroyed && peer.disconnected) {
      try {
        peer.reconnect()
      } catch {
        /* already reconnecting / destroyed — ignore */
      }
    }
  }
  peer.on('disconnected', reconnect)
  let onVisible: (() => void) | null = null
  if (typeof document !== 'undefined') {
    onVisible = () => {
      if (document.visibilityState === 'visible') reconnect()
    }
    document.addEventListener('visibilitychange', onVisible)
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    try {
      peer.off('disconnected', reconnect)
    } catch {
      /* ignore */
    }
    if (onVisible) {
      document.removeEventListener('visibilitychange', onVisible)
      onVisible = null
    }
  }
  peer.on('close', stop)
  return stop
}

// --- Authority side ----------------------------------------------------------

/** The remote DTLS cert fingerprint of a PeerJS connection's underlying RTCPeerConnection
 *  — the cert the OTHER side actually presented in the live handshake. Null when the peer
 *  connection isn't negotiated yet or the browser doesn't expose the remote cert. Pulled
 *  out as a pure function so the authority gate's binding check is unit-testable without
 *  PeerJS. */
export async function connRemoteFingerprint(
  conn: { peerConnection?: RTCPeerConnection } | undefined,
): Promise<string | null> {
  const pc = conn?.peerConnection
  if (!pc) return null
  return (await pcFingerprints(pc))?.remote ?? null
}

export interface AuthorityTransport {
  onConnect(h: (id: string) => void): void
  onMessage(h: (id: string, msg: ClientWire) => void): void
  onDisconnect(h: (id: string) => void): void
  /** Fired when we LOSE the room — our authority id was re-claimed by another peer while our WS was down (the
   *  classic cellular-drop case). The room loop re-joins: it finds the new authority and connects as a
   *  participant, instead of leaving us a stale, alone authority (split-brain). */
  onGone(h: (reason: string) => void): void
  send(id: string, msg: AuthorityWire): void
  /** Send to every open connection, optionally skipping one (the message's origin,
   *  so a relayed app/chat message never echoes back to its sender). */
  broadcast(msg: AuthorityWire, exceptId?: string): void
  /** The REMOTE DTLS cert fingerprint of a participant's PRESENCE connection (the cert
   *  THEY presented to us, from the live handshake — not the spoofable SDP). The
   *  identity gate hashes this to check a cert-bound token. Null if the connection
   *  isn't open yet or the browser doesn't expose the remote cert. */
  remoteFingerprint(id: string): Promise<string | null>
  close(): void
}

const CLAIM_TIMEOUT_MS = 8000

/**
 * Try to claim the room's deterministic id. Resolves with the live transport when
 * we are the authority, 'taken' when someone else already is, 'error' otherwise.
 */
export async function claimRoom(
  room: string,
  cfg?: PeerConfig,
): Promise<{ transport: AuthorityTransport } | 'taken' | 'error'> {
  const peer = makePeer(peerIdFor(room), cfg)
  const outcome = await new Promise<'ok' | 'taken' | 'error'>((resolve) => {
    const timer = setTimeout(() => resolve('error'), CLAIM_TIMEOUT_MS)
    peer.once('open', () => {
      clearTimeout(timer)
      resolve('ok')
    })
    peer.once('error', (e) => {
      clearTimeout(timer)
      resolve(e.type === 'unavailable-id' ? 'taken' : 'error')
    })
  })
  if (outcome !== 'ok') {
    try {
      peer.destroy()
    } catch {
      /* ignore */
    }
    return outcome
  }

  const stopKA = keepAlive(peer)
  const conns = new Map<string, DataConnection>()
  let onConnectH: ((id: string) => void) | null = null
  let onMessageH: ((id: string, msg: ClientWire) => void) | null = null
  let onDisconnectH: ((id: string) => void) | null = null
  let onGoneH: ((reason: string) => void) | null = null

  peer.on('connection', (conn) => {
    conns.set(conn.peer, conn)
    conn.on('open', () => onConnectH?.(conn.peer))
    conn.on('data', (data) => onMessageH?.(conn.peer, data as ClientWire))
    const drop = () => {
      if (conns.delete(conn.peer)) onDisconnectH?.(conn.peer)
    }
    conn.on('close', drop)
    conn.on('error', drop)
  })

  // After we WON the room, a later 'unavailable-id' means our authority id was re-claimed while our WS was down (a
  // peer grabbed the freed room during our cellular drop). We've lost the room → signal onGone so the room loop
  // re-joins (finds the new authority and connects as a participant) instead of sitting as a stale, alone authority.
  peer.on('error', (e) => {
    if ((e as { type?: string }).type === 'unavailable-id') onGoneH?.('authority id re-claimed')
  })

  return {
    transport: {
      onConnect: (h) => (onConnectH = h),
      onMessage: (h) => (onMessageH = h),
      onDisconnect: (h) => (onDisconnectH = h),
      onGone: (h) => (onGoneH = h),
      send: (id, msg) => {
        const c = conns.get(id)
        if (c?.open) c.send(msg)
      },
      broadcast: (msg, exceptId) =>
        conns.forEach((c, id) => id !== exceptId && c.open && c.send(msg)),
      remoteFingerprint: (id) =>
        connRemoteFingerprint(conns.get(id) as unknown as { peerConnection?: RTCPeerConnection } | undefined),
      close: () => {
        stopKA() // BEFORE destroy — see module docs (zombie id re-registration)
        conns.forEach((c) => c.close())
        try {
          peer.destroy()
        } catch {
          /* ignore */
        }
      },
    },
  }
}

// --- Participant side ----------------------------------------------------------

export interface ClientTransport {
  onOpen(h: () => void): void
  onMessage(h: (msg: AuthorityWire) => void): void
  /** Fired when we've given up reaching the authority (the room loop re-claims). */
  onGone(h: (reason: string) => void): void
  send(msg: ClientWire): void
  close(): void
}

const RETRY_BASE_MS = 2000
const OPEN_TIMEOUT_MS = 15000 // per attempt — cellular/CGNAT TURN-relay allocation + ICE can take >8s (was 8s → "authority unreachable" on 4G)
const PING_MS = 2500
const FREEZE_GAP_MS = 6000 // our own tab was frozen — don't blame the authority
const AUTHORITY_SILENCE_MS = 12000
const MAX_ATTEMPTS = 4 // then give up to the room loop, which re-claims/rejoins (was 2 — too few for a slow cellular relay)

/** Connect to a claimed room as a participant. */
export function connectToRoom(room: string, cfg?: PeerConfig): ClientTransport {
  const peer = makePeer(undefined, cfg)
  // Surface PeerJS peer errors (broker/socket/webrtc) to the ?debug overlay — on a
  // phone there's no console, and this is how we tell a broker failure from an ICE one.
  peer.on('error', (e: { type?: string; message?: string }) => setDiag(`peer:${e?.type ?? 'err'}`))
  const stopKA = keepAlive(peer)
  let conn: DataConnection | null = null
  let onOpenH: (() => void) | null = null
  let onMessageH: ((msg: AuthorityWire) => void) | null = null
  let onGoneH: ((reason: string) => void) | null = null

  let closedByUs = false
  let gone = false
  let attempts = 0
  let lastSeen = 0
  let lastTick = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let openTimer: ReturnType<typeof setTimeout> | null = null

  const clearRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }
  const clearOpen = () => {
    if (openTimer) {
      clearTimeout(openTimer)
      openTimer = null
    }
  }
  const giveUp = (reason: string) => {
    if (closedByUs || gone) return
    gone = true
    setDiag(`gaveup:${reason}`)
    clearRetry()
    clearOpen()
    clearInterval(heartbeat)
    onGoneH?.(reason)
  }

  // Beacon the authority and watch for its silence (a dead authority sends nothing,
  // but the channel can look open). The freeze-gap guard avoids blaming it after
  // OUR tab was suspended (phone locked / backgrounded).
  const heartbeat = setInterval(() => {
    if (closedByUs || gone) return
    const now = Date.now()
    const tickGap = now - lastTick
    lastTick = now
    if (!conn?.open) return
    try {
      conn.send({ t: 'ping' } satisfies ClientWire)
    } catch {
      /* ignore */
    }
    if (tickGap > FREEZE_GAP_MS) {
      lastSeen = now
      return
    }
    if (lastSeen && now - lastSeen > AUTHORITY_SILENCE_MS) giveUp('authority silent')
  }, PING_MS)

  // On a genuine page unload (tab close / navigation away), tell the authority we're
  // gone NOW so it drops us this instant instead of waiting out REAP_MS. `pagehide`
  // is the reliable signal on mobile Safari / installed PWAs (where `beforeunload`
  // often never fires); `persisted === true` means we're only going into the bfcache
  // and may resume, so we DON'T leave then — the heartbeat keeps us alive, and a real
  // death is still caught by the reap. Best-effort: the data-channel send may not
  // flush before teardown, which is exactly why the reap remains the backstop.
  const onPageHide = (e: PageTransitionEvent) => {
    if (closedByUs || gone || e.persisted) return
    try {
      conn?.send({ t: 'leave' } satisfies ClientWire)
    } catch {
      /* ignore */
    }
  }
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide)

  const scheduleReconnect = () => {
    clearOpen()
    if (closedByUs || gone || retryTimer) return
    if (attempts >= MAX_ATTEMPTS) {
      giveUp('authority unreachable')
      return
    }
    retryTimer = setTimeout(
      () => {
        retryTimer = null
        attempts += 1
        openConn()
      },
      RETRY_BASE_MS + attempts * 1500,
    )
  }

  const openConn = () => {
    if (closedByUs || gone) return
    clearOpen()
    // Detach the previous connection's IDENTITY before closing it (locally-closed
    // conns emit 'close' — without the stale-guards this becomes a flap loop).
    const prev = conn
    conn = null
    if (prev) {
      try {
        prev.close()
      } catch {
        /* ignore */
      }
    }
    const c = peer.connect(peerIdFor(room), { reliable: true })
    conn = c
    setDiag(`dialing#${attempts}`)
    // Report the data channel's ICE progress — distinguishes "can't reach the
    // broker" from "broker fine, but the P2P link won't form" (the iOS same-LAN
    // case). peerConnection isn't ready until PeerJS negotiates, so attach late.
    setTimeout(() => {
      const pc = (c as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
      if (conn !== c || !pc) return
      // Also surface the LOCAL candidate types we gather: 'relay' present ⇒ we DID get a TURN relay (so a stuck
      // 'checking' is a pairing problem with the authority); 'relay' ABSENT ⇒ no TURN reached us on this network
      // (STUN-only) ⇒ can't traverse cellular CGNAT at all. The single fact that tells those two apart on 4G.
      const cand = new Set<string>()
      const report = () => {
        if (conn === c) setDiag(`ice:${pc.iceConnectionState}${cand.size ? ` [${[...cand].sort().join('/')}]` : ''}`)
      }
      // getStats is the RELIABLE source of LOCAL candidate types: the 'icecandidate' event fires before PeerJS
      // exposes peerConnection, so a late listener misses host/srflx. Pull stats as ICE progresses + a couple of
      // early ticks (relay candidates land a beat after host/srflx). A stale pull just no-ops via the conn===c guard.
      const pull = () => {
        pc.getStats()
          .then((stats) => {
            stats.forEach((r) => {
              const rr = r as unknown as { type?: string; candidateType?: string }
              if (rr.type === 'local-candidate' && rr.candidateType) cand.add(rr.candidateType)
            })
            report()
          })
          .catch(() => report())
      }
      report()
      pc.addEventListener('iceconnectionstatechange', pull)
      pull()
      setTimeout(pull, 1500)
      setTimeout(pull, 4000)
    }, 600)
    // Don't kill an attempt that's still NEGOTIATING. On cellular the TURN relay can still be 'checking' when the
    // budget elapses; closing it (scheduleReconnect → openConn) resets ICE candidate gathering and never converges
    // (the 4G "authority unreachable"). If ICE is making progress, grant ONE more window before re-dialling.
    let extended = false
    const onOpenTimeout = () => {
      openTimer = null
      if (conn !== c) return
      const pc = (c as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
      if (!extended && pc && pc.iceConnectionState === 'checking') {
        extended = true
        openTimer = setTimeout(onOpenTimeout, OPEN_TIMEOUT_MS) // still negotiating — give the relay more time, don't reset it
        return
      }
      scheduleReconnect()
    }
    openTimer = setTimeout(onOpenTimeout, OPEN_TIMEOUT_MS)
    c.on('open', () => {
      if (conn !== c) return
      clearOpen()
      clearRetry() // a stray pending retry would re-dial and kill THIS healthy link
      attempts = 0
      lastSeen = Date.now()
      lastTick = Date.now()
      setDiag('data-open')
      onOpenH?.()
    })
    c.on('data', (data) => {
      if (conn !== c) return
      lastSeen = Date.now()
      const msg = data as AuthorityWire
      if (msg?.t === 'ping') return
      onMessageH?.(msg)
    })
    const dead = () => {
      if (conn === c) scheduleReconnect()
    }
    c.on('close', dead)
    c.on('error', dead)
  }

  peer.on('open', () => openConn())
  peer.on('error', (e) => {
    if (closedByUs || gone) return
    if (e.type === 'peer-unavailable') giveUp('authority gone')
    else scheduleReconnect()
  })

  return {
    onOpen: (h) => (onOpenH = h),
    onMessage: (h) => (onMessageH = h),
    onGone: (h) => (onGoneH = h),
    send: (msg) => {
      if (conn?.open) conn.send(msg)
    },
    close: () => {
      closedByUs = true
      clearRetry()
      clearOpen()
      clearInterval(heartbeat)
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide)
      try {
        conn?.send({ t: 'leave' } satisfies ClientWire)
      } catch {
        /* ignore */
      }
      stopKA() // before destroy — see module docs
      try {
        conn?.close()
      } catch {
        /* ignore */
      }
      try {
        peer.destroy()
      } catch {
        /* ignore */
      }
    },
  }
}
