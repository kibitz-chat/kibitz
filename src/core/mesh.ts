import type { CallOption, DataConnection, MediaConnection, Peer } from 'peerjs'
import { safetyInfo, type SafetyInfo } from './safetyCode'
import { connInfo, statsToArray, type ConnInfo } from './connStats'

/**
 * Peer-to-peer voice/video mesh over PeerJS media calls. Each participant holds a
 * direct connection to every other (no media server). Extracted from a production card-game app
 * after a long day of real-device debugging — every rule below is paid for:
 *
 * - GLARE-FREE: exactly one side initiates each pair — the smaller peer id calls,
 *   the larger answers. Never both, never neither.
 * - NO RE-DIAL ON CAMERA TOGGLES: re-dialling whole connections per toggle crashes
 *   iOS WebKit *natively* (no JS error — the process dies). Every call therefore
 *   negotiates a two-way video lane up-front (each side sends a placeholder track
 *   until its camera is on, see media.ts) and a camera toggle is a silent
 *   RTCRtpSender.replaceTrack swap on the LIVE connections.
 * - OFFER BOTH SECTIONS ALWAYS: a voice-only caller's offer would contain no video
 *   m-line, and a WebRTC ANSWER can never add a section the offer omitted — the
 *   answerer's camera would be silently dropped, forever (nothing ever re-dials).
 *   PeerJS forwards `options.constraints` to createOffer (verified in 1.5.x).
 * - Tiles must gate video-vs-avatar on the roster's `cam` flag, NOT on track
 *   presence: the video lane always exists; only the frames change.
 */

export interface RosterMember {
  id: string
  cam: boolean
}

/** This side initiates a pair iff its id sorts first (a stable, glare-free rule). */
export function shouldInitiate(selfId: string, peerId: string): boolean {
  return selfId < peerId
}

/** A media lane the capability layer can gate per-recipient. */
export type GateKind = 'audio' | 'video'

/**
 * Pure: the track a peer should receive on a lane, given whether it's ALLOWED to (its
 * capability grant), the real outgoing track, and the substitute placeholder. Allowed →
 * the real track. Withheld → a FLOWING placeholder (black video / silent audio) so the
 * lane stays alive (an iOS connection treats a sample-less audio lane as dead) and the
 * swap is reversible (the placeholder keeps the sender findable to restore later). If no
 * placeholder could be minted, withholding FAILS CLOSED → `null` (the caller stops sending
 * on that lane), so a capability gate never leaks the real track when the placeholder is
 * missing. Placeholders ~always succeed, so the null path is a rare safety net.
 */
export function gatedTrack(
  allowed: boolean,
  real: MediaStreamTrack | null,
  placeholder: MediaStreamTrack | null,
): MediaStreamTrack | null {
  if (allowed) return real
  return placeholder // withheld: placeholder, or null (fail closed) when none could be minted
}

export interface RosterPlan {
  /** Initiator pairs to dial: members we haven't connected to yet. */
  initiate: string[]
  /** Members no longer present — tear their connection down. */
  drop: string[]
}

/**
 * Decide which initiator-side connections to open or drop for a new roster, given
 * what we already dialled. Camera changes deliberately do NOT trigger anything here
 * (they're handled in-place via replaceTrack). Pure, so it's unit-tested without
 * real media.
 */
export function planRoster(
  selfId: string,
  next: readonly RosterMember[],
  dialled: ReadonlySet<string>,
): RosterPlan {
  const present = new Set<string>()
  const initiate: string[] = []
  for (const m of next) {
    if (m.id === selfId) continue
    present.add(m.id)
    if (!shouldInitiate(selfId, m.id)) continue // the other side dials this pair
    if (!dialled.has(m.id)) initiate.push(m.id)
  }
  const drop: string[] = []
  for (const id of dialled) if (!present.has(id)) drop.push(id)
  return { initiate, drop }
}

