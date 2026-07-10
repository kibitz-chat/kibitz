import { useCallback, useEffect, useRef, useState } from 'react'
import { useActiveSpeakers } from './useActiveSpeakers'
import type { ConnInfo } from '../core/connStats'
import { readClaim, claimLabel } from '../core/claim'
import { wt } from './i18n'
import type { CallController, CallParticipant } from './useCall'
import { TWEMOJI_AVATARS } from './twemojiAvatars'

/**
 * Render an avatar value CONSISTENTLY across devices. A picked emoji renders as its vendored Twemoji SVG
 * (Apple/Google/Windows emoji fonts otherwise look different on each screen); a name-initial letter (or any
 * emoji we didn't bundle) renders as plain text — unchanged. The SVG is trusted, build-vendored markup
 * (scripts/gen-twemoji-avatars.mjs), sized to 1em so it scales with the surrounding font-size.
 */
export function EmojiAvatar({ value }: { value: string }) {
  const svg = TWEMOJI_AVATARS[value]
  if (svg) return <span className="kw-emoji" role="img" aria-label="avatar" dangerouslySetInnerHTML={{ __html: svg }} />
  return <>{value}</>
}

// "Doing X" labels for the busy tile (a peer sets meta.activity alongside meta.busy — e.g. an AI agent while
// it reasons + runs tools). The VISUAL is a StateGlyph (waveform/spinner/dot — below), not an emoji; this just
// maps the activity key → a brand-neutral English word. Unknown keys fall back to "thinking".
const ACTIVITY: Record<string, { label: string }> = {
  listening: { label: 'listening' },
  thinking: { label: 'thinking' },
  searching: { label: 'searching' },
  reading: { label: 'reading' },
  calculating: { label: 'calculating' },
  composing: { label: 'composing' },
  singing: { label: 'singing' }, // PLAYING a finished song (distinct from 'composing', which is making it)
  remembering: { label: 'remembering' },
  locating: { label: 'locating' },
  checking: { label: 'checking' },
  working: { label: 'working' },
}

const EQ_BARS = 4

// The listening waveform, driven by a LIVE mic analyser so the agent visibly reacts to the room's voice (the local
// mic — "it hears me when I talk"). Direct DOM writes in rAF, no per-frame React (same pattern as MicWave). No
// stream / muted ⇒ falls back to the idle CSS pulse (.kw-eq without --live).
function ListenWave({ stream }: { stream: MediaStream | null }) {
  const bars = useRef<(HTMLElement | null)[]>([])
  const live = !!stream && stream.getAudioTracks().length > 0
  useEffect(() => {
    if (!live || !stream) return
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    let source: MediaStreamAudioSourceNode
    try {
      source = ctx.createMediaStreamSource(stream)
    } catch {
      void ctx.close().catch(() => {})
      return
    }
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 128
    source.connect(analyser)
    const data = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
    const onVis = () => {
      if (document.visibilityState === 'hidden') void ctx.suspend().catch(() => {})
      else void ctx.resume().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVis)
    let raf = requestAnimationFrame(function loop() {
      analyser.getByteFrequencyData(data)
      for (let i = 0; i < EQ_BARS; i++) {
        const lo = 1 + Math.floor((i / EQ_BARS) * 20)
        const hi = 1 + Math.floor(((i + 1) / EQ_BARS) * 20)
        let sum = 0
        for (let j = lo; j < hi; j++) sum += data[j]
        const level = sum / Math.max(1, hi - lo) / 255
        const bar = bars.current[i]
        if (bar) bar.style.transform = `scaleY(${Math.max(0.18, Math.min(1, level * 1.9)).toFixed(3)})`
      }
      raf = requestAnimationFrame(loop)
    })
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
      try {
        source.disconnect()
      } catch {
        /* ignore */
      }
      void ctx.close().catch(() => {})
    }
  }, [stream, live])
  return (
    <span className={`kw-eq${live ? ' kw-eq--live' : ''}`} aria-hidden="true">
      {Array.from({ length: EQ_BARS }, (_, i) => (
        <i
          key={i}
          ref={(el) => {
            bars.current[i] = el
          }}
        />
      ))}
    </span>
  )
}

