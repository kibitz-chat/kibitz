/**
 * Bounded MAP widget — the FIRST-PARTY renderer's data model + pure Web-Mercator / slippy-tile math.
 *
 * This is the "bounded generative UI" model (docs/map-widget.md): an agent posts a typed `MapData` payload
 * (NEVER code), and this renderer — which ships in our own bundle — draws it. So a third-party-authored agent
 * can only hand us validated data; it can't run anything. The math here is a tiny self-contained slippy-map
 * implementation (no Leaflet/MapLibre dependency): raster tiles are plain <img>s whose URLs we compute from
 * the public {z}/{x}/{y} scheme, and markers/pins are projected to pixels. Offline (LAN hub) the tiles just
 * don't load — the markers still render on a blank canvas, so it degrades instead of breaking.
 *
 * Everything here is PURE (no DOM, no React) so it's unit-testable; MapWidget.tsx is the thin view over it.
 */

/** The reserved `kind` for a map widget on the `widget` wire channel. */
// Marker PHOTOS auto-load as <img> (an SSRF / tracking-pixel vector for an agent-supplied URL), so they go
// through the SAME strict host allowlist as the kbz.media widget — not a bare scheme check. (Marker `website`
// stays a scheme-checked, user-click link rendered rel="noopener noreferrer"; it can't be host-allowlisted
// without breaking legitimate business links, and it never auto-loads.)
import { allowedMediaUrl } from './widgets/media'

export const MAP_WIDGET_KIND = 'kbz.map'

/** A pin the agent placed on the map (part of the posted payload). Beyond the position + label, a marker may
 *  carry rich listing detail (filled by the agent or a keyless places lookup) that the renderer shows in a
 *  tap-to-expand card — photos, rating, hours, contact, the agent's own note. All optional + degrade cleanly. */
export interface MapMarker {
  lat: number
  lng: number
  /** A short name shown under the marker + as the card heading. */
  label?: string
  /** The agent's own tip for this spot ("book ahead", "closed Tuesdays"). */
  note?: string
  /** A one-line/short description of the place. */
  description?: string
  /** Photo URLs (first is shown big in the card). */
  photos?: string[]
  /** Star rating 0–5. */
  rating?: number
  /** Review count (shown next to the rating). */
  reviews?: number
  /** Opening hours, one pre-formatted string per line (e.g. "Mon: 9:00–18:45"). */
  hours?: string[]
  /** Phone number (tel: link). */
  phone?: string
  /** Official website (opened in a new tab). */
  website?: string
}

/** A normalized vector overlay — a route (line) or an area (polygon), parsed from GeoJSON at sanitize time so
 *  the renderer just projects pre-validated rings (no GeoJSON walking in the view). */
export interface GeoShape {
  type: 'line' | 'polygon'
  /** Line: one ring (the path). Polygon: outer ring first, then holes. Each point already lat/lng-clamped. */
  rings: { lat: number; lng: number }[][]
  label?: string
  /** A validated CSS colour (hex or a plain name) for stroke (+ a faint fill for polygons); else a default. */
  color?: string
}

/** The bounded payload an agent posts via `sendWidget(MAP_WIDGET_KIND, data)`. */
export interface MapData {
  /** Initial centre. */
  center: { lat: number; lng: number }
  /** Initial slippy zoom (0 world … 19 street). */
  zoom: number
  /** Agent-placed markers (read-only — distinct from the pins viewers drop). */
  markers?: MapMarker[]
  /** Vector overlays (routes/areas) parsed from a posted GeoJSON FeatureCollection. */
  shapes?: GeoShape[]
  /** Optional caption shown above the map. */
  title?: string
  /** Optional framing line shown under the title (e.g. "Ten must-see sights across central Paris"). */
  intro?: string
}

/** A pin a VIEWER dropped — the shared interaction, carried as a `wevt` event. A stable `id` makes
 *  re-application idempotent, so the owner's late-joiner replay never duplicates a pin. */
export interface MapPin {
  id: string
  lat: number
  lng: number
  /** Display name of whoever dropped it (for the tooltip). */
  by?: string
}

/** The renderer-defined event shape for the map widget's `wevt` channel. */
export type MapEvent = { t: 'pin'; pin: MapPin } | { t: 'unpin'; id: string }

