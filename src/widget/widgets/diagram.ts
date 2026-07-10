// kbz.diagram — Mermaid source (flowchart, sequence, gantt, etc.). Mermaid renders to SVG; safety comes from
// securityLevel:'strict' at render time (no embedded HTML, no click handlers, sanitized output). Here we just
// bound the source length + accept a string or { source } / { mermaid }.
import { stripDangerousHtml } from './sanitizeHtml'
import type { WidgetExport } from './types'

export interface DiagramData {
  source: string
}

const MAX = 10000

export function sanitizeDiagram(raw: unknown): DiagramData | null {
  const src =
    typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object'
        ? (typeof (raw as Record<string, unknown>).source === 'string' && (raw as Record<string, unknown>).source) ||
          (typeof (raw as Record<string, unknown>).mermaid === 'string' && (raw as Record<string, unknown>).mermaid) ||
          (typeof (raw as Record<string, unknown>).diagram === 'string' && (raw as Record<string, unknown>).diagram)
        : null
  if (typeof src !== 'string' || !src.trim()) return null
  return { source: src.slice(0, MAX) }
}

let expSeq = 0
/** kbz.diagram → SVG. Renders the Mermaid source exactly as the widget does (securityLevel:'strict' → sanitized
 *  SVG, then stripDangerousHtml as a 2nd layer), with Mermaid lazy-imported INSIDE so it stays out of the eager
 *  sanitize path. Browser-only; returns null on failure → saveWidget falls back to JSON. */
export async function exportDiagramSvg(data: DiagramData): Promise<WidgetExport | null> {
  if (typeof document === 'undefined') return null
  try {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: 'system-ui, sans-serif' })
    const { svg } = await mermaid.render(`kbz-mmd-exp-${expSeq++}`, data.source)
    return { blob: new Blob([stripDangerousHtml(svg)], { type: 'image/svg+xml;charset=utf-8' }), base: 'diagram', ext: 'svg' }
  } catch {
    return null
  }
}
