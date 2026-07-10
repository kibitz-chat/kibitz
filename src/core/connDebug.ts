// On-screen WebRTC connectivity debug overlay — the PANEL is hidden by default, but capture is ALWAYS on.
//
// The wrappers install at load and silently capture every call (cheap: a few read-only event listeners; the
// heavier getStats poll runs only while the panel is visible). CHEAT TO REVEAL: tap the BOTTOM-LEFT corner 5 times
// fast (within ~1.5s) to show/hide the panel; the choice persists across reloads (a localStorage flag). Because
// capture is always running, revealing it MID-CALL shows the FULL picture (existing connections included), not pcs:0.
//
// When on it wraps RTCPeerConnection + WebSocket (read-only) and probes /api/turn + /api/signal to surface, ON
// SCREEN: api turn/sig reachability, RELAY-candidate yes/no, the broker WebSocket state + url, and per-pc the
// ICE-server count / policy / candidate types / ice & connection state / received tracks / inbound video frames.

import { getTurnEndpoint } from './turnConfig'
import { chooseSignal } from './signalConfig'
import { logSignalEvent, getSignalLog } from './diag'

const STORE_KEY = 'kbz.debug'
// One-time kill of a STALE sticky debug flag. A tester who 5-tapped the overlay ON has kbz.debug='1' persisted,
// so the app re-opens with capture/overlay armed indefinitely on that browser. Bumping RESET_EPOCH wipes that
// flag ONCE per browser on the next load; a later DELIBERATE re-enable still sticks (until the epoch bumps again).
const RESET_EPOCH = '2026-07-04'
const RESET_KEY = 'kbz.debug.reset'
export function clearStaleDebug(): void {
  if (typeof window === 'undefined') return
  try {
    if (localStorage.getItem(RESET_KEY) === RESET_EPOCH) return // already reset for this epoch — leave the flag alone
    localStorage.removeItem(STORE_KEY) // drop the stale sticky flag → overlay + getStats capture start OFF
    localStorage.setItem(RESET_KEY, RESET_EPOCH)
  } catch {
    /* storage blocked — nothing to clear */
  }
}
let installed = false
// The 1 Hz panel redraw runs ONLY while the overlay is on. The RTCPeerConnection capture stays always-on
// (so toggling the panel mid-call shows existing connections), but redrawing a hidden panel every second is
// pure idle waste. `drawFn` is captured when installConnDebug runs; the toggle starts/stops the loop.
let drawTimer = 0
let drawFn: (() => void) | null = null
function startDrawLoop(): void {
  if (drawTimer || !drawFn) return
  drawFn()
  drawTimer = window.setInterval(drawFn, 1000)
}
function stopDrawLoop(): void {
  if (drawTimer) {
    clearInterval(drawTimer)
    drawTimer = 0
  }
  drawFn?.() // one final pass removes the panel DOM now that debug is off
}

/** Persisted toggle — true once the cheat has turned the overlay on (until turned off). */
export function debugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(STORE_KEY) === '1'
  } catch {
    return false
  }
}

function setDebugEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(STORE_KEY, '1')
    else localStorage.removeItem(STORE_KEY)
  } catch {
    /* ignore */
  }
}

interface PcInfo {
  pc: RTCPeerConnection
  cands: Set<string>
  ice: string
  conn: string
  srv: number
  pol: string
  recv: Set<string>
  rxEver: boolean // sticky: did ANY inbound RTP byte ever arrive on this pc? (∅ = media never flowed, vs flowed-then-died)
  pair: string // selected ICE candidate pair, local/remote type (h/s/p/r) — the path media ACTUALLY takes
  tp: string // transport of the local candidate (udp/tcp/tls) — a UDP path that connects but never carries media = 4G throttle
  codec: string // negotiated audio codec (e.g. opus) — to spot a cross-browser (iOS↔Android) codec mismatch
  vid: string
  statTimer: number // the per-pc getStats interval id — cleared (and the pc pruned) once the pc closes
}