const TILE = 256
/** The latitude beyond which Web Mercator diverges — the standard slippy-map clamp. */
export const MAX_LAT = 85.05112878

export const clampLat = (lat: number): number => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat))
export const clampZoom = (z: number): number => Math.max(0, Math.min(19, Math.round(z)))
/** Wrap a longitude into [-180, 180). */
export const normLng = (lng: number): number => {
  let x = ((lng + 180) % 360 + 360) % 360 - 180
  if (x === -180) x = 180
  return x
}

// ── Web-Mercator: geographic ⇄ fractional tile coordinates ──────────────────────
export const lngToTileX = (lng: number, z: number): number => ((lng + 180) / 360) * 2 ** z
export const latToTileY = (lat: number, z: number): number => {
  const r = (clampLat(lat) * Math.PI) / 180
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z
}
export const tileXToLng = (x: number, z: number): number => (x / 2 ** z) * 360 - 180
export const tileYToLat = (y: number, z: number): number => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z
  return (180 / Math.PI) * Math.atan(Math.sinh(n))
}

/** World-pixel coordinate (tile coord × tile size) at a zoom — the basis for screen projection. */
export const lngToWorldX = (lng: number, z: number): number => lngToTileX(lng, z) * TILE
export const latToWorldY = (lat: number, z: number): number => latToTileY(lat, z) * TILE

/** The current map view: where it's centred, the zoom, and the pixel size of the viewport. */
export interface MapView {
  center: { lat: number; lng: number }
  zoom: number
  width: number
  height: number
}

// ── GeoJSON → bounded shapes ────────────────────────────────────────────────────
const MAX_SHAPES = 150
const MAX_GEO_POINTS = 30000