// Clean agent-state visuals (replaces the 👂 / 💭 / ⚙️ emoji): listening → a cyan WAVEFORM (ListenWave, a live mic
// meter when a local stream is supplied, else an idle pulse); any working/thinking state → a thin amber SPINNER;
// dormant → a dim still DOT. Colour + motion carry the state; the label says which.
function StateGlyph({ kind, stream }: { kind: 'listening' | 'working' | 'dormant'; stream?: MediaStream | null }) {
  if (kind === 'listening') return <ListenWave stream={stream ?? null} />
  if (kind === 'dormant') return <span className="kw-statedot" aria-hidden="true" />
  return <span className="kw-spin2" aria-hidden="true" />
}

/**
 * Attach a participant's MediaStream to a media element via a CALLBACK ref — not a
 * stream-keyed effect. Camera toggles mutate the stream object IN PLACE (its
 * reference never changes), so the avatar→<video> swap mounts a fresh element that
 * a stream-keyed effect would never re-bind (blank self-view). The callback ref
 * fires on mount regardless; the effect covers streams that arrive later.
 */
// setSinkId routes playback to a chosen output device — desktop Chromium only; a no-op (and absent)
// elsewhere. Best-effort: never throw if unsupported or the id is stale.
const applySink = (el: HTMLMediaElement, sinkId: string) => {
  const withSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }
  if (typeof withSink.setSinkId === 'function') withSink.setSinkId(sinkId || '').catch(() => {})
}

