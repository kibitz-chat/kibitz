import type { RosterMember, VoiceMesh } from './mesh'
import { safetyInfo } from './safetyCode'
import { connInfo, statsToArray } from './connStats'

/**
 * Offline (LAN) media mesh: raw RTCPeerConnections whose offer/answer/ICE are
 * signaled over the galaxy relay's hub (the relay routes handshakes between
 * peers; media flows DIRECTLY between browsers, LAN-only, `iceServers: []`).
 *
 * Implements the SAME VoiceMesh interface as the online PeerJS mesh (mesh.ts),
 * with the SAME battle-tested no-churn rules:
 *  - smaller id initiates each pair (glare-free)
 *  - every link carries audio + a video lane from the start (the placeholder
 *    track); camera toggles are replaceVideoTrack swaps — NEVER a re-dial
 *    (re-dial churn crashes iOS WebKit natively)
 *  - trickle ICE over the relay (no QR ceremony — the hub is already connected)
 */

interface SignalChannel {
  send(to: string, payload: unknown): void
  onSignal(cb: (from: string, payload: unknown) => void): () => void
}

type SigPayload = { d?: RTCSessionDescriptionInit; c?: RTCIceCandidateInit }

export function createLanMesh(opts: {
  selfId: string
  signal: SignalChannel
  onRemote: (id: string, stream: MediaStream | null) => void
}): VoiceMesh {
  const { selfId, signal, onRemote } = opts
  const links = new Map<string, RTCPeerConnection>()
  let local: MediaStream | null = null
  let closed = false

  // --- Data mesh: an RTCDataChannel on each peer connection, so content
  // (chat/co-browse/pay/ink) goes peer-to-peer over the LAN, not through the hub.
  // The hub still carries the offer/answer/ICE handshake, never the content.
  const dataChans = new Map<string, { ch: RTCDataChannel; buf: unknown[] }>()
  let onDataCb: ((fromId: string, msg: unknown) => void) | null = null

  const wireData = (remote: string, ch: RTCDataChannel) => {
    const entry = { ch, buf: [] as unknown[] }
    dataChans.set(remote, entry)
    ch.onopen = () => {
      for (const m of entry.buf.splice(0)) {
        try {
          ch.send(JSON.stringify(m))
        } catch {
          /* closed between open and flush */
        }
      }
    }
    ch.onmessage = (e) => {
      // Deliver only from the CURRENT channel for this peer — a replaced/stale channel
      // could otherwise keep firing buffered frames after its replacement.
      if (closed || dataChans.get(remote)?.ch !== ch) return
      try {
        onDataCb?.(remote, JSON.parse(e.data as string))
      } catch {
        /* malformed frame — ignore */
      }
    }
    const drop = () => {
      if (dataChans.get(remote)?.ch === ch) dataChans.delete(remote)
    }
    ch.onclose = drop
    ch.onerror = drop // a channel error needn't fire close — don't leave a stale entry
  }

  const sendOver = (remote: string, msg: unknown) => {
    const entry = dataChans.get(remote)
    if (!entry) return
    if (entry.ch.readyState === 'open') {
      try {
        entry.ch.send(JSON.stringify(msg))
      } catch {
        /* dropped mid-send */
      }
    } else {
      entry.buf.push(msg)
    }
  }

  const makeLink = (remote: string): RTCPeerConnection => {
    const pc = new RTCPeerConnection({ iceServers: [] })
    links.set(remote, pc)
    local?.getTracks().forEach((t) => pc.addTrack(t, local as MediaStream))
    // Answerer receives the data channel the initiator created; the initiator's own
    // ondatachannel never fires, so setting it on both sides is harmless.
    pc.ondatachannel = (e) => wireData(remote, e.channel)
    pc.onicecandidate = (e) => {
      if (e.candidate) signal.send(remote, { c: e.candidate.toJSON() } satisfies SigPayload)
    }
    const stream = new MediaStream()
    pc.ontrack = (e) => {
      stream.addTrack(e.track)
      onRemote(remote, stream)
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (links.get(remote) === pc) {
          links.delete(remote)
          dataChans.delete(remote)
          onRemote(remote, null)
        }
      }
    }
    return pc
  }

  const dial = async (remote: string) => {
    const pc = makeLink(remote)
    wireData(remote, pc.createDataChannel('content')) // initiator opens the data channel
    try {
      await pc.setLocalDescription(await pc.createOffer())
      signal.send(remote, { d: pc.localDescription?.toJSON() } satisfies SigPayload)
    } catch {
      /* link dropped mid-dial — the roster reconcile retries */
    }
  }

  const unsub = signal.onSignal((from, raw) => {
    if (closed || !raw || typeof raw !== 'object') return
    const payload = raw as SigPayload
    void (async () => {
      try {
        if (payload.d) {
          if (payload.d.type === 'offer') {
            // Answer side (we're the larger id). A fresh offer replaces any link.
            links.get(from)?.close()
            links.delete(from)
            dataChans.delete(from)
            const pc = makeLink(from)
            await pc.setRemoteDescription(payload.d)
            await pc.setLocalDescription(await pc.createAnswer())
            signal.send(from, { d: pc.localDescription?.toJSON() } satisfies SigPayload)
          } else {
            await links.get(from)?.setRemoteDescription(payload.d)
          }
        } else if (payload.c) {
          await links.get(from)?.addIceCandidate(payload.c)
        }
      } catch {
        /* stale handshake from a replaced link — ignore */
      }
    })()
  })

  return {
    setLocalStream(stream) {
      local = stream
    },
    replaceVideoTrack(track) {
      for (const pc of links.values()) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
        void sender?.replaceTrack(track)
      }
    },
    replaceAudioTrack(track) {
      for (const pc of links.values()) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'audio')
        void sender?.replaceTrack(track)
      }
    },
    broadcastData(msg) {
      for (const id of dataChans.keys()) sendOver(id, msg)
    },
    sendData(toId, msg) {
      sendOver(toId, msg)
    },
    onData(cb) {
      onDataCb = cb
    },
    safetyCodeFor(peerId: string) {
      const pc = links.get(peerId)
      return pc ? safetyInfo(pc) : Promise.resolve(null)
    },
    connectionInfoFor(peerId: string) {
      const pc = links.get(peerId)
      if (!pc) return Promise.resolve(null)
      return pc
        .getStats()
        .then((report) => connInfo(statsToArray(report)))
        .catch(() => null)
    },
    setRoster(members: readonly RosterMember[]) {
      if (closed) return
      const present = new Set(members.map((m) => m.id))
      for (const [id, pc] of links) {
        if (!present.has(id)) {
          pc.close()
          links.delete(id)
          dataChans.delete(id)
          onRemote(id, null)
        }
      }
      for (const m of members) {
        if (m.id === selfId || links.has(m.id)) continue
        if (selfId < m.id) void dial(m.id) // glare-free: smaller id initiates
      }
    },
    close() {
      closed = true
      unsub()
      for (const pc of links.values()) pc.close()
      links.clear()
      dataChans.clear()
    },
  }
}
