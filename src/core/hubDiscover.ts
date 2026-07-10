import { connectGalaxy, type GalaxyHub } from './galaxyHub'
import type { GalaxyConfig } from './galaxySignal'

/**
 * Zero-input LAN-hub discovery (no QR). The relay (in the APK) uses one FIXED, well-known WebRTC identity
 * (relaycore/fixedid.go). We bake in the same constants here and PROBE the LAN: for each candidate IP we try
 * to bring up the galaxy hub connection (connectGalaxy) using that fixed identity; the one device that answers
 * is the hub. WebRTC isn't subject to mixed-content/cert rules, so this works from the HTTPS PWA where an HTTP
 * probe couldn't.
 *
 * Trust = "open on this Wi-Fi" (the identity is public). Intended for a trusted LAN; the QR path stays for when
 * you want a real gate.
 */

// Must match relaycore/fixedid.go exactly.
const FIXED_UFRAG = 'wbxlanhub01'
const FIXED_PWD = '774B1GNZgs48OidH45A7DZx'
const FIXED_FP_B64URL = 'iMQvZo7x61ukUXjDvSJnKmr3PFy6iDvHSa9XV3mb_kA' // sha-256 of the fixed DTLS cert
const FIXED_TURN = { port: 3478, user: 'wblan', pass: 'Sp64SHsXMZOdzT6rgYcF' }
const HUB_PORT = 4711 // relaycore defaultPorts[0]

const fromB64url = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

// A human-readable discovery status for the offline UI — the probe is otherwise SILENT, so a guest can't tell
// "still searching" from "found" from "nothing here". One subscriber (the offline screen); also mirrored to the
// console so a desktop tester can read the detail.
let statusCb: ((s: string | null) => void) | null = null
export function onDiscoveryStatus(cb: (s: string | null) => void): () => void {
  statusCb = cb
  return () => {
    if (statusCb === cb) statusCb = null
  }
}
function setDiscoverStatus(s: string | null): void {
  if (s) console.info('[kbz.discover]', s)
  try {
    statusCb?.(s)
  } catch {
    /* a bad subscriber must never break discovery */
  }
}

// Remember the last hub we reached, so a repeat call on the same Wi-Fi probes it FIRST (near-instant) instead of
// re-scanning the whole LAN. A stale value (host moved / new DHCP lease) just costs one quick probe before the
// normal scan takes over — never wrong, only ever a head start.
const LAST_HUB_KEY = 'kbz.lastHub'
function lastHubIp(): string | null {
  try {
    return localStorage.getItem(LAST_HUB_KEY)
  } catch {
    return null
  }
}
function rememberHub(ip: string): void {
  try {
    localStorage.setItem(LAST_HUB_KEY, ip)
  } catch {
    /* private mode / no storage — fine, we just re-scan next time */
  }
}

/** The GalaxyConfig for a candidate hub IP — fixed identity, that IP as the sole endpoint, fixed TURN. */
export const configFor = (ip: string): GalaxyConfig => ({
  ufrag: FIXED_UFRAG,
  pwd: FIXED_PWD,
  fp: fromB64url(FIXED_FP_B64URL),
  endpoints: [{ addr: ip, port: HUB_PORT }],
  turn: { ...FIXED_TURN },
})

const isPrivateV4 = (ip: string): boolean =>
  /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)

/** EVERY one of our own /24 prefixes on the LAN, from the raw private ICE host candidates. A laptop commonly has
 *  SEVERAL private interfaces at once (Wi-Fi + a VPN + Docker/virtual adapters), and the hotspot we want is often
 *  NOT the first candidate — so we must collect them ALL and probe each, or we silently scan the wrong subnet and
 *  never reach the host. (iOS hides raw IPs until a media permission, so grab the mic briefly; it has one
 *  interface so this still returns the right one there.) */
export async function localSubnets(): Promise<string[]> {
  if (typeof RTCPeerConnection === 'undefined') return []
  let stream: MediaStream | null = null
  try {
    stream = (await navigator.mediaDevices?.getUserMedia({ audio: true })) ?? null
  } catch {
    /* denied / unavailable */
  }
  const pc = new RTCPeerConnection({ iceServers: [] })
  const subnets = new Set<string>()
  try {
    if (stream) for (const t of stream.getTracks()) pc.addTrack(t, stream)
    else pc.createDataChannel('x')
    await pc.setLocalDescription(await pc.createOffer())
    // Gather to completion (null candidate) or a cap — collect every distinct private /24, don't stop at the first.
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, 1800)
      pc.onicecandidate = (e) => {
        if (!e.candidate) return done() // gathering complete
        const addr = e.candidate.address ?? ''
        if (addr && isPrivateV4(addr)) subnets.add(addr.slice(0, addr.lastIndexOf('.')))
      }
    })
    return [...subnets]
  } finally {
    pc.close()
    stream?.getTracks().forEach((t) => t.stop())
  }
}

