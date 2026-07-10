import { useCallback, useEffect, useRef, useState } from 'react'
import type { CallController } from '../react/useCall'

// The pre-join "lobby" media controller, lifted out of Widget.tsx (~120 lines). Kept entirely separate from the
// call's own media (which has its own hard-won iOS lifecycle): we fully stop the preview tracks before call.join(),
// then re-apply the chosen mic/cam via the call's own toggles. preMic/preCam are the chosen INTENTS; previewStream
// is the live local stream. One getUserMedia at a time (stop the old first), roll the intent back on denial,
// re-enumerate device labels once permission lands, and tear the preview down on join/unmount. The caller's join
// handler reads the chosen intents + ids + stopPreview(). A pure move — every effect + dependency array preserved.
export function usePreJoinMedia(call: CallController, preview: boolean, headless: boolean) {
  const [preMic, setPreMic] = useState(false)
  const [preCam, setPreCam] = useState(false)
  const [preFacing, setPreFacing] = useState<'user' | 'environment'>('user')
  // Speaker (audio-output) toggle — shown like Zoom's. Web has no earpiece/loudspeaker route API, so
  // this is a display preference only (it doesn't change routing); kept for parity with the reference.
  const [preSpeaker, setPreSpeaker] = useState(true)
  // Chosen INPUT/OUTPUT device ids ('' = system default) — desktop especially has several. mic/cam are
  // applied to the preview now and carried into the call on join; speaker (output) is carried on join
  // (no remote audio to route in the lobby). Device lists come from enumerateDevices (labels appear
  // only after media permission — see applyPreview re-enumerating, and the devicechange listener).
  const [preMicId, setPreMicId] = useState('')
  const [preCamId, setPreCamId] = useState('')
  const [preSpeakerId, setPreSpeakerId] = useState('')
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [cams, setCams] = useState<MediaDeviceInfo[]>([])
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([])
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null)
  const previewStreamRef = useRef<MediaStream | null>(null)
  previewStreamRef.current = previewStream
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const previewBusyRef = useRef(false)
  const previewVidEl = useRef<HTMLVideoElement | null>(null)

  const refreshDevices = useCallback(async () => {
    try {
      const ds = await navigator.mediaDevices.enumerateDevices()
      setMics(ds.filter((d) => d.kind === 'audioinput'))
      setCams(ds.filter((d) => d.kind === 'videoinput'))
      setSpeakers(ds.filter((d) => d.kind === 'audiooutput'))
    } catch {
      /* enumerate unavailable (no permission / unsupported) — leave the lists as-is */
    }
  }, [])

  const stopPreview = useCallback(() => {
    previewStreamRef.current?.getTracks().forEach((t) => t.stop())
    previewStreamRef.current = null
    setPreviewStream(null)
  }, [])

  // Rebuild the local preview for the desired mic/cam (facing OR a specific deviceId) — one getUserMedia,
  // stopping the old stream first so we never hold two camera handles. On denial, roll the intent back.
  const applyPreview = useCallback(
    async (wantMic: boolean, wantCam: boolean, facing: 'user' | 'environment', micId: string, camId: string) => {
      if (previewBusyRef.current) return
      previewBusyRef.current = true
      try {
        previewStreamRef.current?.getTracks().forEach((t) => t.stop())
        previewStreamRef.current = null
        setPreviewStream(null)
        if (!wantMic && !wantCam) {
          setPreviewErr(null)
          return
        }
        const audio = wantMic ? (micId ? { deviceId: { exact: micId } } : true) : false
        const video = wantCam ? (camId ? { deviceId: { exact: camId } } : { facingMode: facing }) : false
        const s = await navigator.mediaDevices.getUserMedia({ audio, video })
        previewStreamRef.current = s
        setPreviewStream(s)
        setPreviewErr(null)
        void refreshDevices() // permission granted → device LABELS are now readable
      } catch {
        setPreviewErr(wantCam ? 'Camera/mic blocked — allow access, or just join.' : 'Mic blocked — allow access, or just join.')
        setPreMic(false)
        setPreCam(false)
      } finally {
        previewBusyRef.current = false
      }
    },
    [refreshDevices],
  )

  const togglePreMic = useCallback(() => {
    const next = !preMic
    setPreMic(next)
    void applyPreview(next, preCam, preFacing, preMicId, preCamId)
  }, [preMic, preCam, preFacing, preMicId, preCamId, applyPreview])
  const togglePreCam = useCallback(() => {
    const next = !preCam
    setPreCam(next)
    void applyPreview(preMic, next, preFacing, preMicId, preCamId)
  }, [preMic, preCam, preFacing, preMicId, preCamId, applyPreview])
  const flipPre = useCallback(() => {
    const f = preFacing === 'user' ? 'environment' : 'user'
    setPreFacing(f)
    setPreCamId('') // a manual flip clears any specific-camera pick (facing decides front/rear)
    if (preCam) void applyPreview(preMic, true, f, preMicId, '')
  }, [preFacing, preMic, preCam, preMicId, applyPreview])
  // Device-picker changes (desktop): switch the preview's mic/cam immediately; speaker rides into the call.
  const selectMic = useCallback(
    (id: string) => {
      setPreMicId(id)
      if (preMic) void applyPreview(true, preCam, preFacing, id, preCamId)
    },
    [preMic, preCam, preFacing, preCamId, applyPreview],
  )
  const selectCam = useCallback(
    (id: string) => {
      setPreCamId(id)
      if (preCam) void applyPreview(preMic, true, preFacing, preMicId, id)
    },
    [preMic, preCam, preFacing, preMicId, applyPreview],
  )

  // Attach the preview stream to the <video> whenever it changes; tear it all down on join / unmount.
  useEffect(() => {
    const el = previewVidEl.current
    if (el) {
      el.srcObject = previewStream
      if (previewStream) void el.play?.().catch(() => {})
    }
  }, [previewStream])
  useEffect(() => {
    if (call.inCall) stopPreview()
  }, [call.inCall, stopPreview])
  useEffect(() => () => stopPreview(), [stopPreview])
  // Populate the device pickers in the lobby — once at mount (labels are generic until permission) and
  // again whenever devices are plugged/unplugged. (applyPreview also re-enumerates after permission.)
  useEffect(() => {
    if (call.inCall || preview || headless) return
    void refreshDevices()
    const md = navigator.mediaDevices
    md?.addEventListener?.('devicechange', refreshDevices)
    return () => md?.removeEventListener?.('devicechange', refreshDevices)
  }, [call.inCall, preview, headless, refreshDevices])

  return {
    preMic,
    preCam,
    preFacing,
    preSpeaker,
    setPreSpeaker,
    preMicId,
    preCamId,
    preSpeakerId,
    setPreSpeakerId,
    mics,
    cams,
    speakers,
    previewStream,
    previewErr,
    previewVidEl,
    togglePreMic,
    togglePreCam,
    flipPre,
    selectMic,
    selectCam,
    stopPreview,
  }
}
