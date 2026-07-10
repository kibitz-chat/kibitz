import { type CSSProperties, useState } from 'react'
import type { WidgetRenderProps } from './types'
import type { MediaData } from './media'

/** kbz.media renderer — an allowlisted image/video/audio with an optional caption. The URL was host-allowlisted
 *  in sanitizeMedia (the only safe gate for agent-supplied media). It may still FAIL to render here even past that
 *  gate (a dead link, CORS, a non-decodable asset) — so on error show a clean placeholder instead of a broken
 *  <img>, and emit `media-error` so the POSTING agent learns its asset didn't render (→ it can apologize / retract
 *  rather than insist it shared a picture). */
export default function MediaWidget({ data, fill, onEvent }: WidgetRenderProps<MediaData>) {
  const [failed, setFailed] = useState(false)
  const onErr = () => {
    if (failed) return
    setFailed(true)
    onEvent?.({ type: 'media-error', mediaType: data.type, url: data.url })
  }
  if (failed)
    return (
      <div style={{ ...wrap, ...errBox, maxWidth: fill ? '100%' : 'min(360px, 100%)' }}>
        🚫 Couldn’t load this {data.type || 'image'}
        {data.caption ? ` — “${data.caption}”` : ''}.
      </div>
    )
  const media =
    data.type === 'video' ? (
      <video src={data.url} poster={data.poster} controls playsInline preload="metadata" style={el} onError={onErr} />
    ) : data.type === 'audio' ? (
      <audio src={data.url} controls preload="metadata" style={{ width: '100%' }} onError={onErr} />
    ) : (
      <img src={data.url} alt={data.caption || 'shared media'} loading="lazy" style={el} onError={onErr} />
    )
  return (
    <div style={{ ...wrap, maxWidth: fill ? '100%' : 'min(360px, 100%)' }}>
      {media}
      {data.caption && <div style={cap}>{data.caption}</div>}
    </div>
  )
}

const wrap: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', minWidth: 0 }
const el: CSSProperties = { maxWidth: '100%', maxHeight: '100%', borderRadius: 10, background: '#000', objectFit: 'contain' }
const cap: CSSProperties = { font: '400 12px/1.4 system-ui, sans-serif', opacity: 0.75, marginTop: 6, textAlign: 'center' }
const errBox: CSSProperties = {
  font: '400 12px/1.4 system-ui, sans-serif',
  opacity: 0.7,
  padding: '14px 12px',
  borderRadius: 10,
  border: '1px dashed rgba(255,255,255,0.25)',
  textAlign: 'center',
}
