import { type Dispatch, type RefObject, type SetStateAction, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MicIcon, MicOffIcon, VideoIcon, VideoOffIcon, FlipCamIcon, SpeakerIcon, SpeakerOffIcon } from './icons'
import type { CallController } from '../react/useCall'

// Whether we can choose the audio OUTPUT device (setSinkId — Chromium only). Gates the speaker device menu.
const CAN_PICK_SPEAKER = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

// The dropdown of devices for one kind. The chevron stays anchored to the control button, but the MENU is PORTALED to
// the panel root and positioned `fixed` off the button's rect — the call tiles/stage sit in their own stacking layer,
// so an in-place (nested) popover renders BEHIND them; the portal lifts it to the top layer where nothing covers it.
// Renders nothing unless there's a real choice (>1 device). Global kw-* classes (shadow-rooted).
function DevMenu({
  kind, label, devices, activeId, open, setOpen, onPick, align, portalTarget,
}: {
  kind: string
  label: string
  devices: MediaDeviceInfo[]
  activeId: string
  open: boolean
  setOpen: (k: string | null) => void
  onPick: (id: string) => void
  align?: 'end'
  portalTarget: HTMLElement | null
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const [style, setStyle] = useState<React.CSSProperties | null>(null)
  // Position the fixed menu ABOVE the button off its viewport rect; re-place on resize while open.
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const bottom = Math.round(window.innerHeight - r.top + 9)
      setStyle(
        align === 'end'
          ? { position: 'fixed', bottom, right: Math.round(window.innerWidth - r.right) }
          : { position: 'fixed', bottom, left: Math.round(r.left + r.width / 2), transform: 'translateX(-50%)' },
      )
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, align])

  if (devices.length < 2) return null
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="kw-dev-caret"
        aria-label={`Choose ${label.toLowerCase()}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(open ? null : kind) }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && style && portalTarget &&
        createPortal(
          <div className={`kw-dev-menu${align === 'end' ? ' kw-dev-menu-end' : ''}`} role="menu" style={style}>
            <h4 className="kw-dev-h">{label}</h4>
            {devices.map((d, i) => {
              const on = d.deviceId === activeId
              return (
                <button
                  key={d.deviceId || i}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  className={`kw-dev-opt${on ? ' on' : ''}`}
                  onClick={() => { onPick(d.deviceId); setOpen(null) }}
                >
                  <span className="kw-dev-tick" aria-hidden="true">
                    {on && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>}
                  </span>
                  <span className="kw-dev-name">{d.label || `${label} ${i + 1}`}</span>
                </button>
              )
            })}
          </div>,
          portalTarget,
        )}
    </>
  )
}

// The core media controls in the call bar: mic, camera, flip-camera (touch / multi-cam), and speaker (deaf). On
// DESKTOP each of mic/camera/speaker also carries a ▾ chevron that opens a live device switcher — a computer often
// has several inputs (built-in + an external webcam/headset/monitor speakers) and the caller wants to pick without
// leaving the call. Switching is a renegotiation-free replaceTrack (setSinkId for output), so the other side sees no
// blip. Touch omits the chevrons: phones route mic/speaker at the OS level and the flip button covers front/rear.
// kw-ic / kw-dev classes are global (shadow-rooted) — keep them verbatim.
export function MediaControls({
  call,
  canTouch,
  deaf,
  setDeaf,
  portalRef,
}: {
  call: CallController
  canTouch: boolean
  deaf: boolean
  setDeaf: Dispatch<SetStateAction<boolean>>
  /** The panel root — device menus portal here so the call tiles can't cover them. */
  portalRef: RefObject<HTMLDivElement | null>
}) {
  const [devs, setDevs] = useState<{ mics: MediaDeviceInfo[]; cams: MediaDeviceInfo[]; spks: MediaDeviceInfo[] }>({ mics: [], cams: [], spks: [] })
  const [menu, setMenu] = useState<string | null>(null) // which device menu is open ('mic' | 'cam' | 'spk' | null)

  // Enumerate input/output devices while in the call — labels are readable here (permission is granted), unlike a
  // fresh pre-join. Refresh on hotplug (a headset plugged in mid-call). Desktop only.
  useEffect(() => {
    if (canTouch) return
    const md = navigator.mediaDevices
    if (!md?.enumerateDevices) return
    const refresh = () =>
      md
        .enumerateDevices()
        .then((ds) =>
          setDevs({
            mics: ds.filter((d) => d.kind === 'audioinput'),
            cams: ds.filter((d) => d.kind === 'videoinput'),
            spks: ds.filter((d) => d.kind === 'audiooutput'),
          }),
        )
        .catch(() => {})
    void refresh()
    md.addEventListener?.('devicechange', refresh)
    return () => md.removeEventListener?.('devicechange', refresh)
  }, [canTouch])

  // Close the open menu on an outside pointer-down. The widget lives in an OPEN shadow root, so the event target is
  // retargeted to the host — match via composedPath(), not target.closest(). The chevron (.kw-dev-wrap) AND the
  // portaled menu (.kw-dev-menu) both count as "inside" so a click on either doesn't dismiss before it registers.
  useEffect(() => {
    if (!menu) return
    const onDown = (e: Event) => {
      const path = (e as Event & { composedPath?: () => EventTarget[] }).composedPath?.() || []
      if (!path.some((n) => n instanceof HTMLElement && (n.classList.contains('kw-dev-wrap') || n.classList.contains('kw-dev-menu')))) setMenu(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [menu])

  const target = portalRef.current

  return (
    <>
      <span className="kw-ic-wrap kw-dev-wrap">
        <button
          className={`kw-ic${call.micOn ? '' : ' off'}`}
          onClick={() => void call.toggleMic()}
          aria-label={call.micOn ? 'Mute microphone' : 'Unmute microphone'}
          title={call.micOn ? 'Mute (M)' : 'Unmute (M · hold Space to talk)'}
        >
          {call.micOn ? <MicIcon /> : <MicOffIcon />}
        </button>
        <DevMenu kind="mic" label="Microphone" devices={devs.mics} activeId={call.micDeviceId} open={menu === 'mic'} setOpen={setMenu} onPick={call.switchMic} portalTarget={target} />
      </span>
      <span className="kw-ic-wrap kw-dev-wrap">
        <button
          className={`kw-ic${call.camOn ? '' : ' off'}`}
          onClick={() => void call.toggleCam()}
          aria-label={call.camOn ? 'Turn camera off' : 'Turn camera on'}
          title={call.camOn ? 'Turn camera off (V)' : 'Turn camera on (V)'}
        >
          {call.camOn ? <VideoIcon /> : <VideoOffIcon />}
        </button>
        <DevMenu kind="cam" label="Camera" devices={devs.cams} activeId={call.camDeviceId} open={menu === 'cam'} setOpen={setMenu} onPick={call.switchCam} portalTarget={target} />
      </span>
      {call.camOn && (canTouch || call.canFlip) && (
        <button
          className="kw-ic"
          onClick={() => void call.flipCam()}
          aria-label="Flip camera (front/back)"
          title="Switch front/back camera"
        >
          <FlipCamIcon />
        </button>
      )}
      <span className="kw-ic-wrap kw-dev-wrap">
        <button
          className={`kw-ic${deaf ? ' off' : ''}`}
          onClick={() => setDeaf((d) => !d)}
          aria-label={deaf ? 'Turn speaker on — hear others' : 'Turn speaker off — mute everyone for you'}
          title={deaf ? 'Speaker off — tap to hear others' : 'Mute everyone (speaker off)'}
        >
          {deaf ? <SpeakerOffIcon /> : <SpeakerIcon />}
        </button>
        {CAN_PICK_SPEAKER && (
          <DevMenu kind="spk" label="Speaker" devices={devs.spks} activeId={call.speakerId} open={menu === 'spk'} setOpen={setMenu} onPick={call.setSpeaker} align="end" portalTarget={target} />
        )}
      </span>
    </>
  )
}
