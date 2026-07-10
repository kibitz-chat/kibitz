import { type Dispatch, type SetStateAction } from 'react'
import { MicIcon, VideoIcon, SpeakerIcon } from './icons'

// Whether we can choose the audio OUTPUT device (setSinkId — Chromium only). Gates the speaker picker.
const CAN_PICK_SPEAKER = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

// The pre-join device pickers: choose which mic / camera / speaker to use. ALL are DESKTOP-ONLY (no touch): a phone
// routes audio at the OS level (you don't pick a physical mic/speaker) and the camera flip button already covers
// front/rear, so device dropdowns are pure clutter there. And phones ENUMERATE SEVERAL devices of each kind
// (multiple built-in mics, "default"/"communications", several lenses, multiple outputs), so a naive ">1 = a real
// choice" guard wrongly showed the mic/speaker pickers on mobile. On desktop, show a selector whenever a device of
// that kind exists. Labels appear once media permission is granted. Purely presentational; the "is any picker worth
// showing" guard lives here as an early return. Extracted from Widget.tsx's pre-join screen. kw-pre-* classes global.
export function PreJoinDevices({
  mics,
  cams,
  speakers,
  canTouch,
  preMicId,
  selectMic,
  preCamId,
  selectCam,
  preSpeakerId,
  setPreSpeakerId,
}: {
  mics: MediaDeviceInfo[]
  cams: MediaDeviceInfo[]
  speakers: MediaDeviceInfo[]
  canTouch: boolean
  preMicId: string
  selectMic: (id: string) => void
  preCamId: string
  selectCam: (id: string) => void
  preSpeakerId: string
  setPreSpeakerId: Dispatch<SetStateAction<string>>
}) {
  const showMic = !canTouch && mics.length > 0
  const showCam = !canTouch && cams.length > 0
  const showSpeaker = !canTouch && CAN_PICK_SPEAKER && speakers.length > 0
  if (!(showMic || showCam || showSpeaker)) return null
  return (
    <div className="kw-pre-devices">
      {showMic && (
        <label className="kw-pre-dev">
          <span className="kw-pre-dev-ico" aria-hidden="true">
            <MicIcon />
          </span>
          <select value={preMicId} onChange={(e) => selectMic(e.target.value)} aria-label="Microphone">
            <option value="">Default microphone</option>
            {mics.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>
            ))}
          </select>
        </label>
      )}
      {showCam && (
        <label className="kw-pre-dev">
          <span className="kw-pre-dev-ico" aria-hidden="true">
            <VideoIcon />
          </span>
          <select value={preCamId} onChange={(e) => selectCam(e.target.value)} aria-label="Camera">
            <option value="">Default camera</option>
            {cams.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>
            ))}
          </select>
        </label>
      )}
      {showSpeaker && (
        <label className="kw-pre-dev">
          <span className="kw-pre-dev-ico" aria-hidden="true">
            <SpeakerIcon />
          </span>
          <select value={preSpeakerId} onChange={(e) => setPreSpeakerId(e.target.value)} aria-label="Speaker">
            <option value="">Default speaker</option>
            {speakers.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || `Speaker ${i + 1}`}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}
