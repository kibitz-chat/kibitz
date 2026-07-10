/**
 * The browser half of the galaxy relay handshake (see the `relay/` package
 * project — same fixed-identity WebRTC responder, here used to let LAN browsers
 * rendezvous for an internet-free call).
 *
 * The relay's identity is PERMANENT — fixed port, fixed ICE credentials,
 * persisted DTLS certificate — so its entire half of a WebRTC handshake fits in
 * one static blob: `g1|ufrag|pwd|fp_b64url|addr~port|addr~port…`. We never
 * exchange SDP with the relay: the browser creates its offer, then SYNTHESIZES
 * the relay's answer locally from the blob. The relay is ICE-lite (it only
 * answers checks), so nothing about us needs to reach it out-of-band — it learns
 * our address from the first STUN check we send. Every advertised address
 * becomes a candidate; the browser ICE-probes them all and uses whichever
 * reaches (so a virtual-adapter address is harmless, not fatal).
 */

const fromB64url = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

export interface GalaxyEndpoint {
  addr: string
  port: number
}

/** A LAN TURN advertised by a g2 relay: the hub runs it so offline MEDIA relays THROUGH the hub instead of
 *  peer-to-peer (which iOS/mDNS breaks on a phone LAN). It listens on every endpoint addr at `port`. */
export interface GalaxyTurn {
  port: number
  user: string
  pass: string
}

export interface GalaxyConfig {
  ufrag: string
  pwd: string
  /** DTLS certificate fingerprint, raw 32 bytes (sha-256). */
  fp: Uint8Array
  endpoints: GalaxyEndpoint[]
  /** g2 only: a LAN TURN on each endpoint addr, so offline media routes through the hub. Absent on g1. */
  turn?: GalaxyTurn
}

const parseEndpoint = (s: string): GalaxyEndpoint | null => {
  const tilde = s.lastIndexOf('~')
  if (tilde <= 0) return null
  const addr = s.slice(0, tilde)
  const port = Number(s.slice(tilde + 1))
  if (!addr || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { addr, port }
}

const parseTurn = (spec: string | undefined): GalaxyTurn | undefined => {
  if (!spec) return undefined
  const [p, user, pass] = spec.split(',')
  const port = Number(p)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !user || !pass) return undefined
  return { port, user, pass }
}

export function parseGalaxyBlob(blob: string | null | undefined): GalaxyConfig | null {
  if (!blob) return null
  const parts = blob.trim().split('|')
  if (parts.length < 5) return null
  const v = parts[0]
  const ufrag = parts[1]
  const pwd = parts[2]
  const fp64 = parts[3]
  if ((v !== 'g1' && v !== 'g2') || !ufrag || !pwd || !fp64) return null
  // g2 inserts a TURN spec as field 4 (`port,user,pass`); endpoints follow at 5+. g1 has endpoints from field 4.
  const turn = v === 'g2' ? parseTurn(parts[4]) : undefined
  const addrParts = parts.slice(v === 'g2' ? 5 : 4)
  const endpoints = addrParts.map(parseEndpoint).filter((e): e is GalaxyEndpoint => e !== null)
  if (endpoints.length === 0) return null
  try {
    const fp = fromB64url(fp64)
    if (fp.length !== 32) return null
    return { ufrag, pwd, fp, endpoints, turn }
  } catch {
    return null
  }
}

const toB64url = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Serialize a GalaxyConfig back to its blob string — the inverse of parseGalaxyBlob. Emits g2 (with the TURN
 *  spec) when cfg.turn is set, else g1. Used to turn a DISCOVERED hub (the fixed identity + its found LAN IP)
 *  into a shareable `?galaxy=` link, so an offline call a creator started can be invited to by link. */
export function buildGalaxyBlob(cfg: GalaxyConfig): string {
  const fp64 = toB64url(cfg.fp)
  const eps = cfg.endpoints.map((e) => `${e.addr}~${e.port}`)
  if (cfg.turn) {
    const { port, user, pass } = cfg.turn
    return ['g2', cfg.ufrag, cfg.pwd, fp64, `${port},${user},${pass}`, ...eps].join('|')
  }
  return ['g1', cfg.ufrag, cfg.pwd, fp64, ...eps].join('|')
}

/** ICE servers for the OFFLINE media mesh: the relay's LAN TURN (g2) on each raw-IP endpoint, so audio/video
 *  relays THROUGH the hub instead of peer-to-peer (which iOS/mDNS breaks on a LAN). Empty on g1 / no TURN. */
export function turnServersFor(cfg: GalaxyConfig | null): RTCIceServer[] {
  if (!cfg?.turn) return []
  const { port, user, pass } = cfg.turn
  const seen = new Set<string>()
  const servers: RTCIceServer[] = []
  for (const e of cfg.endpoints) {
    // Raw IPv4 only — the TURN listens on all interfaces; a `.local` mDNS name as the TURN host is useless.
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(e.addr) || seen.has(e.addr)) continue
    seen.add(e.addr)
    servers.push({ urls: `turn:${e.addr}:${port}?transport=udp`, username: user, credential: pass })
  }
  return servers
}

/** Build the relay's SDP answer for OUR offer — no network involved. One
 * candidate per advertised endpoint; the browser probes all in parallel. */
export function synthGalaxyAnswer(offerSdp: string, cfg: GalaxyConfig): string {
  const mid = /a=mid:(\S+)/.exec(offerSdp)?.[1] ?? '0'
  const fpHex = Array.from(cfg.fp)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(':')
  const candidates = cfg.endpoints.map(
    (e, i) => `a=candidate:${i + 1} 1 udp ${2130706431 - i} ${e.addr} ${e.port} typ host generation 0`,
  )
  return (
    [
      'v=0',
      'o=- 1 1 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'a=ice-lite',
      'a=group:BUNDLE ' + mid,
      'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 0.0.0.0',
      'a=ice-ufrag:' + cfg.ufrag,
      'a=ice-pwd:' + cfg.pwd,
      'a=fingerprint:sha-256 ' + fpHex,
      'a=setup:passive',
      'a=mid:' + mid,
      'a=sctp-port:5000',
      'a=max-message-size:262144',
      ...candidates,
    ].join('\r\n') + '\r\n'
  )
}