export function installConnDebug(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  clearStaleDebug() // neutralize any stale sticky-debug flag BEFORE the boot below (or anyone) reads debugEnabled()
  const pcs: PcInfo[] = []
  let apiLine = 'api: probing…'

  // ── reachability probe: hit the REAL hosts the app uses (brand turnHost + the resolved broker), NOT same-origin.
  // A brand build served from a static origin (kibitz.chat has no /api/*) would otherwise show a misleading 403
  // while the app is actually fetching TURN from kibitz.chat and signaling via signal.kibitz.chat just fine.
  const probeTurn = async (): Promise<string> => {
    try {
      const res = await fetch(getTurnEndpoint(), { credentials: 'omit' })
      if (!res.ok) return `${res.status}`
      const data = (await res.json()) as { iceServers?: unknown }
      const n = Array.isArray(data.iceServers) ? data.iceServers.length : 0
      return `ok${n}${JSON.stringify(data).includes('turn:') ? '+TURN' : ''}`
    } catch {
      return 'ERR✗'
    }
  }
  void (async () => {
    const sig = await chooseSignal().catch(() => undefined)
    apiLine = `api turn:${await probeTurn()} sig:${sig?.host ?? 'public'}`
  })()

  // ── wrap RTCPeerConnection (capture ICE-server config + candidate types + state + tracks) ──────
  const OPC = window.RTCPeerConnection
  if (OPC) {
    const Wrapped = function (this: unknown, ...args: unknown[]) {
      const pc = new (OPC as unknown as { new (...a: unknown[]): RTCPeerConnection })(...args)
      const cfg = args[0] as RTCConfiguration | undefined
      const info: PcInfo = {
        pc,
        cands: new Set(),
        ice: 'new',
        conn: 'new',
        srv: cfg?.iceServers?.length ?? 0,
        pol: cfg?.iceTransportPolicy ?? 'all',
        recv: new Set(),
        rxEver: false,
        pair: '—',
        tp: '—',
        codec: '—',
        vid: '—',
        statTimer: 0,
      }
      pcs.push(info)
      try {
        pc.addEventListener('icecandidate', (e) => {
          const t = e.candidate?.type
          if (t) info.cands.add(t)
        })
        pc.addEventListener('iceconnectionstatechange', () => (info.ice = pc.iceConnectionState))
        pc.addEventListener('connectionstatechange', () => (info.conn = pc.connectionState))
        pc.addEventListener('track', (e) => info.recv.add(e.track.kind))
        info.statTimer = window.setInterval(() => {
          // Self-clean: kibitz mints a fresh pc on every dial / re-dial / media-recovery, so without this the
          // intervals (and the pcs[] array) grow without bound over a session and pin every closed pc alive.
          // connectionstatechange does NOT fire for pc.close() (see the draw() filter), so detect close here.
          if (pc.connectionState === 'closed') {
            clearInterval(info.statTimer)
            const i = pcs.indexOf(info)
            if (i >= 0) pcs.splice(i, 1)
            return
          }
          if (!debugEnabled()) return // getStats only while the panel is visible; the listeners above always capture
          void pc
            .getStats()
            .then((stats) => {
              // SUM across ALL inbound video lanes (camera + screen-share + the placeholder transceiver). The old
              // last-write-wins showed a misleading 0f/0k whenever getStats happened to end on an idle lane (e.g. the
              // unused share lane), even while the camera lane was decoding fine. MH aggregates the same way.
              let frames = 0
              let bytes = 0
              let sawVideo = false
              let inboundBytes = 0 // across ALL inbound lanes (audio + video) → the sticky rxEver "media ever flowed" flag
              let audioCodec = ''
              let selPairId = ''
              const byId = new Map<string, Record<string, unknown>>()
              stats.forEach((r) => byId.set(String((r as { id?: string }).id ?? ''), r as unknown as Record<string, unknown>))
              stats.forEach((report) => {
                const r = report as { type?: string; kind?: string; mediaType?: string; framesDecoded?: number; bytesReceived?: number; codecId?: string; selectedCandidatePairId?: string }
                if (r.type === 'transport' && r.selectedCandidatePairId) selPairId = r.selectedCandidatePairId
                if (r.type === 'inbound-rtp') {
                  inboundBytes += r.bytesReceived ?? 0
                  if ((r.kind || r.mediaType) === 'video') {
                    sawVideo = true
                    frames += r.framesDecoded ?? 0
                    bytes += r.bytesReceived ?? 0
                  }
                  if ((r.kind || r.mediaType) === 'audio' && r.codecId) {
                    const c = byId.get(r.codecId) as { mimeType?: string } | undefined
                    if (c?.mimeType) audioCodec = c.mimeType.replace(/^audio\//i, '')
                  }
                }
              })
              // Selected ICE candidate pair → local/remote candidate TYPES (the path media actually takes). Prefer the
              // transport's selectedCandidatePairId (Safari); fall back to a nominated+succeeded pair (Chrome).
              let pair = selPairId ? (byId.get(selPairId) as { localCandidateId?: string; remoteCandidateId?: string } | undefined) : undefined
              if (!pair)
                stats.forEach((report) => {
                  const p = report as { type?: string; nominated?: boolean; state?: string }
                  if (!pair && p.type === 'candidate-pair' && p.nominated && p.state === 'succeeded') pair = report as unknown as { localCandidateId?: string; remoteCandidateId?: string }
                })
              if (pair) {
                const ab = (t?: string) => (t === 'host' ? 'h' : t === 'srflx' ? 's' : t === 'prflx' ? 'p' : t === 'relay' ? 'r' : t ? t[0] : '?')
                const lc = byId.get(String(pair.localCandidateId ?? '')) as { candidateType?: string; protocol?: string; relayProtocol?: string } | undefined
                const rc = byId.get(String(pair.remoteCandidateId ?? '')) as { candidateType?: string } | undefined
                info.pair = `${ab(lc?.candidateType)}/${ab(rc?.candidateType)}`
                // TRANSPORT of the local candidate — relayProtocol (client↔TURN: udp/tcp/tls) for a relay, else the
                // candidate's own protocol. The 4G-mobile smoking gun: a UDP path that connects (STUN passes) but
                // never carries inbound media = the carrier throttling UDP → the fix is TURN-over-TCP/TLS.
                info.tp = lc?.relayProtocol || lc?.protocol || '?'
              }
              if (audioCodec) info.codec = audioCodec
              if (inboundBytes > 0) info.rxEver = true // once true, stays true — distinguishes never-flowed from flowed-then-stalled
              if (sawVideo) info.vid = `${frames}f/${Math.round(bytes / 1024)}k`
            })
            .catch(() => {})
        }, 2000)
      } catch {
        /* ignore */
      }
      return pc
    } as unknown as typeof RTCPeerConnection
    Wrapped.prototype = OPC.prototype
    try {
      Object.setPrototypeOf(Wrapped, OPC)
    } catch {
      /* ignore */
    }
    window.RTCPeerConnection = Wrapped
  }

  // ── wrap WebSocket (capture the signaling broker connection) ──────────────────────────────────
  const OWS = window.WebSocket
  if (OWS) {
    const Wrapped = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      const s =
        protocols !== undefined
          ? new (OWS as unknown as { new (u: string | URL, p?: string | string[]): WebSocket })(url, protocols)
          : new (OWS as unknown as { new (u: string | URL): WebSocket })(url)
      const u = String(url)
      if (/peerjs|cloudflare|broker|signal|\/ws\b|0\.peerjs/i.test(u)) {
        logSignalEvent(`WS→ ${u.replace(/^wss?:\/\//, '').slice(0, 30)}`)
        try {
          s.addEventListener('open', () => logSignalEvent('WS open ✓'))
          s.addEventListener('close', (e) => logSignalEvent(`WS close ${e.code}`))
          s.addEventListener('error', () => logSignalEvent('WS error ✗'))
        } catch {
          /* ignore */
        }
      }
      return s
    } as unknown as typeof WebSocket
    Wrapped.prototype = OWS.prototype
    try {
      Object.setPrototypeOf(Wrapped, OWS)
    } catch {
      /* ignore */
    }
    window.WebSocket = Wrapped
  }

  // ── the on-screen panel (rendered only while the toggle is on; removed when off) ───────────────
  const draw = () => {
    const existing = document.getElementById('kbz-conn-debug')
    if (!debugEnabled()) {
      if (existing) existing.remove() // toggled OFF → hide (wrappers linger harmlessly until the next reload)
      document.getElementById('kbz-conn-copy')?.remove()
      return
    }
    let box = existing
    if (!box) {
      box = document.createElement('div')
      box.id = 'kbz-conn-debug'
      box.style.cssText =
        'position:fixed;left:4px;bottom:4px;z-index:2147483647;max-width:96vw;font:11px/1.35 ui-monospace,monospace;' +
        'background:rgba(0,0,0,.85);color:#1f1;padding:6px 8px;border-radius:6px;white-space:pre-wrap;pointer-events:none'
      ;(document.body || document.documentElement).appendChild(box)
      // GROUND-TRUTH dump. The overlay is lossy (and its mh line can lie). One tap gathers the FULL getStats per pc
      // — candidate pairs with byte counts, inbound/outbound RTP, DTLS/transport, connectionState AND iceConnectionState
      // — plus the mesh globals, into a SELECTABLE box (copy or screenshot; also best-effort clipboard). So a failing
      // call is diagnosed from real numbers, not a photo of a truncated readout. pointer-events:auto (the panel is not).
      const btn = document.createElement('button')
      btn.id = 'kbz-conn-copy'
      btn.textContent = '⧉ copy debug'
      btn.style.cssText =
        'position:fixed;right:6px;bottom:6px;z-index:2147483647;font:12px/1 ui-monospace,monospace;background:#0a0;' +
        'color:#000;font-weight:700;padding:8px 10px;border:0;border-radius:8px;pointer-events:auto'
      btn.onclick = () => {
        void (async () => {
          const g = window as unknown as Record<string, unknown>
          const dump: Record<string, unknown> = { at: new Date().toISOString(), ua: navigator.userAgent, api: apiLine, ws: getSignalLog().slice(0, 8), roster: g.__kbzRoster, heal: g.__kbzMeshHeal, mediaHealth: g.__kbzMediaHealth, pcs: [] as unknown[] }
          for (const p of pcs) {
            const keep: Record<string, unknown>[] = []
            try {
              const st = await p.pc.getStats()
              st.forEach((r) => {
                const t = (r as { type?: string }).type
                if (t && /candidate-pair|inbound-rtp|outbound-rtp|transport|local-candidate|remote-candidate/.test(t)) keep.push(r as Record<string, unknown>)
              })
            } catch {
              /* pc gone */
            }
            ;(dump.pcs as unknown[]).push({ conn: p.pc.connectionState, ice: p.pc.iceConnectionState, sig: p.pc.signalingState, pol: p.pol, cands: [...p.cands], stats: keep })
          }
          const text = JSON.stringify(dump, null, 1)
          try {
            await navigator.clipboard.writeText(text)
          } catch {
            /* iOS may block clipboard after await — the textarea below is the fallback */
          }
          document.getElementById('kbz-conn-dump')?.remove()
          const wrap = document.createElement('div')
          wrap.id = 'kbz-conn-dump'
          wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.92);display:flex;flex-direction:column;pointer-events:auto'
          const close = document.createElement('button')
          close.textContent = `✕ close  (${Math.round(text.length / 1024)}KB — select all + copy, or screenshot)`
          close.style.cssText = 'font:13px ui-monospace,monospace;background:#0a0;color:#000;font-weight:700;padding:10px;border:0'
          close.onclick = () => wrap.remove()
          const ta = document.createElement('textarea')
          ta.value = text
          ta.readOnly = true
          ta.style.cssText = 'flex:1;width:100%;background:#000;color:#1f1;font:10px/1.3 ui-monospace,monospace;border:0;padding:8px'
          wrap.appendChild(close)
          wrap.appendChild(ta)
          ;(document.body || document.documentElement).appendChild(wrap)
          ta.focus()
          ta.select()
        })()
      }
      ;(document.body || document.documentElement).appendChild(btn)
    }
    // Read connectionState LIVE: pc.close() flips it to 'closed' synchronously but fires NO connectionstatechange
    // event, so the cached `info.conn` never learns of a close — which made live==created always (the inflated
    // pcs:34/34). Polling the real state here drops closed re-dials/data pcs so the count reflects what's actually open.
    const live = pcs.filter((p) => p.pc.connectionState !== 'closed') // array accumulates every pc ever created; show LIVE
    const relay = live.some((p) => p.cands.has('relay'))
    // Per-<video> RENDER STATE — decoded WxH / shown WxH / paused / readyState / live-video-tracks-in-srcObject.
    // Rendered HIGH (right under RELAY) so iOS Safari's bottom toolbar can never hide it. Reads the failure mode:
    //   decoded>0 & shown>0 & p=0 & t>0 = frames present but NOT composited (iOS paint bug → remount/canvas)
    //   decoded 0x0 & t>0               = a live track is bound but no frames reach THIS element
    //   t=0                             = element bound to a stream with NO live video (wrong/empty stream → rebind)
    //   p=1                             = autoplay blocked (needs a gesture);  shown 0x0 = un-sized tile (layout)
    // The widget renders INSIDE a Shadow DOM (widget/index.tsx attachShadow), so a plain document query finds NO
    // <video>/<audio> even when tiles are mounted — walk shadow roots too. m=muted (speaker-off/deaf); p=paused
    // (autoplay-blocked → black AND silent); t=live tracks. This is the line that says whether the element HAS the
    // frames and is just not playing/painting, vs nothing bound.
    const media: HTMLMediaElement[] = []
    const walk = (root: Document | ShadowRoot) => {
      root.querySelectorAll<HTMLMediaElement>('video, audio').forEach((el) => media.push(el))
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) walk(el.shadowRoot)
      })
    }
    try {
      walk(document)
    } catch {
      /* ignore */
    }
    const vLines = media.slice(0, 5).map((v, i) => {
      const tag = v.tagName === 'AUDIO' ? 'a' : 'v'
      const ms = v.srcObject as MediaStream | null
      const vt = ms ? ms.getVideoTracks() : []
      const liveT = vt.filter((t) => t.readyState === 'live' && !t.muted).length
      const wh = v instanceof HTMLVideoElement ? `${v.videoWidth}x${v.videoHeight}/${v.clientWidth}x${v.clientHeight}` : '—'
      return `${tag}${i}: ${wh} p=${v.paused ? 1 : 0} m=${v.muted ? 1 : 0} rs=${v.readyState} t=${liveT}/${vt.length}`
    })
    // Roster vs reality — per participant: cam FLAG / stream-bound / live video tracks / live audio tracks. The tile
    // gates video on the cam FLAG (not track presence), so `cam=0 v=1` = a black tile while real video decodes (lost
    // flag); `s=0` = no stream bound at all. Published by the Widget into __kbzRoster.
    const roster = (window as unknown as { __kbzRoster?: Array<{ n: string; self: boolean; cam: boolean; s: boolean; v: number; a: number }> }).__kbzRoster
    const rosterLines = (roster ?? []).map((r) => `${r.self ? 'self' : 'peer'} ${r.n}: cam=${r.cam ? 1 : 0} s=${r.s ? 1 : 0} v=${r.v} a=${r.a}`)
    // Media-recovery handshake (published by mesh.ts). Per peer: m-recreate SENT↑ (initiator), m-recreate RECV↓
    // (answerer), rebuilds. Compare the two devices: initiator ↑≥1 but answerer ↓0 ⇒ the heal signal was LOST on the
    // link (a broker/retry fix will help). Both ↓≥1 + rebuilt but rx=∅ everywhere ⇒ RTP never flowed (a transport
    // block a handshake fix won't touch). This is the line that separates the two failure modes.
    const heal = (window as unknown as { __kbzMeshHeal?: Record<string, { s: number; r: number; rb: number }> }).__kbzMeshHeal
    const healLines = Object.entries(heal ?? {}).map(([id, h]) => `heal ${id}: mR↑${h.s} mR↓${h.r} rb${h.rb}`)
    const lines = [
      apiLine,
      `RELAY cand: ${relay ? 'YES ✓' : 'NO ✗'}   pcs:${live.length}/${pcs.length}`, // live / created-this-session
      ...rosterLines,
      ...healLines,
      ...vLines,
      ...getSignalLog().slice(0, 3),
      ...live
        .slice(-3)
        .map(
          (p, i) =>
            `pc${live.length - Math.min(3, live.length) + i}: ${p.pol} [${[...p.cands].join(',') || '—'}] ice=${p.ice} rx=[${[...p.recv].join(',') || '—'}] ever=${p.rxEver ? '✓' : '∅'} pair=${p.pair}/${p.tp} codec=${p.codec} vid=${p.vid}`,
        ),
    ]
    // Media-health (control plane): per peer, our INBOUND rate (in) + the peer's reported inbound (out = our
    // outbound landing there). A half-open shows as in v0/a0 (we receive nothing) or out v0/a0 (they do).
    const mh = (window as unknown as { __kbzMediaHealth?: Record<string, { rxV: number; rxA: number; peerV: number; peerA: number }> }).__kbzMediaHealth
    if (mh) {
      for (const [id, h] of Object.entries(mh)) {
        lines.push(`MH ${id.slice(0, 6)}: in v${h.rxV}/a${h.rxA}${h.rxV + h.rxA === 0 ? ' ✗' : ''} out v${h.peerV}/a${h.peerA}`)
      }
    }
    box.textContent = lines.join('\n')
  }
  drawFn = draw
  const boot = () => {
    if (debugEnabled()) startDrawLoop() // a persisted-on panel appears; otherwise no loop runs until toggled
  }
  if (document.body) boot()
  else window.addEventListener('DOMContentLoaded', boot)
}