/** A safe CSS colour: a hex code or a plain colour name (no functions/escapes). */
function safeColor(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim().slice(0, 32) : ''
  return /^#[0-9a-f]{3,8}$/i.test(s) || /^[a-z]{3,20}$/i.test(s) ? s : undefined
}
/** GeoJSON coords are [lng, lat] — validate + clamp into a geographic point. */
function geoPoint(c: unknown): { lat: number; lng: number } | null {
  if (!Array.isArray(c) || c.length < 2) return null
  const lng = Number(c[0])
  const lat = Number(c[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat: clampLat(lat), lng: normLng(lng) }
}
function geoRing(coords: unknown, budget: { n: number }): { lat: number; lng: number }[] {
  if (!Array.isArray(coords)) return []
  const out: { lat: number; lng: number }[] = []
  for (const c of coords) {
    if (budget.n++ > MAX_GEO_POINTS) break
    const p = geoPoint(c)
    if (p) out.push(p)
  }
  return out
}
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function addGeometry(geom: unknown, props: Record<string, unknown>, shapes: GeoShape[], points: { lat: number; lng: number; label?: string }[], budget: { n: number }): void {
  if (!geom || typeof geom !== 'object' || shapes.length >= MAX_SHAPES) return
  const g = geom as Record<string, unknown>
  const color = safeColor(props.color ?? props.stroke ?? props['marker-color'])
  const label = typeof (props.name ?? props.title ?? props.label) === 'string' ? String(props.name ?? props.title ?? props.label).slice(0, 120) : undefined
  const co = g.coordinates
  switch (g.type) {
    case 'Point': {
      const p = geoPoint(co)
      if (p) points.push({ ...p, label })
      break
    }
    case 'MultiPoint':
      for (const c of asArr(co)) {
        const p = geoPoint(c)
        if (p) points.push({ ...p, label })
      }
      break
    case 'LineString': {
      const r = geoRing(co, budget)
      if (r.length >= 2) shapes.push({ type: 'line', rings: [r], label, color })
      break
    }
    case 'MultiLineString':
      for (const line of asArr(co)) {
        const r = geoRing(line, budget)
        if (r.length >= 2 && shapes.length < MAX_SHAPES) shapes.push({ type: 'line', rings: [r], label, color })
      }
      break
    case 'Polygon': {
      const rings = asArr(co).map((rg) => geoRing(rg, budget)).filter((r) => r.length >= 3)
      if (rings.length) shapes.push({ type: 'polygon', rings, label, color })
      break
    }
    case 'MultiPolygon':
      for (const poly of asArr(co)) {
        const rings = asArr(poly).map((rg) => geoRing(rg, budget)).filter((r) => r.length >= 3)
        if (rings.length && shapes.length < MAX_SHAPES) shapes.push({ type: 'polygon', rings, label, color })
      }
      break
    case 'GeometryCollection':
      for (const sub of asArr(g.geometries)) addGeometry(sub, props, shapes, points, budget)
      break
  }
}

/** Parse an (untrusted) GeoJSON value into bounded shapes + standalone points. Accepts a FeatureCollection, a
 *  Feature, or a bare geometry. Caps shape + point counts so a payload can't blow up the DOM. */
export function parseGeoJson(gj: unknown): { shapes: GeoShape[]; points: { lat: number; lng: number; label?: string }[] } {
  const shapes: GeoShape[] = []
  const points: { lat: number; lng: number; label?: string }[] = []
  const budget = { n: 0 }
  if (!gj || typeof gj !== 'object') return { shapes, points }
  const g = gj as Record<string, unknown>
  if (g.type === 'FeatureCollection') {
    for (const f of asArr(g.features)) {
      if (f && typeof f === 'object') addGeometry((f as Record<string, unknown>).geometry, ((f as Record<string, unknown>).properties as Record<string, unknown>) || {}, shapes, points, budget)
    }
  } else if (g.type === 'Feature') {
    addGeometry(g.geometry, (g.properties as Record<string, unknown>) || {}, shapes, points, budget)
  } else if (typeof g.type === 'string') {
    addGeometry(g, {}, shapes, points, budget)
  }
  return { shapes, points }
}

/** Project a shape's rings to one SVG path `d` string for the current view (polygons close + fill-rule evenodd
 *  handles holes; lines stay open). */
export function shapePath(shape: GeoShape, v: MapView): string {
  return shape.rings
    .map((ring) => {
      const pts = ring.map((p) => {
        const s = geoToScreen(p.lat, p.lng, v)
        return `${s.x.toFixed(1)},${s.y.toFixed(1)}`
      })
      return pts.length ? `M${pts.join('L')}${shape.type === 'polygon' ? 'Z' : ''}` : ''
    })
    .filter(Boolean)
    .join(' ')
}

/** Project a geographic point to a pixel inside the viewport (origin = top-left). */
export function geoToScreen(lat: number, lng: number, v: MapView): { x: number; y: number } {
  const cwx = lngToWorldX(v.center.lng, v.zoom)
  const cwy = latToWorldY(v.center.lat, v.zoom)
  return {
    x: lngToWorldX(lng, v.zoom) - cwx + v.width / 2,
    y: latToWorldY(lat, v.zoom) - cwy + v.height / 2,
  }
}

/** Inverse of geoToScreen: a viewport pixel back to a geographic point (for click-to-drop-pin / pan). */
export function screenToGeo(px: number, py: number, v: MapView): { lat: number; lng: number } {
  const cwx = lngToWorldX(v.center.lng, v.zoom)
  const cwy = latToWorldY(v.center.lat, v.zoom)
  const wx = cwx + (px - v.width / 2)
  const wy = cwy + (py - v.height / 2)
  return { lat: tileYToLat(wy / TILE, v.zoom), lng: normLng(tileXToLng(wx / TILE, v.zoom)) }
}

/** One tile to render: its slippy {x,y,z} (for the URL) and its CSS offset within the viewport. */
export interface TilePlacement {
  x: number
  y: number
  z: number
  left: number
  top: number
}

/** The grid of tiles covering the viewport. Wraps horizontally (so panning across the antimeridian keeps
 *  showing map) but clips vertically (no tiles above/below the Mercator poles). */
export function tilesForView(v: MapView): TilePlacement[] {
  const z = clampZoom(v.zoom)
  const n = 2 ** z
  const originX = lngToWorldX(v.center.lng, z) - v.width / 2
  const originY = latToWorldY(v.center.lat, z) - v.height / 2
  const minTX = Math.floor(originX / TILE)
  const maxTX = Math.floor((originX + v.width) / TILE)
  const minTY = Math.floor(originY / TILE)
  const maxTY = Math.floor((originY + v.height) / TILE)
  const out: TilePlacement[] = []
  for (let ty = minTY; ty <= maxTY; ty++) {
    if (ty < 0 || ty >= n) continue
    for (let tx = minTX; tx <= maxTX; tx++) {
      out.push({ x: ((tx % n) + n) % n, y: ty, z, left: tx * TILE - originX, top: ty * TILE - originY })
    }
  }
  return out
}

/** Fill a {z}/{x}/{y} URL template for a tile. */
export const tileUrl = (template: string, t: TilePlacement): string =>
  template.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y))

