// iOS suspends a web app's media CAPTURE the moment it's backgrounded (app switch / screen lock) — Apple
// enforces it, there's no web API to keep the camera or mic capturing in the background. So the capture
// stopping is unavoidable; what we CAN do is bring it back cleanly when the app returns to the foreground.
//
// On return the real mic / camera track is typically `ended` (truly released) — re-acquire it; or it's
// merely `muted` (frames paused, still live) — it should resume on its own. These pure helpers decide WHICH
// lanes need re-acquiring, so the gnarly getUserMedia + mesh-swap part (device-only, untestable in node)
// stays thin. Off iOS, capture survives backgrounding, so this is a no-op there.

/** A captured track is "dead" (needs re-acquiring) when it's gone or the OS has ended it. A live-but-muted
 *  track is NOT dead — iOS unmutes it again on foreground. */
export function trackDead(track: MediaStreamTrack | undefined | null): boolean {
  return !track || track.readyState === 'ended'
}

export interface ReviveInput {
  /** Only iOS kills capture on background; elsewhere there's nothing to revive. */
  ios: boolean
  /** No call → nothing to restore. */
  inCall: boolean
  /** The user wants to be UNMUTED (mic intent), independent of whether a live track exists. */
  micIntent: boolean
  /** The user wants the CAMERA on (cam intent). */
  camIntent: boolean
  /** Car mode holds the mic captured on purpose — never re-grab/﻿disturb it here. */
  keepMic: boolean
  /** The real mic track is gone / ended (see trackDead). */
  micDead: boolean
  /** The real camera track is gone / ended (see trackDead). */
  camDead: boolean
}

export interface RevivePlan {
  reMic: boolean
  reCam: boolean
}

/** Which media lanes to re-acquire after a return-to-foreground (or a track-`ended` event). A lane is
 *  revived only when the user still WANTS it (intent on) AND its real track actually died — so a muted/live
 *  track, a lane the user turned off, and every non-iOS platform all fall through as no-ops. */
export function planRevive(i: ReviveInput): RevivePlan {
  if (!i.ios || !i.inCall) return { reMic: false, reCam: false }
  return {
    reMic: i.micIntent && !i.keepMic && i.micDead,
    reCam: i.camIntent && i.camDead,
  }
}
