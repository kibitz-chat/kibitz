import { useCallback, useEffect, useRef, useState } from 'react'
import { useActiveSpeakers } from './useActiveSpeakers'
import type { ConnInfo } from '../core/connStats'
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

function useStream(stream: MediaStream | null, onBlocked: () => void, muted = false, volume = 1, sinkId = '') {
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

  // Apply mute-for-me / volume / output-device changes to the live element without re-attaching.
  useEffect(() => {
    if (elRef.current) elRef.current.muted = muted
  }, [muted])
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
  const hasVideo = p.cam && !!p.stream && p.stream.getVideoTracks().some((t) => t.readyState === 'live')
  // Self is always muted (no echo); a remote tile is muted when the speaker is off (deaf).
  const ref = useStream(p.stream, onBlocked, p.isSelf || !!muted, 1, sinkId)
  const initial = (p.name || '?').charAt(0).toUpperCase()
  const isHost = !!hostId && p.id === hostId
  return (
    <div className={`tile${p.isSelf ? ' self' : ''}${speaking ? ' speaking' : ''}${stage ? ' stage' : ''}`}>
      {hasVideo ? (
        // Mirror only the front camera — a mirrored rear camera reads backwards.
        <video ref={ref} autoPlay playsInline className={p.mirror === false ? 'no-mirror' : ''} />
      ) : (
        <>
          <div className="face" aria-hidden="true">
            <EmojiAvatar value={p.avatar || initial} />
          </div>
          {/* Voice-only: a hidden audio sink plays their sound (never your own). */}
          {!p.isSelf && p.stream && <audio ref={ref} autoPlay />}
        </>
      )}
      {p.isSelf && hasVideo && onFlip && (
        <button className="tile-flip" onClick={onFlip} title="Switch camera" aria-label="Switch camera">
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
            aria-label="AI agent"
          >
            🤖 AI
          </span>
        )}
        {verifiedId && (
          <span className="tag-id" title={`Verified identity: ${verifiedId}`} aria-label={`Verified as ${verifiedId}`}>
            ✓
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
