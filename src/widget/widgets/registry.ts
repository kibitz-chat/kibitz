import type { WidgetKind } from './types'
import { sanitizeTable, exportTableCsv } from './table'
import { sanitizeDoc, exportDocHtml } from './doc'
import { sanitizeMedia, exportMedia } from './media'
import { sanitizeForm } from './form'
import { sanitizeChart, exportChartSvg } from './chart'
import { sanitizeDiagram, exportDiagramSvg } from './diagram'
import { appTierEnabled, sanitizeApp } from './app'

// The kind → renderer registry. Sanitizers are eager (small, no heavy imports); renderers are lazy-imported on
// first use. The MAP keeps its own bespoke path in Widget.tsx (pins/lockstep/stage) and is NOT registered here.
const REGISTRY = new Map<string, WidgetKind<unknown>>()
export function registerWidget<T>(w: WidgetKind<T>): void {
  REGISTRY.set(w.kind, w as unknown as WidgetKind<unknown>)
}
export const getWidgetKind = (kind: string): WidgetKind<unknown> | undefined => REGISTRY.get(kind)
export const hasWidgetKind = (kind: string): boolean => REGISTRY.has(kind)
export const widgetKinds = (): readonly string[] => [...REGISTRY.keys()]

// exportFile = save the widget AS ITSELF (native artifact). A form has no native artifact ⇒ no exportFile ⇒
// saveWidget falls back to the {kind,data} JSON. Heavy engines (Vega/Mermaid) are lazy-imported inside the export.
registerWidget({ kind: 'kbz.table', sanitize: sanitizeTable, load: () => import('./TableWidget'), exportFile: exportTableCsv })
registerWidget({ kind: 'kbz.doc', sanitize: sanitizeDoc, load: () => import('./DocWidget'), exportFile: exportDocHtml })
registerWidget({ kind: 'kbz.media', sanitize: sanitizeMedia, load: () => import('./MediaWidget'), exportFile: exportMedia })
registerWidget({ kind: 'kbz.form', sanitize: sanitizeForm, load: () => import('./FormWidget'), interactive: true })
registerWidget({ kind: 'kbz.chart', sanitize: sanitizeChart, load: () => import('./ChartWidget'), exportFile: exportChartSvg })
registerWidget({ kind: 'kbz.diagram', sanitize: sanitizeDiagram, load: () => import('./DiagramWidget'), exportFile: exportDiagramSvg })

// OPEN tier (kbz.app, sandboxed third-party UI) — registered ONLY when a build explicitly allowlists app
// origins / enables raw html (VITE_WIDGET_APP_*). Default build: not registered ⇒ the kind is unknown + inert.
if (appTierEnabled()) registerWidget({ kind: 'kbz.app', sanitize: (raw) => sanitizeApp(raw), load: () => import('./AppWidget'), interactive: true })
