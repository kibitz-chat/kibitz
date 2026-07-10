import { AttachBubble } from './AttachBubble'
import { MediaBubble } from './MediaBubble'
import { imgDataUrl } from '../react/imageAttach'
import type { ChatItem, CallController } from '../react/useCall'

// One chat message bubble: the sender label (You / You → name / their name, with a "· private" tag on DMs) and the
// body — a file/transfer attachment, an inline image, or plain text. A blank bubble (an agent reply stripped to
// only a cue like [done]) is skipped. Extracted from Widget.tsx's chat-log map; the attachment/image bodies are
// now their own components (AttachBubble / MediaBubble). No hooks → the early null return is fine. Global classes.
export function ChatMessage({
  m,
  call,
  deaf,
  preview,
  presentMedia,
}: {
  m: ChatItem
  call: CallController
  deaf: boolean
  preview: boolean
  presentMedia: (src: string, key: string, playable: boolean) => void | Promise<void>
}) {
  // Never render a BLANK bubble — an agent reply stripped to only a cue ([done]/marker) leaves
  // empty text, which showed as an empty "Name ·" card. Skip it entirely.
  if (!m.attachment && !m.image && !(m.text && m.text.trim())) return null
  return (
    <div className={`kw-msg${m.self ? ' self' : ''}${m.dm ? ' dm' : ''}`}>
      <span className="kw-msg-name" dir="auto">
        {m.self ? (m.dm && m.to ? `You → ${m.to}` : 'You') : m.name}
        {m.dm && !m.self && <span className="kw-msg-priv"> · private</span>}
      </span>
      {m.attachment ? (
        <AttachBubble a={m.attachment} call={call} deaf={deaf} preview={preview} presentMedia={presentMedia} />
      ) : m.image ? (
        <MediaBubble keyId={String(m.id)} src={imgDataUrl(m.image)} name={m.image.name} kind="image" deaf={deaf} preview={preview} inCall={call.inCall} presentMedia={presentMedia} />
      ) : (
        <span className="kw-msg-text" dir="auto">{m.text}</span>
      )}
    </div>
  )
}
