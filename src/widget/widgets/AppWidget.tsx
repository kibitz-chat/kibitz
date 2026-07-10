import { type CSSProperties, useEffect, useRef, useState } from 'react'
import type { WidgetRenderProps } from './types'
import { type AppData, clampAppHeight, safeAppPayload } from './app'

// The sandbox: scripts to run the UI, popups+forms for normal interaction — but NOT allow-same-origin (so the
// frame gets an OPAQUE origin and can't reach the parent), NOT allow-top-navigation (can't hijack the tab),
// NOT allow-modals/downloads. Matches docs/widget-security.md.
const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms'

/** kbz.app (OPEN tier) renderer — a sandboxed iframe + a narrow, validated postMessage bridge. The frame may
 *  ask to resize or emit a typed `event` (which rides wevt via onEvent); it CANNOT call tools or post chat. */
export default function AppWidget({ data, fill, onEvent }: WidgetRenderProps<AppData>) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(data.height)

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Gate 1: it must come from THIS iframe's window. Gate 2: opaque origin (the sandbox forces 'null' for
      // both url + html mode). Together these prove it's our sandboxed frame and nothing else.
      if (!ref.current || e.source !== ref.current.contentWindow || e.origin !== 'null') return
      const m = e.data
      if (!m || typeof m !== 'object' || (m as { __kbzApp?: unknown }).__kbzApp !== true) return
      const t = (m as { t?: unknown }).t
      if (t === 'resize') {
        const h = clampAppHeight((m as { height?: unknown }).height)
        if (h != null) setHeight(h)
      } else if (t === 'event') {
        onEvent?.({ t: 'app', payload: safeAppPayload((m as { payload?: unknown }).payload) })
      }
      // 'ready' / anything else: ignored. The skeleton exposes NO init context + NO tool/chat capability.
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onEvent])

  const frameProps = {
    ref,
    title: data.title || 'App',
    sandbox: SANDBOX,
    referrerPolicy: 'no-referrer' as const,
    loading: 'lazy' as const,
    style: { ...frame, height: fill ? '100%' : height },
  }
  return (
    <div style={{ ...wrap, maxWidth: fill ? '100%' : 'min(380px, 100%)' }}>
      <div style={bar}>
        <span>🔒 {data.title || 'External app'}</span>
        <span style={badge}>sandboxed</span>
      </div>
      {data.mode === 'url' ? <iframe {...frameProps} src={data.src} /> : <iframe {...frameProps} srcDoc={data.src} />}
    </div>
  )
}

const wrap: CSSProperties = { display: 'flex', flexDirection: 'column', width: '100%', borderRadius: 12, overflow: 'hidden', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,.25)' }
const bar: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 11px', font: '600 12px/1.3 system-ui, sans-serif', color: '#1a1a1a', background: '#f1f4f9', borderBottom: '1px solid #e3e8f0' }
const badge: CSSProperties = { font: '600 10px/1 system-ui, sans-serif', color: '#7a8699', textTransform: 'uppercase', letterSpacing: 0.5 }
const frame: CSSProperties = { width: '100%', border: 'none', display: 'block', background: '#fff' }