export interface VoiceMesh {
  /** Set the local stream used for dials/answers (called once, at join). */
  setLocalStream(stream: MediaStream | null): void
  /**
   * Swap the outgoing video on every LIVE connection in place (camera ↔ placeholder)
   * — no renegotiation, no re-dial, so iOS WebKit never sees connection churn.
   */
  replaceVideoTrack(track: MediaStreamTrack): void
  /**
   * Swap the outgoing AUDIO on every LIVE connection in place (silent placeholder
   * → real mic). Same no-renegotiation guarantee as the video swap, so the mic can
   * be granted lazily on first unmute without iOS-crashing connection churn.
   */
  replaceAudioTrack(track: MediaStreamTrack): void
  /** Reconcile connections to match the roster (members include self; we skip it). */
  setRoster(members: readonly RosterMember[]): void
  /**
   * Send an opaque content message to EVERY connected peer over the peer-to-peer data
   * channel (chat / co-browse / pay / ink). No authority relays it — each peer holds a
   * direct DTLS-encrypted DataConnection. You never receive your own back.
   */
  broadcastData(msg: unknown): void
  /** Send an opaque content message to ONE peer by id over the data channel. */
  sendData(toId: string, msg: unknown): void
  /** Subscribe to content messages from other peers (with the sender's id). SINGLE
   *  slot — last caller wins (useCall is the sole consumer; it fans out internally). */
  onData(cb: (fromId: string, msg: unknown) => void): void
  /**
   * The safety code (SAS) for one live peer — derived from the ACTUAL pair of DTLS
   * certificates, so two honest peers see the same emoji and a MITM is exposed.
   * Null when that peer isn't connected or the browser won't surface the negotiated
   * remote cert (then there's no honest code to show — never faked). See safetyCode.ts.
   */
  safetyCodeFor(peerId: string): Promise<SafetyInfo | null>
  /** Connection diagnostic for this peer (direct/relay + RTT + packet loss) from
   *  getStats, or null if it isn't connected yet / stats are unavailable. */
  connectionInfoFor(peerId: string): Promise<ConnInfo | null>
  /**
   * Per-peer media perception gate (capabilities `see-screen` / `hear-audio`). The
   * predicate decides, per peer + lane, whether that peer may RECEIVE the real track;
   * when it may not, the mesh substitutes a flowing placeholder on JUST that peer's
   * connection — a targeted replaceTrack (the same iOS-safe swap as a camera toggle,
   * never a re-dial). Supply the call-lifetime placeholders alongside. Re-applied on
   * every track swap and new dial; pass a null gate to disable. Optional: the LAN /
   * preview backends don't implement it (data-channel gating still applies there).
   */
  setMediaGate?(
    gate: ((peerId: string, kind: GateKind) => boolean) | null,
    placeholders?: { video: MediaStreamTrack | null; audio: MediaStreamTrack | null },
  ): void
  /** Re-apply the current media gate to every live connection (call when a grant, or
   *  whether we're screen-sharing, changes). No-op until setMediaGate is configured. */
  applyMediaGate?(): void
  close(): void
}

interface Link {
  conn: MediaConnection
  initiatedByUs: boolean
}

/** A direct data connection to one peer, with a small until-open send buffer (a
 *  DataConnection isn't writable the instant it's created). */
interface DataLink {
  conn: DataConnection
  buf: unknown[]
}

