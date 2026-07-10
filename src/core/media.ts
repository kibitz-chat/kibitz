/** Media capture constants + the placeholder-track trick (see mesh.ts docs). */

export const AUDIO: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

// Deliberately low-res: in a serverless mesh each phone uploads its video to every
// peer, so keep it light on bandwidth/CPU.
export const VIDEO: MediaTrackConstraints = {
  width: { ideal: 320 },
  height: { ideal: 240 },
  frameRate: { ideal: 20 },
}

export type CamFacing = 'user' | 'environment'

/** Camera constraints with an explicit side — front ('user') by default, so
 * phones never surprise with the rear camera. Plain (ideal) semantics: desktops
 * without a facing camera simply ignore it. */
export function videoConstraints(facing: CamFacing): MediaTrackConstraints {
  return { ...VIDEO, facingMode: facing }
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop())
}

/**
 * iOS — any browser (all WebKit). iOS Safari only exposes real local-network ICE
 * candidates once getUserMedia has granted media permission; before that it uses
 * mDNS candidates that can't connect cross-browser on a LAN. So on iOS we grab the
 * mic at join (kept MUTED — permission is what unlocks ICE, not transmitting),
 * which lets the connection form. Android/desktop keep the no-prompt lazy mic.
 * iPadOS 13+ reports itself as "MacIntel", so also catch a Mac reporting touch.
 */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

/** True when running as an INSTALLED Home-Screen app (iOS standalone, or any display-mode:standalone PWA). There's
 *  no address bar there, so a DENIED mic can't be re-granted in-app — a block must be fixed via OS Settings. */
export function isStandaloneApp(): boolean {
  if (typeof window === 'undefined') return false
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  const displayStandalone = typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches
  return iosStandalone || displayStandalone
}

/** A human, actionable message for a getUserMedia(mic) failure, keyed by the DOMException name — so the UI stops
 *  calling every failure "blocked". `standalone` ⇒ the installed Home-Screen app (no address bar to re-grant), so a
 *  block routes to iOS Settings instead of "your browser settings". */
export function micErrorMessage(errName: string, standalone = false): string {
  switch (errName) {
    case 'NotAllowedError':
    case 'SecurityError':
      return standalone
        ? 'Mic blocked. In iOS Settings → Safari → turn ON “Camera & Microphone Access”, then reopen the app (or re-add it to the Home Screen).'
        : 'Microphone access was blocked. Allow it for this site in your browser settings, then reload.'
    case 'NotReadableError':
    case 'AbortError':
      return 'Your microphone is busy in another app (a call, FaceTime, another tab). Close it and try again.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found on this device.'
    default:
      return errName ? `Couldn’t open the microphone (${errName}).` : 'Couldn’t open the microphone.'
  }
}

/**
 * Can this device share its screen? `getDisplayMedia` is desktop-only — iOS Safari and Android
 * Chrome simply don't expose it — so the screen-share button + nudge are dead weight on mobile
 * (and on any browser without the capability). Feature-detect rather than UA-sniff.
 */
export function canScreenShare(): boolean {
  if (typeof navigator === 'undefined') return false
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function'
}

/**
 * A tiny black canvas video track, sent while the camera is off. Its only job is to
 * keep a SEND video lane negotiated on every connection from the moment it's made,
 * so turning the camera on/off is a silent RTCRtpSender.replaceTrack on the live
 * call — never a re-dial (re-dial churn crashes iOS WebKit natively). Bitrate is
 * negligible: a static 2×2 black frame.
 */
export function createPlaceholderVideoTrack(): MediaStreamTrack | null {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    canvas.getContext('2d')?.fillRect(0, 0, 2, 2)
    return canvas.captureStream(1).getVideoTracks()[0] ?? null
  } catch {
    return null // unsupported → we can still RECEIVE video (offerToReceive*), just not send
  }
}

// One page-lifetime AudioContext is enough to mint silent tracks (browsers cap
// the number of contexts; we never need more than this one, and never close it).
let silentAudioCtx: AudioContext | null = null
let silentGain: GainNode | null = null // ONE shared 0-gain oscillator feeds every placeholder track

/**
 * A SILENT audio track, sent while the mic is off or not yet granted. Its only
 * job — exactly like the video placeholder — is to keep a SEND audio lane
 * negotiated on every connection from join, so granting the real mic later (first
 * unmute) is a silent RTCRtpSender.replaceTrack on the live call, never a
 * renegotiation (which crashes iOS WebKit). Lets a call be JOINED with no
 * microphone permission prompt at all.
 *
 * CRITICAL for iOS Safari: the track must be a REAL, FLOWING source, not an empty
 * MediaStreamDestination on a suspended context. An empty/suspended destination
 * yields a track that produces no samples; Chromium tolerates it, but iOS WebRTC
 * treats a sample-less audio track as dead and the media connection never
 * completes (you'd see only your own tile until a real getUserMedia track — mic or
 * camera — replaced it). So we (1) resume the context — the join tap is a user
 * gesture, so this is allowed — and (2) feed it an actual zero-gain oscillator, so
 * it genuinely produces digital silence.
 */
export function createPlaceholderAudioTrack(): MediaStreamTrack | null {
  try {
    const Ctx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return null
    const ctx = (silentAudioCtx = silentAudioCtx ?? new Ctx())
    void ctx.resume().catch(() => {})
    // ONE shared zero-gain oscillator (created once), tapped by a fresh destination per call —
    // so repeated placeholder churn (the free-mic-when-muted toggle swaps one in on every mute)
    // doesn't pile up zombie oscillator nodes in the context.
    if (!silentGain) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      gain.gain.value = 0 // inaudible, but the oscillator actively produces samples
      osc.connect(gain)
      osc.start()
      silentGain = gain
    }
    const dst = ctx.createMediaStreamDestination()
    silentGain.connect(dst)
    const track = dst.stream.getAudioTracks()[0] ?? null
    if (track) {
      // Disconnect this destination when the track is stopped, so it (and its track) can be GC'd
      // instead of lingering connected to the shared gain. stop() doesn't fire 'ended', so wrap it.
      const origStop = track.stop.bind(track)
      track.stop = () => {
        try {
          silentGain?.disconnect(dst)
        } catch {
          /* already disconnected */
        }
        origStop()
      }
    }
    return track
  } catch {
    return null // no Web Audio → caller falls back to grabbing the mic at join
  }
}

/**
 * Close the page-lifetime silent AudioContext (and its shared oscillator). Call on call teardown so an
 * idle post-call landing doesn't sit on a `running` context — on iOS that alone keeps the audio engine
 * awake (battery drain + the app-switch "click"). Idempotent. It's re-minted lazily on the next join by
 * createPlaceholderAudioTrack, under the join tap (a user gesture, so `resume()` is allowed). Stop any
 * placeholder tracks BEFORE calling this — closing the context ends every track derived from it.
 */
export function closeSilentAudio(): void {
  const ctx = silentAudioCtx
  silentAudioCtx = null
  silentGain = null // the oscillator/gain live inside ctx; close() drops them, re-created lazily on next mint
  void ctx?.close().catch(() => {})
}
