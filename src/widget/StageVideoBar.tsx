import { useEffect, useState, type RefObject } from 'react'

// A custom, SYNCED transport bar for a staged video — identical for every participant (no presenter-only
// permission). The presenter holds the real <video> (the master): this bar reads it and drives it directly. A
// viewer only has the live captured STREAM (a MediaStream has no seekable timeline, so the browser's native bar
// shows no scrub) — so a viewer's bar reads the presenter's broadcast transport and RELAYS play/pause/seek/offstage
// to the master, who applies it → the stream reflects it → everyone stays in sync. Gives play/pause AND scrub to
// ALL. The red ⏹ Stop is a two-tap confirm, pinned top-left of the stage. Global kw- classes (themed in widget.css).

const fmt = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  return `${m}:${ss < 10 ? '0' : ''}${ss}`
}

export function StageVideoBar({
  videoRef,
  xport,
  inkSlotRef,
  onStop,
  onPlayPause,
  onSeek,
  transport = true,
  hideStop = false,
}: {
  /** The master <video> when WE are the presenter; null on a viewer (who only has the captured stream). */
  videoRef: RefObject<HTMLVideoElement | null> | null
  /** The presenter's broadcast transport when WE are a viewer; ignored when we're the presenter. */
  xport: { playing: boolean; time: number; dur: number } | null
  /** Ref-callback for the pen/ink toolbar slot — rendered as a row ABOVE the transport (chat-layout style),
   *  always visible (never auto-hidden). Omitted when chat is open (the ink lives in the chat box then). */
  inkSlotRef?: ((el: HTMLElement | null) => void) | null
  /** Off-stage: presenter clears locally; a viewer relays `stagecmd:offstage` to the master. */
  onStop: () => void
  /** Toggle play/pause: presenter drives the <video>; a viewer relays. (Unused when transport=false.) */
  onPlayPause?: () => void
  /** Seek to a time (seconds): presenter sets currentTime; a viewer relays `stagecmd:seek`. (Unused when transport=false.) */
  onSeek?: (time: number) => void
  /** When false, render ONLY the red ⏹ Stop + the ink slot — a native <video controls> handles play/seek/scrub
   *  (the local-copy "send-the-state" stage). Default true = the full custom transport (the streamed stage). */
  transport?: boolean
  /** Hide the red ⏹ Stop — when the header owns the shared Stop (stageHdrCtl), so it isn't duplicated on the stage. */
  hideStop?: boolean
}) {
  const isPresenter = !!videoRef
  // Re-render on the master's transport events (presenter) so the scrub + play icon track the <video> live.
  const [, force] = useState(0)
  useEffect(() => {
    const v = videoRef?.current
    if (!v) return
    const on = () => force((n) => (n + 1) & 0xffff)
    const evs = ['timeupdate', 'play', 'pause', 'loadedmetadata', 'durationchange'] as const
    for (const ev of evs) v.addEventListener(ev, on)
    return () => {
      for (const ev of evs) v.removeEventListener(ev, on)
    }
  }, [videoRef])
  // Two-step Stop: first tap arms (red turns to "Stop showing?"), a second confirms. Auto-disarms after 4s.
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])

  const v = videoRef?.current
  const playing = isPresenter ? !!v && !v.paused : !!xport?.playing
  const time = isPresenter ? v?.currentTime || 0 : xport?.time || 0
  const dur = isPresenter ? v?.duration || 0 : xport?.dur || 0
  const seekable = Number.isFinite(dur) && dur > 0

  return (
    <>
      {/* The red Stop — for everyone. Hidden when the header owns the shared Stop (hideStop). Two-tap confirm. */}
      {!hideStop && (
        <button
          type="button"
          className={`kw-stage-stop${armed ? ' armed' : ''}`}
          onClick={() => (armed ? onStop() : setArmed(true))}
          title={armed ? 'Tap again to stop showing on stage' : 'Stop showing this on stage'}
          aria-label="Stop showing on stage"
        >
          {armed ? '⏹ Stop showing?' : '⏹ Stop'}
        </button>
      )}
      {/* The pen/ink toolbar portals in here — a row directly ABOVE the transport (mirrors the chat layout's
          tools-above-input), always visible. Omitted when chat is open (the ink lives in the chat box then). */}
      {inkSlotRef && <div className="kw-stage-inkslot" ref={inkSlotRef} />}
      {/* The transport — play/pause + scrub + time, along the bottom, like a desktop video player. Synced for all.
          Hidden (transport=false) when a native <video controls> provides it (the local-copy stage). */}
      {transport && (
        <div className="kw-stagebar" role="group" aria-label="Stage video controls">
          <button
            type="button"
            className="kw-stagebar-btn"
            onClick={() => onPlayPause?.()}
            title={playing ? 'Pause for everyone' : 'Play for everyone'}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? '⏸' : '▶'}
          </button>
          <input
            type="range"
            className="kw-stagebar-scrub"
            min={0}
            max={seekable ? dur : 0}
            value={Math.min(time, seekable ? dur : 0)}
            step="any"
            disabled={!seekable}
            onChange={(e) => onSeek?.(Number(e.currentTarget.value))}
            aria-label="Seek"
          />
          <span className="kw-stagebar-time">
            {fmt(time)} / {fmt(dur)}
          </span>
        </div>
      )}
    </>
  )
}
