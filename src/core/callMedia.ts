import { Peer } from 'peerjs'
import { createVoiceMesh, type GateKind, type VoiceMesh } from './mesh'
import { createLanMesh } from './lanMesh'
import { getIceServers } from './iceConfig'
import { chooseSignal } from './signalConfig'
import type { MeshSignal } from './lanRoom'

/**
 * The media backend behind a call — abstracts WHERE the per-participant media
 * mesh gets its identity and signaling, so one useCall hook drives both:
 *  - online: a dedicated PeerJS peer per participant (broker signaling)
 *  - offline (LAN): the galaxy relay hub (no broker, LAN-direct media)
 * The mesh itself is identical (same VoiceMesh interface, same no-churn laws).
 */
/** Optional per-open knobs. `certificate` PINS a pre-generated DTLS cert so every
 *  connection in the mesh presents the SAME cert — required for the opt-in L3 identity
 *  binding (one signed token, whose nonce hashes this cert's fingerprint, verifies for
 *  all peers). Ignored by the LAN/preview backends. */
export interface OpenOpts {
  certificate?: RTCCertificate
  /** Per-peer media perception gate (capability layer). Installed on the mesh BEFORE the local
   *  stream, so a connection that was already dialling us (answered the instant the stream lands)
   *  is gated from its first frame — no window where a withheld peer gets the real track. */
  mediaGate?: {
    gate: (peerId: string, kind: GateKind) => boolean
    placeholders: { video: MediaStreamTrack | null; audio: MediaStreamTrack | null }
  }
  /** Privacy (Layer 3): force all media/data through the TURN relay (`iceTransportPolicy:'relay'`),
   *  so peers only ever see the relay's IP — not yours. Fail-closed: with no reachable TURN there
   *  are no relay candidates, so the call can't connect (it never silently falls back to a
   *  direct, IP-revealing path). You trust TURN with your IP + that it can't decrypt (DTLS). */
  relayOnly?: boolean
}

export interface CallMedia {
  /** Acquire our media identity (voiceId) and a mesh bound to `local`. */
  open(
    local: MediaStream,
    onRemote: (id: string, stream: MediaStream | null) => void,
    opts?: OpenOpts,
  ): Promise<{ voiceId: string; mesh: VoiceMesh }>
  /** Tear down the media transport (destroy the peer / release nothing for LAN). */
  close(): void
}

/** Online backend: a fresh PeerJS peer is the media identity; broker signaling. */
export function peerJsMedia(): CallMedia {
  let peer: Peer | null = null
  let closed = false
  return {
    async open(local, onRemote, opts) {
      // Robust internet relay: fetch TURN+STUN (Cloudflare Realtime) so strict
      // NATs can relay their media; falls back to STUN-only if TURN isn't
      // configured, so this never regresses the permissive-network case.
      // iceServers add the TURN relay (robust media path); sig is the shared
      // signaling broker (chooseSignal) — same answer the room's presence peer
      // gets, so both halves of a call meet on one network; undefined → public.
      const [iceServers, sig] = await Promise.all([getIceServers(), chooseSignal()])
      if (closed) throw new Error('cancelled')
      const vpeer = new Peer({
        ...sig,
        // 25s broker keepalive (vs PeerJS's 5s default): each heartbeat is a billed request on the
        // signaling worker, so a longer ping cuts idle signaling ~5×. See transport.ts BROKER_PING_MS.
        pingInterval: 25000,
        config: {
          iceServers,
          ...(opts?.relayOnly ? { iceTransportPolicy: 'relay' as const } : {}),
          ...(opts?.certificate ? { certificates: [opts.certificate] } : {}),
        },
      })
      peer = vpeer
      const voiceId = await new Promise<string>((resolve, reject) => {
        vpeer.once('open', (id) => resolve(id))
        vpeer.once('error', (e) => reject(e))
      })
      if (closed || peer !== vpeer) {
        try {
          vpeer.destroy()
        } catch {
          /* ignore */
        }
        throw new Error('cancelled')
      }
      const mesh = createVoiceMesh({ peer: vpeer, selfId: voiceId, onRemote })
      // Install the media gate BEFORE the stream — so a peer already dialling us is gated the
      // instant setLocalStream answers it (no real-track window for a withheld peer).
      if (opts?.mediaGate) mesh.setMediaGate?.(opts.mediaGate.gate, opts.mediaGate.placeholders)
      mesh.setLocalStream(local)
      return { voiceId, mesh }
    },
    close() {
      closed = true
      try {
        peer?.destroy()
      } catch {
        /* ignore */
      }
      peer = null
    },
  }
}

/** Offline backend: identity = the relay hub id; the LAN room's hub channel
 * carries the mesh handshakes. The hub itself is owned by the LanRoom. */
export function lanMedia(signal: MeshSignal, voiceId: () => string): CallMedia {
  return {
    async open(local, onRemote, opts) {
      const id = voiceId()
      if (!id) throw new Error('relay not connected')
      const mesh = createLanMesh({ selfId: id, signal, onRemote })
      if (opts?.mediaGate) mesh.setMediaGate?.(opts.mediaGate.gate, opts.mediaGate.placeholders)
      mesh.setLocalStream(local)
      return Promise.resolve({ voiceId: id, mesh })
    },
    close() {
      /* the mesh is closed by useCall; the hub belongs to the LanRoom */
    },
  }
}

/**
 * Preview backend: a purely LOCAL self-view — NO peers, NO broker, NO network.
 * Lets the real widget render its actual panel (with just your own camera) as a
 * landing demo, so nothing can fail on the wire and no strangers appear. The
 * self tile comes from useCall's own selfStream; the mesh is a no-op.
 */
export function previewMedia(): CallMedia {
  const mesh: VoiceMesh = {
    setLocalStream() {},
    replaceVideoTrack() {},
    replaceAudioTrack() {},
    setRoster() {},
    broadcastData() {},
    sendData() {},
    onData() {},
    safetyCodeFor: () => Promise.resolve(null), // no peers in preview → no code
    connectionInfoFor: () => Promise.resolve(null),
    close() {},
  }
  return {
    open() {
      return Promise.resolve({ voiceId: 'preview', mesh })
    },
    close() {},
  }
}
