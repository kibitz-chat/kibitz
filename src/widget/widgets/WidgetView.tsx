import { type ComponentType, type CSSProperties, useEffect, useState } from 'react'
import { getWidgetKind } from './registry'
import type { WidgetRenderProps } from './types'

/** Lazily resolve + render a registered widget kind. The renderer (Table/Doc/Media/Chart/…) is dynamically
 *  imported on first use, so heavy renderers never enter the base bundle. Unknown kind → nothing. */
export function WidgetView({ kind, data, fill, onEvent }: { kind: string; data: unknown; fill?: boolean; onEvent?: (e: unknown) => void }) {
  const spec = getWidgetKind(kind)
  const [Comp, setComp] = useState<ComponentType<WidgetRenderProps> | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!spec) return
    let alive = true
    spec
      .load()
      .then((m) => alive && setComp(() => m.default as ComponentType<WidgetRenderProps>))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [spec])
  if (!spec) return null
  if (failed) return <div style={msg}>Couldn’t load this widget.</div>
  if (!Comp) return <div style={msg}>Loading…</div>
  return <Comp data={data} fill={fill} onEvent={onEvent} />
}

const msg: CSSProperties = { font: '12px/1.4 system-ui, sans-serif', opacity: 0.6, padding: 8 }
