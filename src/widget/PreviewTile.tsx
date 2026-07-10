import { type Dispatch, type RefObject, type SetStateAction } from 'react'
import { SpeakerIcon, SpeakerOffIcon, FlipCamIcon, MicIcon, MicOffIcon, VideoIcon, VideoOffIcon } from './icons'

// The pre-join preview tile: the live camera preview (or an initial-letter avatar fallback), the speaker + flip
// side buttons (Zoom-style top-right stack), and the mic/cam toggles — what you see before joining. Purely
// presentational over the pre-join intents + the preview stream. Extracted from Widget.tsx's pre-join screen.
// kw-pre-* classes are global (shadow-rooted) — keep verbatim.
export function PreviewTile({
  preCam,
  previewStream,
  previewVidEl,
  preFacing,
  name,
  preSpeaker,
  setPreSpeaker,
  flipPre,
  preMic,
  togglePreMic,
  togglePreCam,
}: {
  preCam: boolean
  previewStream: MediaStream | null
  previewVidEl: RefObject<HTMLVideoElement | null>
  preFacing: 'user' | 'environment'
  name: string
  preSpeaker: boolean
  setPreSpeaker: Dispatch<SetStateAction<boolean>>
  flipPre: () => void
  preMic: boolean
  togglePreMic: () => void
  togglePreCam: () => void
}) {
  return (
    <div className="kw-pre-tile">
      {preCam && previewStream && previewStream.getVideoTracks().length > 0 ? (
        <video ref={previewVidEl} autoPlay playsInline muted className={`kw-pre-vid${preFacing === 'environment' ? ' no-mirror' : ''}`} />
      ) : (
        <div className="kw-pre-face" aria-hidden="true">
          {(name || '?').charAt(0).toUpperCase()}
        </div>
      )}
      {/* Top-right stack, like Zoom: speaker (audio output) + forward/flip camera. */}
      <div className="kw-pre-side">
        <button
          type="button"
          className="kw-pre-sidebtn"
          aria-pressed={preSpeaker}
          aria-label={preSpeaker ? 'Speaker on' : 'Speaker off'}
          title="Speaker"
          onClick={() => setPreSpeaker((v) => !v)}
        >
          {preSpeaker ? <SpeakerIcon /> : <SpeakerOffIcon />}
        </button>
        {preCam && (
          <button type="button" className="kw-pre-sidebtn" aria-label="Flip camera" title="Flip camera" onClick={flipPre}>
            <FlipCamIcon />
          </button>
        )}
      </div>
      <div className="kw-pre-ctl">
        <button
          type="button"
          className={`kw-pre-btn${preMic ? ' on' : ''}`}
          aria-pressed={preMic}
          aria-label={preMic ? 'Mute microphone' : 'Unmute microphone'}
          title="Microphone"
          onClick={togglePreMic}
        >
          {preMic ? <MicIcon /> : <MicOffIcon />}
        </button>
        <button
          type="button"
          className={`kw-pre-btn${preCam ? ' on' : ''}`}
          aria-pressed={preCam}
          aria-label={preCam ? 'Turn camera off' : 'Turn camera on'}
          title="Camera"
          onClick={togglePreCam}
        >
          {preCam ? <VideoIcon /> : <VideoOffIcon />}
        </button>
      </div>
    </div>
  )
}