/** Fold a `wevt` payload into the pin set. Idempotent on pin id, so replaying the owner's accumulated
 *  events (late join) and live events converge to the same set regardless of order/duplication. */
export function applyMapEvent(pins: readonly MapPin[], raw: unknown): MapPin[] {
  const e = raw as MapEvent | null
  if (!e || typeof e !== 'object') return [...pins]
  if (e.t === 'pin' && e.pin && typeof e.pin.id === 'string' && Number.isFinite(e.pin.lat) && Number.isFinite(e.pin.lng)) {
    const pin: MapPin = { id: e.pin.id, lat: e.pin.lat, lng: e.pin.lng, by: e.pin.by }
    return pins.some((p) => p.id === pin.id) ? pins.map((p) => (p.id === pin.id ? pin : p)) : [...pins, pin]
  }
  if (e.t === 'unpin' && typeof e.id === 'string') return pins.filter((p) => p.id !== e.id)
  return [...pins]
}

/** Validate + normalize an untrusted `MapData` payload (an agent — possibly third-party — posted it).
 *  Returns null if it isn't a usable map. Caps marker count so a payload can't blow up the DOM. */
export function sanitizeMapData(raw: unknown, maxMarkers = 200): MapData | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const c = d.center as Record<string, unknown> | undefined
  const lat = Number(c?.lat)
  const lng = Number(c?.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const str = (v: unknown, n: number): string | undefined => (typeof v === 'string' && v.trim() ? v.slice(0, n) : undefined)
  const httpUrl = (v: unknown): string | undefined => {
    const s = str(v, 500)
    return s && /^https?:\/\//i.test(s) ? s : undefined
  }
  const num = (v: unknown): number | undefined => (Number.isFinite(Number(v)) ? Number(v) : undefined)
  const markers = Array.isArray(d.markers)
    ? d.markers
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
        .map((m) => ({
          lat: Number(m.lat),
          lng: Number(m.lng),
          label: str(m.label, 120),
          note: str(m.note, 400),
          description: str(m.description, 600),
          photos: Array.isArray(m.photos) ? m.photos.map((p) => allowedMediaUrl(p)).filter((p): p is string => !!p).slice(0, 6) : undefined,
          rating: num(m.rating) !== undefined ? Math.max(0, Math.min(5, num(m.rating)!)) : undefined,
          reviews: num(m.reviews) !== undefined ? Math.max(0, Math.round(num(m.reviews)!)) : undefined,
          hours: Array.isArray(m.hours) ? m.hours.map((h) => str(h, 80)).filter((h): h is string => !!h).slice(0, 7) : undefined,
          phone: str(m.phone, 40),
          website: httpUrl(m.website),
        }))
        .filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng))
        .slice(0, maxMarkers)
    : undefined
  // GeoJSON overlay (routes/areas) + its standalone Points become extra markers.
  let shapes: GeoShape[] | undefined
  let allMarkers: MapMarker[] | undefined = markers
  if (d.geojson) {
    const parsed = parseGeoJson(d.geojson)
    shapes = parsed.shapes.length ? parsed.shapes : undefined
    if (parsed.points.length) {
      const pointMarkers: MapMarker[] = parsed.points.map((p) => ({ lat: p.lat, lng: p.lng, label: p.label }))
      allMarkers = [...(markers ?? []), ...pointMarkers].slice(0, maxMarkers)
    }
  }
  return {
    center: { lat: clampLat(lat), lng: normLng(lng) },
    zoom: clampZoom(Number(d.zoom) || 11),
    markers: allMarkers,
    shapes,
    title: str(d.title, 200),
    intro: str(d.intro, 300),
  }
}
