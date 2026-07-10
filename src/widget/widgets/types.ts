/**
 * Bounded widget KINDS — a registry-driven family (docs/map-widget.md generalized). Each kind has a small,
 * EAGER `sanitize` (validates an untrusted agent payload at the receive boundary — never trust the data) and a
 * LAZY `load` (the renderer component, dynamically imported only when a widget of that kind actually arrives, so
 * heavy renderers like Vega/Mermaid never bloat the base bundle). The `widget`/`wevt` transport, stage, lockstep
 * and replay are all kind-agnostic — a kind is just a schema + a sanitizer + a renderer.
 */
import type { ComponentType } from 'react'

/** Props every widget renderer receives. `onEvent` is the interaction back-channel (e.g. a form submit, a row
 *  click) — it rides the `wevt` channel and reaches the posting agent via onWidgetTap. */
export interface WidgetRenderProps<T = unknown> {
  data: T
  /** Fill the parent (the stage) vs the compact chat-card size. */
  fill?: boolean
  /** Emit an interaction back to peers + the agent (the renderer defines the event shape). */
  onEvent?: (e: unknown) => void
}

/** A native file produced by a widget's export — a blob + a base filename (no extension; saveWidget adds the
 *  per-format extension + a short id). Lets a widget be saved AS ITSELF (a chart as .svg, a table as .csv) rather
 *  than as the {kind,data} JSON. */
export interface WidgetExport {
  blob: Blob
  /** Suggested base name WITHOUT extension (e.g. the widget title, slugified). saveWidget appends `.<ext>`. */
  base: string
  /** The file extension (no dot) — 'csv', 'svg', 'html', … */
  ext: string
}

/** A registered widget kind. `sanitize` returns null when the payload isn't usable (the widget is then ignored). */
export interface WidgetKind<T = unknown> {
  /** The wire `kind` (e.g. 'kbz.table'). */
  kind: string
  /** Validate + normalize an untrusted payload. Small + eager (no heavy imports here). */
  sanitize: (raw: unknown) => T | null
  /** Lazily import the renderer (heavy deps stay out of the base bundle). */
  load: () => Promise<{ default: ComponentType<WidgetRenderProps<T>> }>
  /** Whether this kind is interactive (emits via onEvent) — informational. */
  interactive?: boolean
  /** Export this widget AS ITSELF — a native artifact (table→CSV, chart→SVG, doc→HTML, …) instead of the
   *  {kind,data} JSON. Async: a rendered kind (chart/diagram) re-renders to SVG, lazy-importing its heavy engine
   *  INSIDE the function so the eager sanitize path stays light. Returns null when export isn't possible (then
   *  saveWidget falls back to JSON — e.g. an interactive form has no native artifact). */
  exportFile?: (data: T) => Promise<WidgetExport | null>
}