export function createVoiceMesh(opts: {
  peer: Peer
  selfId: string
  onRemote: (id: string, stream: MediaStream | null) => void
}): VoiceMesh {
  const { peer, selfId, onRemote } = opts
  const links = new Map<string, Link>()
  const dialled = new Set<string>() // initiator pairs we've opened
  const pendingIn: MediaConnection[] = [] // incoming calls that arrived before our stream
  let local: MediaStream | null = null
  let closed = false

  // --- Per-peer media perception gate (capability layer, docs/agent-platform.md §media).
  // The real outgoing track per lane (what an ALLOWED peer receives), the substitute
  // placeholders (what a WITHHELD peer receives — a flowing black/silent track), and the
  // gate predicate. Each is applied per-connection via a targeted replaceTrack, so a peer
  // lacking `see-screen`/`hear-audio` never gets those frames/samples — sender-side, no
  // re-dial. Inert (every peer allowed) until setMediaGate configures a real predicate.
  let mediaGate: ((peerId: string, kind: GateKind) => boolean) | null = null
  const gatePh: { audio: MediaStreamTrack | null; video: MediaStreamTrack | null } = { audio: null, video: null }
  const realTrack: { audio: MediaStreamTrack | null; video: MediaStreamTrack | null } = { audio: null, video: null }
  let failClosedWarned = false

  // Apply the gate for ONE lane to ONE connection: swap that lane's sender to the track the
  // peer is entitled to. ALLOWED → the real track. WITHHELD → a flowing placeholder (which keeps
  // the sender findable so a later grant can restore the real track). If a placeholder could NOT
  // be minted, withholding FAILS CLOSED — `gatedTrack` returns null and we replaceTrack(null), so
  // a withheld peer gets nothing rather than leaking the real media (a capability gate must never
  // fail open). Placeholders ~always mint; the null path is a rare safety net (we warn once).
  const applyKind = (id: string, conn: MediaConnection, kind: GateKind) => {
    const pc = conn.peerConnection
    if (!pc) return
    const allowed = !mediaGate || mediaGate(id, kind)
    const want = gatedTrack(allowed, realTrack[kind], gatePh[kind])
    if (allowed && !want) return // nothing negotiated on this lane yet — leave it
    if (!allowed && !want && !failClosedWarned) {
      failClosedWarned = true
      // eslint-disable-next-line no-console
      console.warn(`[kibitz] media gate: no ${kind} placeholder — failing CLOSED (withheld peers get no ${kind})`)
    }
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind === kind && sender.track !== want) {
        void sender.replaceTrack(want).catch(() => {
          /* sender gone mid-swap — the connection is closing anyway */
        })
      }
    }
  }
  const applyConn = (id: string, conn: MediaConnection) => {
    applyKind(id, conn, 'audio')
    applyKind(id, conn, 'video')
  }

  // --- Data mesh: a direct DataConnection to every peer, parallel to media, so
  // content (chat/co-browse/pay/ink) is peer-to-peer with no authority relay. Same
  // glare-free rule (smaller id dials) via planRoster, but independent of media —
  // camera toggles never touch it.
  const dataLinks = new Map<string, DataLink>()
  const dataDialled = new Set<string>()
  let onDataCb: ((fromId: string, msg: unknown) => void) | null = null

  const wireData = (conn: DataConnection) => {
    const link: DataLink = { conn, buf: [] }
    dataLinks.set(conn.peer, link)
    conn.on('open', () => {
      for (const m of link.buf.splice(0)) {
        try {
          conn.send(m)
        } catch {
          /* connection died between open and flush */
        }
      }
    })
    conn.on('data', (d) => {
      // Deliver only from the CURRENT link for this peer. A re-dial replaces the link
      // (dialData closes the old conn first); a stale/duplicate DataConnection could still
      // fire a buffered 'data' after its replacement — drop it so old content can't resurface.
      if (!closed && dataLinks.get(conn.peer)?.conn === conn) onDataCb?.(conn.peer, d)
    })
    const teardown = () => {
      if (dataLinks.get(conn.peer)?.conn === conn) dataLinks.delete(conn.peer)
    }
    conn.on('close', teardown)
    conn.on('error', teardown)
  }

  const dialData = (id: string) => {
    if (closed) return // data needs no local stream — unlike media
    const prev = dataLinks.get(id)
    if (prev) {
      dataLinks.delete(id)
      try {
        prev.conn.close()
      } catch {
        /* already closed */
      }
    }
    const conn = peer.connect(id, { reliable: true })
    if (conn) wireData(conn)
  }

  // Someone opened a data connection to us (we're the larger id for this pair).
  const onIncomingData = (conn: DataConnection) => {
    if (!closed) wireData(conn)
  }
  peer.on('connection', onIncomingData)

  const sendOver = (link: DataLink | undefined, msg: unknown) => {
    if (!link) return
    if (link.conn.open) {
      try {
        link.conn.send(msg)
      } catch {
        /* dropped mid-send */
      }
    } else {
      link.buf.push(msg) // flushed on 'open'
    }
  }

  const wire = (conn: MediaConnection, initiatedByUs: boolean) => {
    links.set(conn.peer, { conn, initiatedByUs })
    conn.on('stream', (stream) => {
      if (!closed) onRemote(conn.peer, stream)
    })
    const teardown = () => {
      // Only clear if this is still the current link (a re-dial replaces it).
      if (links.get(conn.peer)?.conn === conn) {
        links.delete(conn.peer)
        onRemote(conn.peer, null)
      }
    }
    conn.on('close', teardown)
    conn.on('error', teardown)
  }

  const dial = (id: string) => {
    if (closed || !local) return
    // Drop any prior link without nulling the remote tile (avoids a flicker on re-dial).
    const prev = links.get(id)
    if (prev) {
      links.delete(id)
      try {
        prev.conn.close()
      } catch {
        /* already closed */
      }
    }
    // CRITICAL: always offer BOTH media sections (see module docs). PeerJS forwards
    // `constraints` to createOffer though its CallOption type doesn't declare it.
    const conn = peer.call(id, local, {
      constraints: { offerToReceiveAudio: true, offerToReceiveVideo: true },
    } as CallOption)
    if (conn) {
      wire(conn, true)
      applyConn(id, conn) // gate this peer from the first frame (e.g. a joiner during a share)
    }
  }

  const acceptIncoming = (conn: MediaConnection) => {
    const prev = links.get(conn.peer)
    if (prev) {
      links.delete(conn.peer)
      try {
        prev.conn.close()
      } catch {
        /* ignore */
      }
    }
    conn.answer(local ?? undefined)
    wire(conn, false)
    applyConn(conn.peer, conn) // gate this peer from the first frame
  }

  // Someone is dialling us (we're the answerer for this pair). If our stream isn't
  // ready yet, defer answering until setLocalStream — answering with no stream would
  // leave us permanently silent/invisible to that peer (the answerer never re-dials).
  const onIncoming = (conn: MediaConnection) => {
    if (closed) return
    if (!local) pendingIn.push(conn)
    else acceptIncoming(conn)
  }
  peer.on('call', onIncoming)

  return {
    setLocalStream: (stream) => {
      local = stream
      // Seed the gate's notion of the real outgoing track per lane (so a withheld peer's
      // placeholder swaps back to the right track when re-granted).
      realTrack.audio = stream?.getAudioTracks()[0] ?? null
      realTrack.video = stream?.getVideoTracks()[0] ?? null
      // Answer anyone who dialled us before our stream existed.
      while (pendingIn.length) {
        const conn = pendingIn.shift()
        if (conn) acceptIncoming(conn)
      }
      // Only reachable if the stream object itself is replaced — camera toggles
      // mutate the same stream and go through replaceVideoTrack instead.
      for (const [id, link] of links) if (link.initiatedByUs) dial(id)
    },
    // Swap the outgoing video on every LIVE connection — but PER PEER through the gate, so
    // a screen share is withheld (placeholder substituted) from a peer lacking `see-screen`.
    replaceVideoTrack: (track) => {
      realTrack.video = track
      for (const [id, { conn }] of links) applyKind(id, conn, 'video')
    },
    // Same per-peer gate for audio: a peer lacking `hear-audio` keeps the silent placeholder.
    replaceAudioTrack: (track) => {
      realTrack.audio = track
      for (const [id, { conn }] of links) applyKind(id, conn, 'audio')
    },
    setMediaGate: (gate, placeholders) => {
      mediaGate = gate
      if (placeholders) {
        gatePh.audio = placeholders.audio
        gatePh.video = placeholders.video
      }
      for (const [id, { conn }] of links) applyConn(id, conn)
    },
    applyMediaGate: () => {
      for (const [id, { conn }] of links) applyConn(id, conn)
    },
    broadcastData: (msg) => {
      for (const link of dataLinks.values()) sendOver(link, msg)
    },
    sendData: (toId, msg) => sendOver(dataLinks.get(toId), msg),
    onData: (cb) => {
      onDataCb = cb
    },
    safetyCodeFor: async (peerId) => {
      const pc = links.get(peerId)?.conn.peerConnection
      return pc ? safetyInfo(pc) : null
    },
    connectionInfoFor: async (peerId) => {
      const pc = links.get(peerId)?.conn.peerConnection
      if (!pc) return null
      try {
        return connInfo(statsToArray(await pc.getStats()))
      } catch {
        return null
      }
    },
    setRoster: (members) => {
      const { initiate, drop } = planRoster(selfId, members, dialled)
      for (const id of drop) {
        const link = links.get(id)
        if (link) {
          links.delete(id)
          try {
            link.conn.close()
          } catch {
            /* ignore */
          }
          onRemote(id, null)
        }
        dialled.delete(id)
      }
      for (const id of initiate) {
        dialled.add(id)
        dial(id)
      }
      // Reconcile the data mesh over the SAME roster (its own dialled set — data
      // connections are independent of media, so they survive media re-dials).
      const data = planRoster(selfId, members, dataDialled)
      for (const id of data.drop) {
        const link = dataLinks.get(id)
        if (link) {
          dataLinks.delete(id)
          try {
            link.conn.close()
          } catch {
            /* ignore */
          }
        }
        dataDialled.delete(id)
      }
      for (const id of data.initiate) {
        dataDialled.add(id)
        dialData(id)
      }
    },
    close: () => {
      closed = true
      peer.off('call', onIncoming)
      peer.off('connection', onIncomingData)
      for (const { conn } of links.values()) {
        try {
          conn.close()
        } catch {
          /* ignore */
        }
      }
      for (const conn of pendingIn) {
        try {
          conn.close()
        } catch {
          /* ignore */
        }
      }
      for (const { conn } of dataLinks.values()) {
        try {
          conn.close()
        } catch {
          /* ignore */
        }
      }
      pendingIn.length = 0
      links.clear()
      dialled.clear()
      dataLinks.clear()
      dataDialled.clear()
    },
  }
}
