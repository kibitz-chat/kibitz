import { type Dispatch, type SetStateAction } from 'react'
import { isIOS } from '../core/media'

// The window/display controls in the call bar: see-through "ghost" mode, document Picture-in-Picture (pop the
// room into a floating OS window), and video PiP (Android Chrome — float the active speaker over the home screen).
// Purely presentational. Extracted from Widget.tsx's callControls. kw-ic classes are global. pip / pipApi / host
// are truthy flags here (a Window / DocumentPiP API / HTMLElement upstream, coerced to booleans at the call site).
export function WindowControls({
  fillMode,
  pip,
  ghost,
  setGhost,
  host,
  pipApi,
  popOut,
  videoPip,
}: {
  fillMode: boolean
  pip: boolean
  ghost: boolean
  setGhost: Dispatch<SetStateAction<boolean>>
  host: boolean
  pipApi: boolean
  popOut: () => void | Promise<void>
  videoPip: { supported: boolean; active: boolean; toggle: () => void }
}) {
  return (
    <>
      {!fillMode && !pip && (
        <button
          className={`kw-ic${ghost ? ' active' : ''}`}
          onClick={() => setGhost((g) => !g)}
          aria-pressed={ghost}
          title={ghost ? 'Make the panel solid' : 'See-through (use the page underneath)'}
        >
          {ghost ? '◐' : '◑'}
        </button>
      )}
      {host && pipApi && (
        <button
          className={`kw-ic${pip ? ' active' : ''}`}
          onClick={() => void popOut()}
          title={pip ? 'Bring the room back to this page' : 'Pop out — float over every tab and app'}
        >
          ⧉
        </button>
      )}
      {/* Video Picture-in-Picture (Android Chrome): float the active speaker over the home
          screen. Shown only where Document PiP (above) isn't available. NOT on iOS: Safari
          exposes the PiP API but refuses to put a live-call (canvas/MediaStream) video into
          PiP — that floating-window privilege is reserved for native apps + file/HLS video —
          so the button would be dead there. */}
      {videoPip.supported && !pipApi && !isIOS() && (
        <button
          className={`kw-ic${videoPip.active ? ' active' : ''}`}
          onClick={videoPip.toggle}
          aria-label={videoPip.active ? 'Stop the floating video' : 'Float the call over the home screen'}
          title={videoPip.active ? 'Stop the floating video' : 'Pop out video — float over the home screen'}
        >
          ⧉
        </button>
      )}
    </>
  )
}