function useStream(stream: MediaStream | null, onBlocked: () => void, muted = false, volume = 1, sinkId = '', isSelf = false) {
  const elRef = useRef<HTMLMediaElement | null>(null)
  const streamRef = useRef<MediaStream | null>(stream)
  streamRef.current = stream
  const onBlockedRef = useRef(onBlocked)
  onBlockedRef.current = onBlocked
  // useStream OWNS el.muted / el.volume (set imperatively, not via JSX — React's
  // `muted` prop is famously unreliable on media elements). Self is always muted to
  // avoid echo; a remote tile is muted when the speaker is off (deaf).
  const mutedRef = useRef(muted)
  mutedRef.current = muted
  // Remote-only belt-and-suspenders for speaker-off: Android Chrome ignores el.muted for a WebRTC srcObject in
  // some builds (works on iOS/desktop → the "speaker-off does nothing on Samsung" bug), so we ALSO disable the
  // received AUDIO tracks. That silences playback locally without touching the sender. NEVER for self — self's
  // tracks are the live mic; disabling them would cut our own audio to everyone. Self keeps el.muted alone (echo).
  const isSelfRef = useRef(isSelf)
  isSelfRef.current = isSelf
  const volRef = useRef(volume)
  volRef.current = volume
  const sinkRef = useRef(sinkId)
  sinkRef.current = sinkId

  const attach = useCallback((el: HTMLMediaElement | null, s: MediaStream | null) => {
    if (!el) return
    el.muted = mutedRef.current
    el.volume = Math.min(1, Math.max(0, volRef.current))
    if (sinkRef.current) applySink(el, sinkRef.current)
    if (!s) return
    if (el.srcObject !== s) el.srcObject = s
    if (!isSelfRef.current) s.getAudioTracks().forEach((t) => { t.enabled = !mutedRef.current })
    if (el.paused) {
      const p = el.play()
      // iOS/Safari can refuse to autoplay remote audio until a user gesture.
      if (p && typeof p.catch === 'function') p.catch(() => onBlockedRef.current())
    }
  }, [])

  const setRef = useCallback(
    (node: HTMLMediaElement | null) => {
      elRef.current = node
      attach(node, streamRef.current)
    },
    [attach],
  )

  useEffect(() => {
    attach(elRef.current, stream)
  }, [stream, attach])

  // iOS WebKit paint fix: a remote video track that ARRIVES or UNMUTES *after* the <video> already bound its
  // stream decodes (frames count up in getStats) but often isn't PAINTED — the element shows black/avatar while
  // 196 frames decode behind it. Re-assigning srcObject + replaying when a video track unmutes (or is added)
  // forces WebKit to composite the frames. Desktop is unaffected (the track is present + unmuted at bind time).
  useEffect(() => {
    const el = elRef.current
    if (!el || !stream) return
    const repaint = () => {
      try {
        el.srcObject = null
        el.srcObject = stream
      } catch {
        /* ignore */
      }
      // iOS compositing kick: promote to a GPU layer + force a reflow so WebKit re-composites a video that's
      // decoding but not painting (the srcObject re-attach alone wasn't enough on a real iPhone).
      try {
        el.style.transform = 'translateZ(0)'
        void el.offsetHeight
      } catch {
        /* ignore */
      }
      if (el.paused) el.play().catch(() => onBlockedRef.current())
    }
    const watched: MediaStreamTrack[] = []
    const watch = (t: MediaStreamTrack) => {
      watched.push(t)
      t.addEventListener('unmute', repaint)
      if (!t.muted) repaint() // already flowing → poke now (the track arrived before we wired up)
    }
    stream.getVideoTracks().forEach(watch)
    const onAdd = (e: MediaStreamTrackEvent) => {
      if (e.track.kind === 'video') watch(e.track)
    }
    stream.addEventListener('addtrack', onAdd)
    return () => {
      stream.removeEventListener('addtrack', onAdd)
      watched.forEach((t) => t.removeEventListener('unmute', repaint))
    }
  }, [stream])

  // Apply mute-for-me / volume / output-device changes to the live element without re-attaching.
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    el.muted = muted
    const s = el.srcObject as MediaStream | null
    if (s && !isSelf) s.getAudioTracks().forEach((t) => { t.enabled = !muted }) // remote-only; never gate the mic
  }, [muted, isSelf])
  useEffect(() => {
    if (elRef.current) elRef.current.volume = Math.min(1, Math.max(0, volume))
  }, [volume])
  useEffect(() => {
    if (elRef.current) applySink(elRef.current, sinkId)
  }, [sinkId])

  return setRef
}

const WAVE_BARS = 5

/** Live mic-level bars on your own tile (direct DOM in rAF — no per-frame React). */
function MicWave({ stream, active }: { stream: MediaStream | null; active: boolean }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  useEffect(() => {
    // Only run the meter while the mic is ON — no point analysing a muted/disabled track, and an
    // idle analyser keeps iOS's audio engine awake (a contributor to the app-switch click).
    if (!active || !stream || stream.getAudioTracks().length === 0) return
    const AC =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    let source: MediaStreamAudioSourceNode
    try {
      source = ctx.createMediaStreamSource(stream)
    } catch {
      void ctx.close().catch(() => {})
      return
    }
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 128
    source.connect(analyser)
    const data = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
    // Suspend this (visual-only) context while the app is backgrounded; resume when visible — less
    // for iOS to re-activate on a gesture (a try at shaving the standalone drag click).
    const onVis = () => {
      if (document.visibilityState === 'hidden') void ctx.suspend().catch(() => {})
      else void ctx.resume().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVis)
    let raf = requestAnimationFrame(function loop() {
      analyser.getByteFrequencyData(data)
      for (let i = 0; i < WAVE_BARS; i++) {
        const lo = 1 + Math.floor((i / WAVE_BARS) * 20)
        const hi = 1 + Math.floor(((i + 1) / WAVE_BARS) * 20)
        let sum = 0
        for (let j = lo; j < hi; j++) sum += data[j]
        const level = sum / Math.max(1, hi - lo) / 255
        const h = Math.max(0.14, Math.min(1, level * 1.8))
        const bar = bars.current[i]
        if (bar) bar.style.transform = `scaleY(${h.toFixed(3)})`
      }
      raf = requestAnimationFrame(loop)
    })
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
      try {
        source.disconnect()
      } catch {
        /* ignore */
      }
      void ctx.close().catch(() => {})
    }
  }, [stream, active])

  if (!stream || stream.getAudioTracks().length === 0) return null
  return (
    <div className={`mic-wave${active ? ' on' : ''}`} aria-hidden="true">
      {Array.from({ length: WAVE_BARS }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el
          }}
        />
      ))}
    </div>
  )
}

