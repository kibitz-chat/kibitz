import { canScreenShare } from '../core/media'
import type { CallController } from '../react/useCall'

// The screen-share / stop-staging buttons in the call bar (room-window only, desktop): start or stop presenting
// your screen, or stop a staged chat image/video. Purely presentational over the call controller + a couple of
// local flags. A cohesive group lifted out of Widget.tsx's callControls. kw-ic classes are global — keep verbatim.
export function ShareControls({
  call,
  preview,
  fill,
  presentingImage,
  startShare,
  stopImagePresent,
  hideStageStop = false,
}: {
  call: CallController
  preview: boolean
  fill: boolean
  presentingImage: boolean
  startShare: () => void | Promise<void>
  stopImagePresent: () => void
  /** Hide the staged-image 🛑 stop — when the header owns the shared Stop (stageHdrCtl), so it isn't duplicated. */
  hideStageStop?: boolean
}) {
  return (
    <>
      {/* Screen-share lives in the dedicated room window only, not the embedded widget: sharing your
          desktop FROM a little box floating on someone else's page is an odd fit, so the widget stays a
          lightweight call. (canScreenShare is desktop-only anyway, which is where the widget showed it.) */}
      {/* Screen-share button — hidden while STAGING a chat image/video (that uses the share lane too, so
          call.sharing is true, but its own 🛑 below handles the full cleanup; showing both = two stops). */}
      {!preview && fill && canScreenShare() && !presentingImage && (
        <button
          className={`kw-ic${call.sharing ? ' active' : ''}`}
          onClick={() => (call.sharing ? call.stopShare() : void startShare())}
          aria-label={call.sharing ? 'Stop sharing your screen' : 'Share your screen or a tab'}
          title={call.sharing ? 'Stop presenting' : 'Present your screen or a tab to everyone'}
        >
          {call.sharing ? '🛑' : '🖥️'}
        </button>
      )}
      {/* The single stop for a staged chat image/video (full cleanup: stop share + audio lane + doodle key).
          Hidden when the header owns the shared Stop (hideStageStop). */}
      {!preview && fill && presentingImage && !hideStageStop && (
        <button
          className="kw-ic active"
          onClick={() => stopImagePresent()}
          aria-label="Stop showing on the stage"
          title="Stop showing on the stage"
        >
          🛑
        </button>
      )}
    </>
  )
}
