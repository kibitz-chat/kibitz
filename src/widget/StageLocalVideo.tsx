import { useEffect, useRef, type RefObject } from 'react'

// A staged shared VIDEO rendered from THIS peer's OWN local copy (the "send-the-state" model — full quality, no
// WebRTC re-encode). A native <video controls> (the OS player). Two roles, one component:
//
//  • AUTHORITY — the peer that staged it. The MASTER: its native controls drive the element directly; every
//    transport change is broadcast (onBroadcast → the parent's broadcastStageState) so followers track it; an
//    incoming follower command is applied to THIS element by the parent (via videoRef, the existing stagecmd path).
//    On first frame it captures a low-fps POSTER onto the share lane (onPoster) — that keeps it the "presenter" so
//    everyone's stage layout lights up, and gives a peer that lacks the file a cheap preview.
//  • FOLLOWER — everyone else. Applies the authority's broadcast (xport) to its OWN local element (play/pause +
//    drift-seek), and relays its OWN native control actions back to the authority (onCmd). Echo-guarded so applying
//    a remote update never re-broadcasts as if the user did it.
//
// Volume + fullscreen are the NATIVE controls → per-person (each peer its own), which is the nicer behaviour.
//
// Follower sync tuning. The broadcast `time` is a snapshot ALREADY stale by the transit latency (worse + jittery
// over a TURN relay), so a tight hard-seek threshold makes the follower chase jitter and STUTTER ("periodically
// stuck"). Hard-seek only a REAL desync (a scrub, a long stall, a fresh join); converge medium drift smoothly with
// playbackRate (no jump); leave sub-nudge drift alone (imperceptible on a call).
const DRIFT_SEEK_S = 2 // |drift| beyond this → a visible catch-up seek
const DRIFT_NUDGE_S = 0.5 // |drift| in (this, SEEK) while playing → gentle playbackRate correction, no seek
export function StageLocalVideo({
  src,
  role,
  deaf,
  videoRef,
  xport,
  onPoster,
  onBroadcast,
  onCmd,
}: {
  src: string
  role: 'authority' | 'follower'
  deaf: boolean
  /** The element ref the parent owns (imgElRef for the authority, so its existing stagecmd handler can drive it). */
  videoRef: RefObject<HTMLVideoElement | null>
  /** The authority's last broadcast transport — followers follow it; the authority ignores it. */
  xport: { playing: boolean; time: number; dur: number } | null
  /** AUTHORITY: capture + share the low-fps poster (fired on first canplay). */
  onPoster?: () => void
  /** AUTHORITY: a transport change to broadcast to followers. */
  onBroadcast?: (s: { playing: boolean; time: number; dur: number }) => void
  /** FOLLOWER: relay a control action to the authority (who applies it + re-broadcasts). */
  onCmd?: (cmd: { cmd: 'play' | 'pause' | 'seek'; time?: number }) => void
}) {
  // True while we're applying the authority's broadcast to our element — so the resulting native play/pause/seeked
  // events don't bounce back as a relay (the echo guard). Released on the next tick after the events settle.
  const applyingRemote = useRef(false)
  const lastAppliedTime = useRef(-1) // target of our last drift-correction seek — so onSeeked doesn't echo it back

  // Speaker-off mutes OUR local playback (the share is a silent poster; sound is each peer's local element).
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = deaf
  }, [deaf, videoRef, src])

  // FOLLOWER: track the authority's broadcast WITHOUT stuttering on a stale/jittery snapshot.
  useEffect(() => {
    if (role !== 'follower' || !xport) return
    const v = videoRef.current
    if (!v) return
    applyingRemote.current = true
    try {
      // Play/pause first (cheap, no stutter).
      if (xport.playing && v.paused) void v.play().catch(() => {})
      else if (!xport.playing && !v.paused) v.pause()
      // Time: the broadcast is a snapshot already stale by transit latency — DON'T chase it tick-by-tick.
      const cur = v.currentTime || 0
      const target = Number.isFinite(xport.time) ? Math.max(0, xport.time) : cur
      const drift = cur - target // >0 = ahead of the (stale) authority snapshot
      if (Math.abs(drift) > DRIFT_SEEK_S) {
        lastAppliedTime.current = target // a genuine desync (scrub / stall / fresh join) → take the visible jump
        v.currentTime = target
        if (v.playbackRate !== 1) v.playbackRate = 1
      } else if (xport.playing && Math.abs(drift) > DRIFT_NUDGE_S) {
        v.playbackRate = drift < 0 ? 1.05 : 0.95 // behind → a touch faster, ahead → slower: smooth catch-up, no jump
      } else if (v.playbackRate !== 1) {
        v.playbackRate = 1 // back in the pocket
      }
    } finally {
      setTimeout(() => {
        applyingRemote.current = false
      }, 0)
    }
  }, [role, xport, videoRef])

  const broadcast = (v: HTMLVideoElement) => onBroadcast?.({ playing: !v.paused, time: v.currentTime || 0, dur: v.duration || 0 })
  const relay = (cmd: { cmd: 'play' | 'pause' | 'seek'; time?: number }) => {
    if (role !== 'follower' || applyingRemote.current) return
    onCmd?.(cmd)
  }

  return (
    <video
      key={src}
      ref={videoRef}
      src={src}
      controls
      playsInline
      onCanPlay={role === 'authority' ? () => onPoster?.() : undefined}
      onLoadedMetadata={(e) => role === 'authority' && broadcast(e.currentTarget as HTMLVideoElement)}
      onTimeUpdate={(e) => role === 'authority' && broadcast(e.currentTarget as HTMLVideoElement)}
      onPlay={(e) => (role === 'authority' ? broadcast(e.currentTarget as HTMLVideoElement) : relay({ cmd: 'play' }))}
      onPause={(e) => (role === 'authority' ? broadcast(e.currentTarget as HTMLVideoElement) : relay({ cmd: 'pause' }))}
      onSeeked={(e) => {
        if (role !== 'follower') return
        const t = (e.currentTarget as HTMLVideoElement).currentTime || 0
        // Don't echo OUR OWN drift-correction seek back to the authority — applyingRemote can lag the async
        // `seeked` event, so also skip when this landed on the time we just applied. A user scrub relays normally.
        if (Math.abs(t - lastAppliedTime.current) < 0.3) return
        relay({ cmd: 'seek', time: t })
      }}
    />
  )
}
