import { type CSSProperties, useEffect, useRef, useState } from 'react'
import vegaEmbed, { type Result } from 'vega-embed'
import type { WidgetRenderProps } from './types'
import type { ChartData } from './chart'

/** kbz.chart renderer — embeds a (URL-stripped) Vega-Lite spec. actions:false hides the export menu; the spec
 *  carries no external data (sanitized), so nothing is fetched. width:'container' makes it responsive. */
export default function ChartWidget({ data, fill }: WidgetRenderProps<ChartData>) {
  const ref = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!ref.current) return
    let result: Result | undefined
    let alive = true
    const spec = { background: 'white', ...data.spec, width: 'container' as const, autosize: { type: 'fit', contains: 'padding' } as const }
    vegaEmbed(ref.current, spec as Parameters<typeof vegaEmbed>[1], { actions: false, mode: 'vega-lite', renderer: 'svg' })
      .then((r) => {
        if (alive) result = r
        else r.finalize()
      })
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
      result?.finalize()
    }
  }, [data])
  if (failed) return <div style={msg}>Couldn’t render this chart.</div>
  return <div ref={ref} style={{ ...wrap, width: fill ? '100%' : 'min(360px, 100%)', maxWidth: '100%', height: fill ? '100%' : undefined }} />
}

const wrap: CSSProperties = { background: '#fff', borderRadius: 12, padding: 12, boxShadow: '0 1px 4px rgba(0,0,0,.25)', overflow: 'auto', minWidth: 0, minHeight: 160 }
const msg: CSSProperties = { font: '12px/1.4 system-ui, sans-serif', opacity: 0.6, padding: 12, background: '#fff', borderRadius: 12, color: '#1a1a1a' }
