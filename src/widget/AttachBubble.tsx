import { MediaBubble } from './MediaBubble'
import type { Attachment, CallController } from '../react/useCall'

/** Human-readable byte size for a file-attachment chip (e.g. 1.4 MB). */
const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Renders one chat ATTACHMENT (a file/image/video/audio transfer) in every state: failed/cancelled, a >1GB pull-
// download offer (accept & save), streamed-straight-to-disk, an in-page media bubble (image/video/audio), a plain
// file chip, and in-flight progress (with a cancel ✕). Lifted from Widget.tsx's renderAttach render-helper into a
// real component with EXPLICIT props (it used to close over call/deaf/preview/presentMedia); fmtBytes moved along.
// No hooks → the multiple early returns are fine. kw-att-* / kw-msg-* classes are global — keep verbatim.
export function AttachBubble({
  a,
  call,
  deaf,
  preview,
  presentMedia,
}: {
  a: Attachment
  call: CallController
  deaf: boolean
  preview: boolean
  presentMedia: (src: string, key: string, playable: boolean) => void | Promise<void>
}) {
  const pct = Math.round(a.progress * 100)
  // A ✕ to stop an in-flight transfer — works on BOTH sides (sender stops streaming, receiver drops the
  // partial), since call.cancelTransfer is direction-agnostic. Shown only while 'active'.
  const cancelBtn = (
    <button type="button" className="kw-att-cancel" aria-label="Cancel transfer" title="Cancel transfer" onClick={() => call.cancelTransfer(a.xid)}>
      ✕
    </button>
  )
  if (a.state === 'failed') return <span className="kw-att kw-att-failed">{a.kind === 'image' ? '🖼️' : '📄'} {a.name || a.kind} — {a.reason ? a.reason : 'transfer failed'}</span>
  if (a.state === 'cancelled') return <span className="kw-att kw-att-failed">{a.kind === 'image' ? '🖼️' : '📄'} {a.name || a.kind} — cancelled</span>
  // A >1GB pull-download OFFER: the sender holds it until we pick a save location. "Accept & save" opens the
  // OS save dialog (the gesture the browser requires), then it streams straight to that file.
  if (a.state === 'offered')
    return (
      <span className="kw-att kw-att-offer">
        📄 <span className="kw-att-name">{a.name || 'file'}</span> <span className="kw-att-size">({fmtBytes(a.size)})</span>
        {' · '}
        <button type="button" className="kw-att-accept" onClick={() => void call.acceptTransfer(a.xid)}>
          Accept &amp; save
        </button>
        <button type="button" className="kw-att-decline" aria-label="Decline" onClick={() => call.declineTransfer(a.xid)}>
          ✕
        </button>
      </span>
    )
  // Streamed straight to the user's disk (download tier) — no in-page preview to offer.
  if (a.state === 'done' && a.saved)
    return (
      <span className="kw-att kw-att-file">
        📄 <span className="kw-att-name">{a.name || 'file'}</span> <span className="kw-att-size">({fmtBytes(a.size)})</span> · ✓ Saved to disk
      </span>
    )
  // Video/audio ride as a 'file' kind but with a video/* or audio/* mime → render them as a playable
  // <video>/<audio>, like an image. mediaKind null → a plain file chip.
  const mediaKind: 'image' | 'video' | 'audio' | null = a.kind === 'image' ? 'image' : /^video\//i.test(a.mime || '') ? 'video' : /^audio\//i.test(a.mime || '') ? 'audio' : null
  if (a.state === 'done' && a.url && mediaKind) return <MediaBubble keyId={a.xid} src={a.url} name={a.name} kind={mediaKind} deaf={deaf} preview={preview} inCall={call.inCall} presentMedia={presentMedia} />
  if (mediaKind) {
    const icon = mediaKind === 'video' ? '🎬' : mediaKind === 'audio' ? '🎵' : '🖼️'
    return (
      <span className="kw-att kw-att-prog">
        {icon} {a.name || mediaKind} · {pct}%<span className="kw-att-bar" style={{ ['--p' as string]: `${pct}%` }} />
        {a.state === 'active' ? <>{' '}{cancelBtn}</> : null}
      </span>
    )
  }
  // file — done: render like a media bubble (a box + a Save action below, same width + hover/touch reveal).
  if (a.state === 'done' && a.url)
    return (
      <span className="kw-msg-img-wrap">
        <span className="kw-msg-filebox">
          📄 <span className="kw-att-name">{a.name || 'file'}</span> <span className="kw-att-size">({fmtBytes(a.size)})</span>
        </span>
        <span className="kw-msg-img-acts" role="menu">
          <a href={a.url} download={a.name || 'file'}>💾 Save</a>
        </span>
      </span>
    )
  // file — in flight: a progress chip.
  return (
    <span className="kw-att kw-att-file">
      📄 <span className="kw-att-name">{a.name || 'file'}</span> <span className="kw-att-size">({fmtBytes(a.size)})</span>
      {' · '}
      {pct}%<span className="kw-att-bar" style={{ ['--p' as string]: `${pct}%` }} />
      {a.state === 'active' ? <>{' '}{cancelBtn}</> : null}
    </span>
  )
}
