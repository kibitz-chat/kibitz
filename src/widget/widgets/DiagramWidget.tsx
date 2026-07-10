import { type CSSProperties, useEffect, useState } from 'react'
import mermaid from 'mermaid'
import type { WidgetRenderProps } from './types'
import type { DiagramData } from './diagram'
import { stripDangerousHtml } from './sanitizeHtml'

// Initialise ONCE, in STRICT security mode (sanitizes the SVG: no embedded HTML/scripts, no click handlers).
let inited = false
function ensureInit() {
  if (inited) return
  inited = true
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: 'system-ui, sans-serif' })
}

let seq = 0

/** kbz.diagram renderer — Mermaid source → sanitized SVG (strict mode). The SVG is mermaid's own strict output,
 *  so dangerouslySetInnerHTML is the intended API. */
export default function DiagramWidget({ data, fill }: WidgetRenderProps<DiagramData>) {
  const [svg, setSvg] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    ensureInit()
    let alive = true
    const id = `kbz-mmd-${seq++}`
    mermaid
      .render(id, data.source)
      .then((r) => alive && setSvg(stripDangerousHtml(r.svg))) // 2nd layer over Mermaid's strict mode
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [data])
  if (failed) return <div style={msg}>Couldn’t render this diagram.</div>
  if (!svg) return <div style={msg}>Drawing…</div>
  return <div style={{ ...wrap, maxWidth: fill ? '100%' : 'min(360px, 100%)' }} dangerouslySetInnerHTML={{ __html: svg }} />
}

const wrap: CSSProperties = { background: '#fff', borderRadius: 12, padding: 14, boxShadow: '0 1px 4px rgba(0,0,0,.25)', overflow: 'auto', minWidth: 0, display: 'flex', justifyContent: 'center' }
const msg: CSSProperties = { font: '12px/1.4 system-ui, sans-serif', opacity: 0.6, padding: 12, background: '#fff', borderRadius: 12, color: '#1a1a1a' }
