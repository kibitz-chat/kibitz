// kbz.chart — a Vega-Lite spec. The security crux: a spec can pull EXTERNAL DATA (`data.url`, dataset urls,
// transform-lookup urls) → SSRF. We deep-sanitize: drop every `url` key (inline `data.values` only), cap depth +
// node count + serialized size, and strip functions. Vega-Lite has no JS eval (its expression language can't
// reach network/DOM), so with external loads removed the spec is safe to render.
import type { WidgetExport } from './types'

export interface ChartData {
  spec: Record<string, unknown>
}

const MAX_DEPTH = 12
const MAX_NODES = 20000
const MAX_BYTES = 200000

/** Deep-clone a JSON value, dropping `url` keys (SSRF) + functions, bounding depth/size. */
function clean(value: unknown, depth: number, budget: { n: number }): unknown {
  if (budget.n++ > MAX_NODES || depth > MAX_DEPTH) return undefined
  if (value == null) return value
  const t = typeof value
  if (t === 'string') return (value as string).slice(0, 20000)
  if (t === 'number' || t === 'boolean') return value
  if (t === 'function' || t === 'symbol' || t === 'bigint') return undefined
  if (Array.isArray(value)) return value.slice(0, 5000).map((v) => clean(v, depth + 1, budget))
  if (t === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'url' || k === 'loader') continue // block external data loading
      const cv = clean(v, depth + 1, budget)
      if (cv !== undefined) out[k] = cv
    }
    return out
  }
  return undefined
}

export function sanitizeChart(raw: unknown): ChartData | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const specIn = r.spec && typeof r.spec === 'object' ? r.spec : r
  const spec = clean(specIn, 0, { n: 0 }) as Record<string, unknown> | undefined
  if (!spec || typeof spec !== 'object') return null
  // Must look like a chart: a mark (or layered/faceted spec) + something to plot.
  const looksLikeChart = 'mark' in spec || 'layer' in spec || 'facet' in spec || 'hconcat' in spec || 'vconcat' in spec || 'repeat' in spec
  if (!looksLikeChart) return null
  if (JSON.stringify(spec).length > MAX_BYTES) return null
  return { spec }
}

/** kbz.chart → SVG. Re-renders the sanitized (URL-stripped) Vega-Lite spec headlessly via vega-embed — lazy-
 *  imported INSIDE so Vega stays out of the eager sanitize path — then view.toSVG() yields a vector file. Browser
 *  only (the embed builds into a detached container); returns null on failure → saveWidget falls back to JSON. */
export async function exportChartSvg(data: ChartData): Promise<WidgetExport | null> {
  if (typeof document === 'undefined') return null
  try {
    const { default: vegaEmbed } = await import('vega-embed')
    const host = document.createElement('div')
    const spec = { background: 'white', ...data.spec, width: 640, height: 400 }
    const r = await vegaEmbed(host, spec as Parameters<typeof vegaEmbed>[1], { actions: false, mode: 'vega-lite', renderer: 'svg' })
    const svg = await r.view.toSVG()
    r.finalize()
    const t = data.spec.title
    const base = typeof t === 'string' && t.trim() ? t : 'chart'
    return { blob: new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), base, ext: 'svg' }
  } catch {
    return null
  }
}