/** The cheat: 5 quick taps in the BOTTOM-LEFT corner toggles the overlay and persists it across reloads. Always
 *  installed (a single passive listener); the heavy wrapping only happens once you actually turn it on. */
export function installDebugToggle(): void {
  if (typeof window === 'undefined') return
  let taps = 0
  let last = 0
  const onTap = (e: PointerEvent) => {
    if (!(e.clientX < 80 && e.clientY > window.innerHeight - 120)) return // bottom-left corner only
    const now = Date.now()
    if (now - last > 1500) taps = 0 // too slow → restart the count
    last = now
    if (++taps < 5) return
    taps = 0
    const on = !debugEnabled()
    setDebugEnabled(on)
    if (on) {
      installConnDebug() // ensure the capture wrapper is installed (no-op if already)
      startDrawLoop() // begin the 1 Hz redraw → the panel appears
    } else {
      stopDrawLoop() // stop redrawing + one final pass removes the panel DOM
    }
    toast(on ? '🐛 debug ON' : 'debug OFF')
  }
  window.addEventListener('pointerdown', onTap, { capture: true, passive: true })
}

function toast(msg: string): void {
  try {
    const t = document.createElement('div')
    t.textContent = msg
    t.style.cssText =
      'position:fixed;left:50%;top:12%;transform:translateX(-50%);z-index:2147483647;background:rgba(0,0,0,.85);' +
      'color:#1f1;font:13px/1 ui-monospace,monospace;padding:8px 12px;border-radius:8px;pointer-events:none'
    ;(document.body || document.documentElement).appendChild(t)
    setTimeout(() => t.remove(), 1400)
  } catch {
    /* ignore */
  }
}