export function Tile({
  p,
  speaking,
  micOn,
  localStream,
  onBlocked,
  onFlip,
  stage,
  hostId,
  muted,
  onRemove,
  conn,
  verifiedId,
  sinkId,
}: {
  p: CallParticipant
  speaking: boolean
  micOn: boolean
  /** The local mic stream — drives the agent's listening waveform (it reacts to YOUR voice). */
  localStream?: MediaStream | null
  onBlocked: () => void
  /** Self tile only: switch front/rear camera (shown while the camera is on). */
  onFlip?: () => void
  /** Render as the big "stage" (a presenter's screen): the video is letterboxed
   *  (object-fit: contain) instead of cropped, so a shared tab is fully visible. */
  stage?: boolean
  /** The host's media id — this tile shows a "host" chip when it matches. */
  hostId?: string
  /** Remote only: their audio is silenced for you because the speaker is off (deaf). */
  muted?: boolean
  /** Remote only, host only: remove this person from the room. */
  onRemove?: () => void
  /** Remote only: connection diagnostic (direct/relay + RTT + loss) — a small badge. */
  conn?: ConnInfo | null
  /** Verified identity (opt-in L3): the email this person proved, or undefined. Shown
   *  as a ✓ next to their name — a SEPARATE guarantee from the 🛡️ safety code. */
  verifiedId?: string
  /** Audio OUTPUT device id ('' = default) — routes this tile's playback (desktop Chromium). */
  sinkId?: string
}) {
  // Gate on the roster's cam flag, NOT track presence: every connection carries a
  // video lane permanently (a black placeholder while the camera is off) — the flag
  // says whether the lane currently holds a real camera.
  // The share now rides its OWN lane (the stage renders it), so a presenter's filmstrip tile shows their real
  // CAMERA (or avatar when the camera's off) — driven purely by the roster `cam` flag, like any other tile.
  // The track-presence check that used to be appended here (`getVideoTracks().some(live)`) broke iOS: the inbound
  // video track arrives AFTER the stream object and is added to it IN PLACE (same reference), so React never
  // re-renders and the tile stayed on the avatar with the real video decoding behind it (confirmed on-device:
  // pc inbound video frames climbing while the tile showed the initial). Gate on cam alone — per the rule above —
  // so the <video> binds early and paints the track the instant it lands; the video element tracks srcObject live.
  const hasVideo = p.cam && !!p.stream
  // Self is always muted (no echo); a remote tile is muted when the speaker is off (deaf).
  const ref = useStream(p.stream, onBlocked, p.isSelf || !!muted, 1, sinkId, p.isSelf)
  const initial = (p.name || '?').charAt(0).toUpperCase()
  const isHost = !!hostId && p.id === hostId
  // While busy, show WHAT it's doing (meta.activity) as a small pill by the ring. DEBOUNCE the CLEAR: hold the last
  // busy emoji ~600ms when meta.busy drops, so a transient false during a transition (listening→working, or the gap
  // before a song plays) doesn't flash the 1× avatar between two 1.5× emojis. A busy→busy change reflects at once.
  const rawBusyKey = p.meta?.busy ? String(p.meta?.activity || 'thinking') : null
  const [busyKey, setBusyKey] = useState(rawBusyKey)
  useEffect(() => {
    if (rawBusyKey !== null) {
      setBusyKey(rawBusyKey)
      return
    }
    const t = setTimeout(() => setBusyKey(null), 600)
    return () => clearTimeout(t)
  }, [rawBusyKey])
  const activity = busyKey ? ACTIVITY[busyKey] || ACTIVITY.thinking : null
  // The OPEN follow-up window (meta.activity 'listening') is the agent WAITING FOR YOU, not working — give it a
  // distinct cyan "your turn" glow (the `.awaiting` class, styled in CSS) so it never reads like amber "thinking".
  const awaiting = busyKey === 'listening'
  // Agent tiles get an explicit engagement lamp: 💤 DORMANT (just listening for a hand-off cue) when idle —
  // the 👂 'listening' (cyan awaiting glow) + 💭 'thinking' states already cover engaged/working.
  const isAgent = p.meta?.kind === 'voice-assistant' || p.meta?.role === 'agent'
  // A CLAIMED (unverified) identity — shown only when there's no verified ✓ (proof wins). Rendered as a
  // deliberately weaker marker than .tag-id so a claim can never read as the verified ✓.
  const claim = verifiedId ? null : readClaim(p.meta)
  return (
    <div className={`tile${p.isSelf ? ' self' : ''}${speaking ? ' speaking' : ''}${busyKey ? ' busy' : ''}${awaiting ? ' awaiting' : ''}${stage ? ' stage' : ''}${p.meta?.tileFit === 'contain' || p.meta?.role === 'agent' ? ' tile--fit' : ''}`}>
      {/* A VIDEO tile keeps the status as a corner pill (the center is the video). A voice-only tile shows
          it as the centerpiece instead (below), where the stage menu can't bury it. */}
      {activity && hasVideo && (
        <span className="tile-activity" aria-label={wt(activity.label)}>
          <StateGlyph kind={awaiting ? 'listening' : 'working'} stream={localStream} /> {wt(activity.label)}
        </span>
      )}
      {/* Engagement lamp: a dormant agent (idle, listening for a hand-off cue) shows 💤 so its state is
          never ambiguous. Hidden the moment it engages (then the 👂/💭 indicators take over). */}
      {isAgent && !busyKey && (
        <span className="tile-zzz" title="Dormant — say a hand-off cue (e.g. “go ahead, friend”) or tap to wake">
          <StateGlyph kind="dormant" />
        </span>
      )}
      {hasVideo ? (
        // Mirror only the front camera — a mirrored rear camera reads backwards.
        <video ref={ref} autoPlay playsInline className={p.mirror === false ? 'no-mirror' : ''} />
      ) : (
        <>
          <div className="face" aria-hidden="true">
            {activity ? (
              // Busy (voice-only): the ACTIVITY emoji takes the avatar's place — animated, with the label
              // beneath — so "thinking / composing / …" is the clear centerpiece, never covered by the
              // stage action-menu the way the top-left pill was.
              <span className="tile-busy">
                <span className="tile-busy-emoji">
                  <StateGlyph kind={awaiting ? 'listening' : 'working'} stream={localStream} />
                </span>
                <span className="tile-busy-label">{wt(activity.label)}</span>
              </span>
            ) : (
              <EmojiAvatar value={p.avatar || initial} />
            )}
          </div>
          {/* Voice-only: a hidden audio sink plays their sound (never your own). */}
          {!p.isSelf && p.stream && <audio ref={ref} autoPlay />}
        </>
      )}
      {p.isSelf && hasVideo && onFlip && (
        <button className="tile-flip" onClick={onFlip} title={wt('Switch camera')} aria-label={wt('Switch camera')}>
          🔄
        </button>
      )}
      {onRemove && (
        <button
          className="tile-remove"
          onClick={onRemove}
          title={`Remove ${p.name || 'them'} from the room`}
          aria-label={`Remove ${p.name || 'them'} from the room`}
        >
          🚫
        </button>
      )}
      {p.isSelf && <MicWave stream={p.stream} active={micOn} />}
      <span className="tag">
        {p.name}
        {p.meta?.role === 'agent' && (
          <span
            className="tag-agent"
            title="An AI agent — it perceives the room; read-only unless the host grants it more"
            aria-label={wt('AI agent')}
          >
            🤖 AI
          </span>
        )}
        {verifiedId && (
          <span className="tag-id" title={`Verified identity: ${verifiedId}`} aria-label={`Verified as ${verifiedId}`}>
            ✓
          </span>
        )}
        {claim?.kind === 'email' && (
          <span className="tag-claim" title={claimLabel(claim)} aria-label={claimLabel(claim)}>
            ~{claim.email}
          </span>
        )}
        {claim?.kind === 'guest' && (
          <span className="tag-claim guest" title="Joined as a guest" aria-label="Guest">
            guest
          </span>
        )}
        {isHost && <span className="tag-host"> · host</span>}
        {conn?.kind && (
          <span
            className={`tag-conn ${conn.kind}`}
            title={`${
              conn.kind === 'relay'
                ? "Relayed via a TURN server (a direct link wasn't possible on this network)"
                : 'Direct peer-to-peer — no server carries the media'
            }${conn.rttMs != null ? ` · ${conn.rttMs} ms` : ''}${conn.lossPct != null ? ` · ${conn.lossPct}% loss` : ''}`}
            aria-label={conn.kind === 'relay' ? 'Relayed connection' : 'Direct connection'}
          >
            ●
          </span>
        )}
      </span>
    </div>
  )
}

