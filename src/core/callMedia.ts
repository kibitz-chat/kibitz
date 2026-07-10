import { Peer } from 'peerjs'
import { createVoiceMesh, type GateKind, type VoiceMesh } from './mesh'
import { createLanMesh } from './lanMesh'
import { getIceServers } from './iceConfig'
import { chooseSignal } from './signalConfig'
import { BROKER_PING_MS, keepAlive } from './transport'
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

// FORCE RELAY (iceTransportPolicy:'relay' on every online media/presence pc). The reliability hazard it guarded:
// on 4G↔WiFi, ICE can pick a peer-reflexive (prflx) UDP pair that PASSES the STUN checks (ice=connected) but never
// carries inbound media to a CGNAT'd phone — and "connected ≠ media flowing" gave the app no clean signal to fall
// back, so it churned on the dead prflx pair. Forcing relay/relay from pc CREATION sidestepped detection entirely,
// at the cost of ALL media relaying (latency + TURN bandwidth). History: forced ON 2026-07-01 (c1ce5c5); a first
// direct-first attempt (cfa8954) regressed 4G and was re-enabled (cfe6e88) — relay-on-fallback couldn't reliably
// escalate a connected-but-dead pc back then.
//
// A direct-first attempt (ff2d049, 2026-07-02) tried to make escalation DURABLE — a connected-but-never-flowed pc
// jumps straight to relay-only (redialPlan, mediaRecover.ts) and that choice STICKS via the sticky-relay latch
// (065c4a6, `relayLatched` in mesh.ts) so it can't revert to the dead prflx pair and churn. In theory healthy
// networks go direct and only a one-way-dead 4G pc escalates to its stable TURN relay.
//
// ⚠️ BUT it REGRESSED 4G↔WiFi AGAIN on-device (2026-07-02) — the SECOND direct-first regression. The latch keeps a
// re-dial from reverting, but it doesn't fix the ROOT problem: a connected-but-media-dead prflx pc isn't detected
// reliably/fast enough, so the escalation either never fires or fires too late. Until that detection is genuinely
// device-proven, relay-for-everyone was the reliable default. relayOnly (privacy) opt-in is unchanged.
//
// 2026-07-03: TRIED direct-first globally (default false) on the theory that the openHumans split-roster bug
// (64f0964) had contaminated the earlier 4G tests. It REGRESSED on-device the SAME DAY (Samsung: no audio at all)
// and was reverted to relay-on. So the connected-but-media-dead hazard is REAL — it is NOT merely the roster bug;
// this was the THIRD failed direct-first attempt. Conclusion: direct-first needs genuine connected-but-media-dead
// DETECTION (inbound-RTP getStats watchdog in mediaRecover.ts / redialPlan), device-proven on a REAL 4G↔WiFi call,
// BEFORE it can be the default — the sticky latch alone isn't enough. relay-for-everyone stays the reliable
// default. The per-device override still works: `?relay=0` opts a device INTO direct-first for future testing.
export const FORCE_RELAY_DEFAULT = true

/**
 * Effective relay-forcing policy, read at CONNECT time so a per-device runtime override can flip it WITHOUT a
 * redeploy or exposing anyone else. Override via `?relay=0` (direct-first) or `?relay=1` (force) on any page load —
 * it's persisted to localStorage (`kbz.forceRelay`) so it sticks for that device across the room navigation. Lets
 * us trial direct-first on specific phones (the 4G↔WiFi test) while the GLOBAL default stays relay-on. Unset ⇒
 * FORCE_RELAY_DEFAULT.
 */
export function forceRelay(): boolean {
  try {
    const p = new URLSearchParams(location.search).get('relay')
    if (p === '0' || p === '1') localStorage.setItem('kbz.forceRelay', p)
    const o = localStorage.getItem('kbz.forceRelay')
    if (o === '0' || o === 'false') return false
    if (o === '1' || o === 'true') return true
  } catch {
    /* no window/localStorage (SSR/tests) → the default */
  }
  return FORCE_RELAY_DEFAULT
}

/** Online backend: a fresh PeerJS peer is the media identity; broker signaling. */
export function peerJsMedia(): CallMedia {
  let peer: Peer | null = null
  let stopKA: (() => void) | null = null
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
        // Same broker keepalive as the presence peer (BROKER_PING_MS = 5s). 25s here idled THIS media socket
        // out to a `WS close 1006` on flaky mobile — the exact reason transport.ts was reverted from 25s to 5s.
        // The media broker WS is how a LATE JOINER `peer.connect()`s us and how a dropped data link re-dials, so
        // it must stay warm for the whole call, not just the setup.
        pingInterval: BROKER_PING_MS,
        config: {
          iceServers,
          ...(opts?.relayOnly || forceRelay() ? { iceTransportPolicy: 'relay' as const } : {}),
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
      // Reconnect the media broker WS on a mobile flap / foreground, exactly like the presence peer — without this
      // a dropped socket stays dead for the whole call (id unregistered → no late-joiner connect, no re-dial).
      // Must be STOPPED before peer.destroy() (see transport.ts module doc: reconnect fires before `destroyed`).
      stopKA = keepAlive(vpeer)
      // The OWNED media pcs need the same iceServers (TURN), relay policy + certificate as the PeerJS Peer used to —
      // PeerJS now only carries data + presence; media (its pc + signaling) is ours, riding the data channel.
      const mesh = createVoiceMesh({
        peer: vpeer,
        selfId: voiceId,
        onRemote,
        rtcConfig: {
          iceServers,
          ...(opts?.relayOnly || forceRelay() ? { iceTransportPolicy: 'relay' as const } : {}),
          ...(opts?.certificate ? { certificates: [opts.certificate] } : {}),
        },
      })
      // Install the media gate BEFORE the stream — so a peer already dialling us is gated the
      // instant setLocalStream answers it (no real-track window for a withheld peer).
      if (opts?.mediaGate) mesh.setMediaGate?.(opts.mediaGate.gate, opts.mediaGate.placeholders)
      mesh.setLocalStream(local)
      return { voiceId, mesh }
    },
    close() {
      closed = true
      try {
        stopKA?.() // BEFORE destroy — see transport.ts module doc (keep-alive reconnect re-registers a zombie id)
      } catch {
        /* ignore */
      }
      stopKA = null
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
    replaceShareTrack() {},
    remoteShareTrack: () => null,
    replaceShareAudioTrack() {},
    remoteShareAudioTrack: () => null,
    replaceAudioTrack() {},
    setRoster() {},
    setAdmit() {},
    liveMeshPeers: () => [],
    broadcastData() {},
    sendData() {},
    dataBufferedAmount: () => 0, // no peers in preview → never backpressured
    dataLinkOpen: () => false, // no peers in preview → no live data link
    onData() {},
    onDataLinkOpen() {}, // no peers in preview → never fires
    onPeerLeft() {}, // no peers in preview → never fires
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
