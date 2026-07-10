import { getWidgetKind } from './widgets/registry'
import { MAP_WIDGET_KIND, type MapData } from './mapWidget'
import type { WidgetExport } from './widgets/types'

/** Trigger a browser download of `blob` named `name`; the object URL is revoked after the click (no leak). */
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** A filesystem-safe base name (collapse junk, trim, cap). */
const slug = (s: string): string => s.replace(/[^a-z0-9._-]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'widget'

/** kbz.map → a GeoJSON FeatureCollection (markers→Point, line→LineString, polygon→Polygon). Coordinates are
 *  [lng, lat] per the GeoJSON spec — the map AS ITSELF, openable in any GIS tool / geojson.io. The map keeps its
 *  bespoke path (it isn't in the kind registry), so its exporter lives here next to saveWidget. */
export function mapToGeoJson(data: MapData): WidgetExport {
  const features: unknown[] = []
  for (const mk of data.markers ?? []) {
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [mk.lng, mk.lat] }, properties: mk.label ? { label: mk.label } : {} })
  }
  for (const sh of data.shapes ?? []) {
    const props: Record<string, unknown> = {}
    if (sh.label) props.label = sh.label
    if (sh.color) props.color = sh.color
    const geometry =
      sh.type === 'line'
        ? { type: 'LineString', coordinates: (sh.rings[0] ?? []).map((p) => [p.lng, p.lat]) }
        : { type: 'Polygon', coordinates: sh.rings.map((ring) => ring.map((p) => [p.lng, p.lat])) }
    features.push({ type: 'Feature', geometry, properties: props })
  }
  const fc = { type: 'FeatureCollection', features }
  return { blob: new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' }), base: data.title || 'map', ext: 'geojson' }
}

/** Save a widget AS ITSELF — the kind's native artifact (table→CSV, chart→SVG, diagram→SVG, doc→HTML, map→GeoJSON,
 *  media→the file). Falls back to the portable {kind,data} JSON only when a kind has no native export (an
 *  interactive form) or its export fails (a chart render error, a CORS-blocked media fetch). Async — a rendered
 *  kind re-renders to SVG. Shared by the in-chat WidgetBubble and the on-stage StagedWidget bar. */
export async function saveWidget(kind: string, id: string, data: unknown): Promise<void> {
  try {
    const out: WidgetExport | null = kind === MAP_WIDGET_KIND ? mapToGeoJson(data as MapData) : ((await getWidgetKind(kind)?.exportFile?.(data)) ?? null)
    if (out) {
      download(out.blob, `${slug(out.base)}-${id.slice(0, 8)}.${out.ext}`)
      return
    }
  } catch {
    /* native export failed → fall through to the JSON */
  }
  // Fallback: the portable {kind,data} JSON (re-importable; the only option for an interactive form).
  try {
    download(new Blob([JSON.stringify({ kind, data }, null, 2)], { type: 'application/json' }), `${slug(kind)}-${id.slice(0, 8)}.json`)
  } catch {
    /* download blocked (sandbox / no DOM) — no-op */
  }
}
