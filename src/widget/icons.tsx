// Inline SVG icon set for the call widget — extracted verbatim from Widget.tsx so child panels can import the
// icons they need (e.g. ShieldIcon for VerifyPanel). Pure presentational; svgProps is the shared stroke style.

const svgProps = {
  viewBox: '0 0 24 24',
  width: 15,
  height: 15,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

// Participant count (the top-left in-call chip): the feather "users" glyph.
export const PeopleIcon = () => (
  <svg {...svgProps}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
)
export const MicIcon = () => (
  <svg {...svgProps}>
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
)
export const MicOffIcon = () => (
  <svg {...svgProps}>
    <line x1="1" y1="1" x2="23" y2="23" />
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
)
export const VideoIcon = () => (
  <svg {...svgProps}>
    <polygon points="23 7 16 12 23 17 23 7" />
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
  </svg>
)
export const VideoOffIcon = () => (
  <svg {...svgProps}>
    <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
)
// The conventional chain-link glyph = "copy link". (Not ⧉, which is the pop-out
// and reads as "new window/duplicate".)
export const LinkIcon = () => (
  <svg {...svgProps}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
)
export const QrIcon = () => (
  <svg viewBox="0 0 24 24" width={15} height={15} aria-hidden="true">
    {/* three finder squares (corners) — the unmistakable QR signature, distinct from a 2×2 grid */}
    <g fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="3" width="6" height="6" rx="1" />
      <rect x="3" y="15" width="6" height="6" rx="1" />
    </g>
    {/* filled centres + scattered data modules in the fourth corner */}
    <g fill="currentColor">
      <rect x="5" y="5" width="2" height="2" />
      <rect x="17" y="5" width="2" height="2" />
      <rect x="5" y="17" width="2" height="2" />
      <rect x="14" y="14" width="3" height="3" />
      <rect x="19" y="14" width="2" height="2" />
      <rect x="14" y="19" width="2" height="2" />
      <rect x="19" y="18" width="2" height="3" />
    </g>
  </svg>
)
export const CheckIcon = () => (
  <svg {...svgProps}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
)
// Clock — "Recent rooms" (a face with hands).
export const ClockIcon = () => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="9" />
    <polyline points="12 7 12 12 15.5 14" />
  </svg>
)
// Clipboard — "Paste link & join" (a board with a clip tab).
export const ClipboardIcon = () => (
  <svg {...svgProps}>
    <rect x="5" y="5" width="14" height="16" rx="2" />
    <rect x="9" y="3" width="6" height="4" rx="1" />
  </svg>
)
export const ChatIcon = () => (
  <svg {...svgProps}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)
// The WhatsApp mark — a FILLED glyph (fill:currentColor), so it shows white on the green WhatsApp button.
export const WhatsAppIcon = () => (
  <svg viewBox="0 0 24 24" width={15} height={15} fill="currentColor" aria-hidden="true">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.297-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
  </svg>
)
// "Share…" — the OS share sheet: a tray with an arrow lifting out of it (the iOS/Android share glyph).
export const ShareIcon = () => (
  <svg {...svgProps}>
    <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
    <polyline points="16 6 12 2 8 6" />
    <line x1="12" y1="2" x2="12" y2="15" />
  </svg>
)
// A shield with a check — "verify this call is private" (the safety-code panel).
export const ShieldIcon = () => (
  <svg {...svgProps}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <polyline points="9 12 11 14 14 9" />
  </svg>
)
// Host tools — "who's in the room" (waiting room, lock). A two-person glyph, distinct from the
// verify shield, so the host's admission controls read clearly.
export const HostIcon = () => (
  <svg {...svgProps}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19.5c0-3 2.4-5 5.5-5s5.5 2 5.5 5" />
    <path d="M16.6 5.2a3.2 3.2 0 0 1 0 5.6" />
    <path d="M17.6 19.5c0-2.3-1-4-2.6-4.9" />
  </svg>
)
// Corner arrows pointing OUT — enter full screen (the touch alternative to drag-resize).
export const MaximizeIcon = () => (
  <svg {...svgProps}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3" />
  </svg>
)
// Corner arrows pointing IN — exit full screen.
export const MinimizeIcon = () => (
  <svg {...svgProps}>
    <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3m8 0v-3a2 2 0 0 1 2-2h3" />
  </svg>
)
// Filled rounded square — "stop showing on stage" (an SVG so it renders identically on every device, unlike ⏹).
export const StopIcon = () => (
  <svg viewBox="0 0 24 24" width={15} height={15} fill="currentColor" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
  </svg>
)
export const SpeakerIcon = () => (
  <svg {...svgProps}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
)
export const SpeakerOffIcon = () => (
  <svg {...svgProps}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <line x1="23" y1="9" x2="17" y2="15" />
    <line x1="17" y1="9" x2="23" y2="15" />
  </svg>
)
// Switch/forward camera — a camera body with a rotating circle (a circular arrow) inside the lens.
export const FlipCamIcon = () => (
  <svg {...svgProps}>
    <path d="M20 5h-3.2L15 3H9L7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" />
    <g transform="translate(12 13) scale(0.44) translate(-12 -12)">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" vectorEffect="non-scaling-stroke" />
      <polyline points="21 3 21 9 15 9" vectorEffect="non-scaling-stroke" />
    </g>
  </svg>
)
export const CloseIcon = () => (
  <svg {...svgProps}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)