export function CallSurface({ call }: { call: CallController }) {
  const speaking = useActiveSpeakers(call.participants)
  const [needUnlock, setNeedUnlock] = useState(false)
  const onBlocked = useCallback(() => setNeedUnlock(true), [])
  // Scope the unlock to OUR subtree (works inside a shadow root, where
  // document.querySelectorAll cannot see — the widget renders in one).
  const rootRef = useRef<HTMLDivElement | null>(null)
  const unlock = useCallback(() => {
    rootRef.current?.querySelectorAll<HTMLMediaElement>('video, audio').forEach((el) => {
      el.play().catch(() => {})
    })
    setNeedUnlock(false)
  }, [])

  return (
    <div className="call" ref={rootRef}>
      <div className="grid">
        {call.participants.map((p) => (
          <Tile
            key={p.id}
            p={p}
            speaking={speaking.has(p.id)}
            micOn={call.micOn}
            localStream={call.participants.find((x) => x.isSelf)?.stream ?? null}
            onBlocked={onBlocked}
            onFlip={p.isSelf && call.canFlip ? () => void call.flipCam() : undefined}
          />
        ))}
      </div>
      {needUnlock && (
        <button className="unlock" onClick={unlock}>
          🔊 Tap to enable sound
        </button>
      )}
      {/* iOS released the mic/camera on a background — a tappable revive (the tap is the gesture getUserMedia
          needs). Always hidden off iOS / when nothing needs reviving. */}
      {call.needsMediaGesture && (
        <button className="unlock" onClick={() => call.resumeMedia()}>
          ↺ Tap to resume {[call.micOn && 'mic', call.camOn && 'camera'].filter(Boolean).join(' & ') || 'mic & camera'}
        </button>
      )}
      {call.error && <p className="error">{call.error}</p>}
      <div className="controls">
        <button className={call.micOn ? '' : 'off'} onClick={() => void call.toggleMic()}>
          {call.micOn ? '🎙 Mute' : '🔇 Unmute'}
        </button>
        <button className={call.camOn ? '' : 'off'} onClick={() => void call.toggleCam()}>
          {call.camOn ? '📷 Camera off' : '📷 Camera on'}
        </button>
        <button className="leave" onClick={call.leave}>
          ✕ Leave
        </button>
      </div>
    </div>
  )
}
