import { useEffect, useRef, type SyntheticEvent } from 'react'

// A chat video preview that honors speaker-off (deaf) — muted is set imperatively (the `muted` prop is
// unreliable on media elements), so turning the speaker off silences the preview like all other audio.
function ChatVideo({ src, deaf }: { src: string; deaf: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    if (ref.current) ref.current.muted = deaf
  }, [deaf])
  // iOS Safari paints a BLANK frame for preload="metadata" until you scrub/play — so a shared video shows
  // black instead of its first frame. Once metadata is in, seek a hair forward (only while untouched) to
  // force that frame to decode + render as the poster. Negligible play-start shift; harmless on desktop.
  const showFirstFrame = (e: SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget
    if (v.currentTime === 0 && v.paused && v.duration > 0) {
      try {
        v.currentTime = Math.min(0.1, v.duration / 2)
      } catch {
        /* seek not ready — ignore */
      }
    }
  }
  return <video ref={ref} className="kw-msg-vid" src={src} controls playsInline preload="metadata" onLoadedMetadata={showFirstFrame} onLoadedData={showFirstFrame} />
}
// A chat audio preview. Rendered as a <video> (not <audio>) so it gets the SAME full media controls + real
// box dimensions as a video — the bare <audio> bar was too narrow and looked clunky. Honors speaker-off (deaf).
function ChatAudio({ src, deaf }: { src: string; deaf: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    if (ref.current) ref.current.muted = deaf
  }, [deaf])
  return <video ref={ref} className="kw-msg-aud" src={src} controls playsInline preload="metadata" />
}

// A chat media bubble: a shared image / video / audio with Stage (present to everyone) + Save actions. Lifted from
// Widget.tsx's mediaBubble render-helper into a real component with EXPLICIT props (it used to close over
// deaf / preview / call.inCall / presentMedia). ChatVideo + ChatAudio moved here too — they were only used by it.
// kw-msg-* classes are global (shadow-rooted) — keep verbatim.
export function MediaBubble({
  keyId,
  src,
  name,
  kind,
  deaf,
  preview,
  inCall,
  presentMedia,
}: {
  keyId: string
  src: string
  name: string | undefined
  kind: 'image' | 'video' | 'audio'
  deaf: boolean
  preview: boolean
  inCall: boolean
  presentMedia: (src: string, key: string, playable: boolean, opts?: { kind?: 'image' | 'video' | 'audio' }) => void | Promise<void>
}) {
  return (
    <div className="kw-msg-img-wrap">
      {kind === 'image' ? (
        <span className="kw-msg-img">
          <img src={src} alt={name || 'shared image'} loading="lazy" />
        </span>
      ) : kind === 'video' ? (
        <ChatVideo src={src} deaf={deaf} />
      ) : (
        <ChatAudio src={src} deaf={deaf} />
      )}
      <div className="kw-msg-img-acts" role="menu">
        {!preview && inCall && (
          <button type="button" onClick={() => void presentMedia(src, keyId, kind !== 'image', { kind })}>📺 Stage</button>
        )}
        <a href={src} download={name || (kind === 'video' ? 'video.mp4' : kind === 'audio' ? 'audio.mp3' : 'image.png')} target="_blank" rel="noreferrer">
          💾 Save
        </a>
      </div>
    </div>
  )
}
