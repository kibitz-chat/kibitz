import { parseGalaxyBlob, synthGalaxyAnswer, type GalaxyConfig } from './galaxySignal'

/**
 * Live connection to the galaxy relay's hub — the rendezvous for an
 * internet-free LAN call. The relay is deliberately DUMB (assigns each peer an
 * id and routes `{to,payload}` frames, nothing else) because it ships inside an
 * Android app / Pi binary that updates rarely; ALL call semantics (presence,
 * roster, media signaling) live here in the web layer as GalaxyFrame payloads.
 *
 * The blob arrives once via `?galaxy=…` and persists in localStorage — open the
 * relay's link once on real internet (or its WiFi), and Kibitz works on that LAN
 * forever after. `?galaxy=off` clears it.
 */

const STORE_KEY = 'kbz.galaxy'

let cachedBlob: string | null | undefined

/** The configured relay, or null. URL ?galaxy=… wins and persists. */
export function activeGalaxy(): GalaxyConfig | null {
  if (cachedBlob !== undefined) return parseGalaxyBlob(cachedBlob)
  cachedBlob = null
  if (typeof window === 'undefined') return null
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('galaxy')
    if (fromUrl === 'off') {
      localStorage.removeItem(STORE_KEY)
      return null
    }
    const candidate = fromUrl ?? localStorage.getItem(STORE_KEY)
    if (parseGalaxyBlob(candidate)) {
      cachedBlob = candidate
      if (fromUrl) localStorage.setItem(STORE_KEY, fromUrl)
    }
  } catch {
    cachedBlob = null
  }
  return parseGalaxyBlob(cachedBlob)
}

/** Whether a relay is configured (drives the offline-call UI). */
export function hasGalaxy(): boolean {
  return activeGalaxy() !== null
}

export interface GalaxyHub {
  /** Our hub id — also our identity in the call (used as the media peer id). */
  readonly id: number
  send(to: number, frame: unknown): void
  /** Send a frame to every other current hub peer (presence, mesh fan-out). */
  broadcast(frame: unknown): Promise<void>
  onFrame(cb: (from: number, frame: unknown) => void): () => void
  /** Current hub peer ids (including ourselves). */
  peers(): Promise<number[]>
  onClose(cb: () => void): void
  close(): void
}

const OPEN_TIMEOUT_MS = 6000

export async function connectGalaxy(cfg: GalaxyConfig): Promise<GalaxyHub> {
  const pc = new RTCPeerConnection({ iceServers: [] })
  const dc = pc.createDataChannel('hub')
  await pc.setLocalDescription(await pc.createOffer())
  await pc.setRemoteDescription({ type: 'answer', sdp: synthGalaxyAnswer(pc.localDescription?.sdp ?? '', cfg) })

  const cbs = new Set<(from: number, frame: unknown) => void>()
  const closeCbs = new Set<() => void>()
  let peersWaiter: ((ids: number[]) => void) | null = null
  let closed = false

  const myId = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      pc.close()
      reject(new Error('relay unreachable'))
    }, OPEN_TIMEOUT_MS)
    dc.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data as string) as
          | { t: 'id'; id: number }
          | { t: 'peers'; ids: number[] }
          | { t: 'from'; id: number; payload: unknown }
        if (m.t === 'id') {
          clearTimeout(timer)
          resolve(m.id)
        } else if (m.t === 'peers') {
          peersWaiter?.(m.ids)
          peersWaiter = null
        } else if (m.t === 'from') {
          for (const cb of cbs) cb(m.id, m.payload)
        }
      } catch {
        /* malformed hub frame — drop */
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        clearTimeout(timer)
        if (!closed) {
          closed = true
          for (const cb of closeCbs) cb()
        }
        reject(new Error('relay connection failed'))
      }
    }
  })
  dc.onclose = () => {
    if (!closed) {
      closed = true
      for (const cb of closeCbs) cb()
    }
  }

  const peers = (): Promise<number[]> =>
    new Promise((resolve) => {
      peersWaiter = resolve
      if (dc.readyState === 'open') dc.send(JSON.stringify({ t: 'peers' }))
      setTimeout(() => {
        if (peersWaiter === resolve) {
          peersWaiter = null
          resolve([])
        }
      }, 3000)
    })

  return {
    id: myId,
    send(to, frame) {
      if (dc.readyState === 'open') dc.send(JSON.stringify({ t: 'to', id: to, payload: frame }))
    },
    async broadcast(frame) {
      const ids = await peers()
      for (const id of ids) if (id !== myId && dc.readyState === 'open') {
        dc.send(JSON.stringify({ t: 'to', id, payload: frame }))
      }
    },
    onFrame(cb) {
      cbs.add(cb)
      return () => cbs.delete(cb)
    },
    peers,
    onClose(cb) {
      closeCbs.add(cb)
    },
    close() {
      closed = true
      try {
        dc.close()
      } catch {
        /* ignore */
      }
      pc.close()
    },
  }
}

// ---- shared instance (one hub connection serves the whole app) --------------

let current: Promise<GalaxyHub> | null = null

export function ensureGalaxyHub(): Promise<GalaxyHub> {
  const cfg = activeGalaxy()
  if (!cfg) return Promise.reject(new Error('no relay configured'))
  current ??= connectGalaxy(cfg)
    .then((hub) => {
      hub.onClose(() => {
        current = null
      })
      return hub
    })
    .catch((e: unknown) => {
      current = null
      throw e
    })
  return current
}

export function closeGalaxyHub(): void {
  const c = current
  current = null
  void c?.then((hub) => hub.close()).catch(() => undefined)
}