/** Candidate hub IPs to probe, best-first: common router/hotspot gateways (covers the host-is-gateway case with
 *  no subnet needed), then every host on our own /24 if we could learn it. */
export async function candidateIps(): Promise<string[]> {
  // Android hotspot (.43/.49), iOS hotspot (172.20.10.1), common home routers, common /8s.
  const gateways = ['192.168.43.1', '192.168.49.1', '172.20.10.1', '192.168.0.1', '192.168.1.1', '10.0.0.1']
  const out: string[] = []
  const seen = new Set<string>()
  const push = (ip: string): void => {
    if (ip && !seen.has(ip)) {
      seen.add(ip)
      out.push(ip)
    }
  }
  // PROBABLE-FIRST ordering so the common cases connect in the first batch or two:
  // 0. The hub we reached last time — try it first (a repeat call on the same Wi-Fi is then near-instant).
  const last = lastHubIp()
  if (last) push(last)
  const subnets = await localSubnets()
  console.info(
    '[kbz.discover] my subnets:',
    subnets.length ? subnets.map((s) => s + '.x').join(', ') : '(none detected)',
    last ? '· last hub ' + last : '',
  )
  // 1. The .1 gateway of each network we're actually on — the host IS the gateway on a hotspot (most likely).
  for (const s of subnets) push(`${s}.1`)
  // 2. Well-known hotspot/router gateways (covers the case where our own subnet is hidden behind mDNS).
  for (const g of gateways) push(g)
  // 3. The low DHCP range (.2–.30) on each of our networks — where a non-gateway host usually lands.
  for (const s of subnets) for (let n = 2; n <= 30; n++) push(`${s}.${n}`)
  // 4. The rest of each /24 (.254, then .31–.253).
  for (const s of subnets) {
    push(`${s}.254`)
    for (let n = 31; n <= 253; n++) push(`${s}.${n}`)
  }
  return out
}

/**
 * Find the LAN hub by probing. Returns a CONNECTED GalaxyHub (the existing flow — joinLanRoom etc. — takes over
 * from there), or throws if nothing answered. Probes in small concurrent batches with a short per-IP timeout so
 * a full /24 sweep stays bounded; the gateway-first ordering makes the common case (host at the gateway) fast.
 */
export async function discoverHub(opts?: { perIpMs?: number; batch?: number; onProgress?: (done: number, total: number) => void }): Promise<{ hub: GalaxyHub; ip: string }> {
  const perIpMs = opts?.perIpMs ?? 1400
  const batch = opts?.batch ?? 10
  const ips = await candidateIps()
  console.info('[kbz.discover] probing', ips.length, 'addresses (first few:', ips.slice(0, 6).join(', ') + ')')
  setDiscoverStatus('Finding the relay on this Wi-Fi…')
  for (let i = 0; i < ips.length; i += batch) {
    const slice = ips.slice(i, i + batch)
    setDiscoverStatus(`Finding the relay on this Wi-Fi… (${Math.min(i + batch, ips.length)}/${ips.length})`)
    opts?.onProgress?.(i, ips.length)
    // Each probe resolves to a hub or rejects (timeout/no answer). Promise.any → the first that connects.
    const tries = slice.map((ip) =>
      connectGalaxy(configFor(ip), perIpMs).then((hub) => ({ ip, hub })),
    )
    const winner = await Promise.any(tries).catch(() => null)
    if (winner) {
      console.info('[kbz.discover] hub answered at', winner.ip)
      rememberHub(winner.ip) // probe this first next time → near-instant repeat connect
      setDiscoverStatus('Found the relay — connecting…')
      // Close any other probe in this batch that also connected (rare: two hubs on one Wi-Fi).
      for (const t of tries) {
        void t
          .then((r) => {
            if (r.ip !== winner.ip) r.hub.close()
          })
          .catch(() => undefined)
      }
      // Return the IP too: the create flow builds a shareable ?galaxy= link from it (the fixed identity + this IP).
      return { hub: winner.hub, ip: winner.ip }
    }
  }
  console.warn('[kbz.discover] NO hub answered across', ips.length, 'addresses')
  setDiscoverStatus('No relay found on this Wi-Fi — is a device running the relay app on this same network?')
  throw new Error('No Kibitz hub found on this Wi-Fi')
}
