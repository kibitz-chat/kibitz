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

export interface GalaxyConfig {
  ufrag: string
  pwd: string
  /** DTLS certificate fingerprint, raw 32 bytes (sha-256). */
  fp: Uint8Array
  endpoints: GalaxyEndpoint[]
}

const parseEndpoint = (s: string): GalaxyEndpoint | null => {
  const tilde = s.lastIndexOf('~')
  if (tilde <= 0) return null
  const addr = s.slice(0, tilde)
  const port = Number(s.slice(tilde + 1))
  if (!addr || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { addr, port }
}

export function parseGalaxyBlob(blob: string | null | undefined): GalaxyConfig | null {
  if (!blob) return null
  const parts = blob.trim().split('|')
  if (parts.length < 5) return null
  const [v, ufrag, pwd, fp64, ...addrParts] = parts
  if (v !== 'g1' || !ufrag || !pwd || !fp64) return null
  const endpoints = addrParts.map(parseEndpoint).filter((e): e is GalaxyEndpoint => e !== null)
  if (endpoints.length === 0) return null
  try {
    const fp = fromB64url(fp64)
    if (fp.length !== 32) return null
    return { ufrag, pwd, fp, endpoints }
  } catch {
    return null
  }
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
