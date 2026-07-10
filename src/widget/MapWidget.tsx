import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  clampZoom,
  geoToScreen,
  type MapData,
  type MapPin,
  type MapView,
  normLng,
  screenToGeo,
  shapePath,
  tileUrl,
  tilesForView,
  tileXToLng,
  tileYToLat,
  lngToWorldX,
  latToWorldY,
} from './mapWidget'

// Default raster basemap: OpenStreetMap's public tiles. Configurable per deployment (VITE_MAP_TILES) so a
// brand can point at its own tile server / a keyed provider — we never hard-depend on OSM. Offline (LAN hub)
// the <img>s simply fail to load and the markers render on a blank surface (graceful, not broken).
const DEFAULT_TILES =
  (typeof import.meta !== 'undefined' && (import.meta as { env?: Record<string, string> }).env?.VITE_MAP_TILES) ||
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

const DRAG_SLOP = 6 // px of movement below which a pointerdown→up counts as a TAP (drop a pin), not a pan

export interface MapWidgetProps {
  data: MapData
  /** Shared pins viewers have dropped (folded from `wevt` events by the parent). */
  pins: readonly MapPin[]
  /** Called when the local viewer taps the map to drop a pin (omit to make the map read-only/pannable only). */
  onDropPin?: (lat: number, lng: number) => void
  /** {z}/{x}/{y} tile URL template; defaults to VITE_MAP_TILES or OSM. */
  tiles?: string
  /** Fill the parent (the stage) instead of the compact chat-card size. */
  fill?: boolean
  /** LOCKSTEP (stage): a shared viewport every peer follows. When set, the map snaps to it (unless the local
   *  user is actively driving) — "follow the driver". Omit for an independent, local-only view (the chat card). */
  view?: { center: { lat: number; lng: number }; zoom: number } | null
  /** Called (throttled) when THIS user pans/zooms a lockstep map, so the parent can broadcast it to peers. */
  onViewChange?: (center: { lat: number; lng: number }, zoom: number) => void
}

// While the local user is driving (pointer down) or just was, ignore incoming lockstep views so a follower's
// own pan isn't yanked out from under them; when they settle, peers snap to the last driver.
const DRIVE_GRACE_MS = 1500
const EMIT_THROTTLE_MS = 120 // cap how often a pan broadcasts its viewport (≈8/s) — ctl is ephemeral + tiny

/**
 * The FIRST-PARTY bounded map renderer (docs/map-widget.md). A self-contained slippy map: raster <img> tiles
 * laid out from pure projection math (no Leaflet/MapLibre), pan by drag, zoom by buttons / wheel / double-tap,
 * and tap-to-drop-a-shared-pin. The agent only supplied validated `data`; this code — ours — does the drawing.
 */
export function MapWidget({ data, pins, onDropPin, tiles = DEFAULT_TILES, fill = false, view: sharedView, onViewChange }: MapWidgetProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 300, h: 200 })
  const [center, setCenter] = useState(sharedView?.center ?? data.center)
  const [zoom, setZoom] = useState(clampZoom(sharedView?.zoom ?? data.zoom))
  const lastDriveAt = useRef(0) // when this user last drove (pointer/zoom) — gates follow-the-driver
  const lastEmitAt = useRef(0)
  const [selected, setSelected] = useState<number | null>(null) // which marker's detail card is open

  // Re-centre when the agent posts a fresh map into the SAME instance (e.g. it moved the view). Keyed on the
  // payload identity so a viewer's own pan isn't yanked back by an unrelated re-render. Skipped in lockstep
  // mode (the shared view below is the source of truth there).
  useEffect(() => {
    if (sharedView) return
    setCenter(data.center)
    setZoom(clampZoom(data.zoom))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only on the data payload changing
  }, [data.center.lat, data.center.lng, data.zoom])

  // LOCKSTEP: snap to the shared viewport when a peer drives it — UNLESS we're driving (or just were), so the
  // active driver is never yanked. Followers converge on the last driver once they settle.
  useEffect(() => {
    if (!sharedView) return
    if (Date.now() - lastDriveAt.current < DRIVE_GRACE_MS) return
    setCenter(sharedView.center)
    setZoom(clampZoom(sharedView.zoom))
  }, [sharedView])

  // Broadcast our viewport to peers (throttled) while driving a lockstep map. `force` flushes on settle (pan end
  // / zoom) so followers land exactly where we stopped even if the last move was within the throttle window.
  const emitView = (c: { lat: number; lng: number }, z: number, force = false) => {
    if (!onViewChange) return
    lastDriveAt.current = Date.now()
    if (!force && lastDriveAt.current - lastEmitAt.current < EMIT_THROTTLE_MS) return
    lastEmitAt.current = lastDriveAt.current
    onViewChange(c, z)
  }

  // Measure the viewport so the tile grid + projection match the real pixels (responsive).
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const apply = () => setSize({ w: Math.max(80, el.clientWidth), h: Math.max(80, el.clientHeight) })
    apply()
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
    if (!RO) return
    const ro = new RO(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const view: MapView = useMemo(() => ({ center, zoom, width: size.w, height: size.h }), [center, zoom, size.w, size.h])
  const tilePlacements = useMemo(() => tilesForView(view), [view])

  // Pan: drag moves the grabbed world-pixel under the cursor. We track whether the gesture moved enough to be a
  // pan (vs a tap that drops a pin) so a click and a drag never both fire.
  const drag = useRef<{ x: number; y: number; cwx: number; cwy: number; moved: boolean } | null>(null)
  const onPointerDown = (e: ReactPointerEvent) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, cwx: lngToWorldX(center.lng, zoom), cwy: latToWorldY(center.lat, zoom), moved: false }
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return
    d.moved = true
    const cwx = d.cwx - dx
    const cwy = d.cwy - dy
    const c = { lat: tileYToLat(cwy / 256, zoom), lng: normLng(tileXToLng(cwx / 256, zoom)) }
    setCenter(c)
    emitView(c, zoom) // lockstep: stream the pan to followers (throttled)
  }
  const onPointerUp = (e: ReactPointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.moved) {
      emitView(center, zoom, true) // a real pan ended — flush the final viewport so followers land where we stopped
      return
    }
    if (selected !== null) {
      setSelected(null) // a tap on the map closes an open detail card (rather than dropping a pin)
      return
    }
    if (!onDropPin) return // a tap, but pins are off
    const rect = boxRef.current?.getBoundingClientRect()
    if (!rect) return
    const g = screenToGeo(e.clientX - rect.left, e.clientY - rect.top, view)
    onDropPin(g.lat, g.lng)
  }

  const nudgeZoom = (delta: number) =>
    setZoom((z) => {
      const nz = clampZoom(z + delta)
      emitView(center, nz, true) // lockstep: zoom changes are coarse — flush immediately
      return nz
    })
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    nudgeZoom(e.deltaY < 0 ? 1 : -1)
  }

  const surface: CSSProperties = {
    position: 'relative',
    width: '100%',
    maxWidth: fill ? 'none' : 340,
    height: fill ? undefined : 220,
    flex: fill ? '1 1 auto' : undefined,
    minHeight: fill ? 0 : undefined,
    overflow: 'hidden',
    borderRadius: 10,
    background: '#e8eef2',
    touchAction: 'none', // we own pan/zoom gestures; don't let the page scroll/zoom under us
    cursor: 'grab',
    userSelect: 'none',
  }

  return (
    <div className="kw-map" style={fill ? { display: 'flex', flexDirection: 'column', width: '100%', height: '100%' } : { display: 'inline-block', maxWidth: 340 }}>
      {(data.title || data.intro) && (
        <div style={{ margin: '0 0 6px', flex: '0 0 auto' }}>
          {data.title && <div style={{ font: `700 ${fill ? 16 : 13}px/1.3 system-ui, sans-serif`, color: fill ? '#fff' : '#1a1a1a' }}>{data.title}</div>}
          {data.intro && <div style={{ font: `400 ${fill ? 13 : 11}px/1.4 system-ui, sans-serif`, opacity: 0.75, marginTop: 2, color: fill ? 'rgba(255,255,255,.85)' : '#444' }}>{data.intro}</div>}
        </div>
      )}
      <div
        ref={boxRef}
        style={surface}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        onWheel={onWheel}
        onDoubleClick={() => nudgeZoom(1)}
        role="application"
        aria-label={data.title ? `Map: ${data.title}` : 'Interactive map'}
      >
        {/* Raster tiles */}
        {tilePlacements.map((t) => (
          <img
            key={`${t.z}/${t.x}/${t.y}/${t.left},${t.top}`}
            src={tileUrl(tiles, t)}
            alt=""
            draggable={false}
            loading="lazy"
            style={{ position: 'absolute', left: t.left, top: t.top, width: 256, height: 256, pointerEvents: 'none' }}
          />
        ))}

        {/* Vector overlay — GeoJSON routes (lines) + areas (polygons), re-projected each view. Under markers. */}
        {data.shapes && data.shapes.length > 0 && (
          <svg width={size.w} height={size.h} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1, overflow: 'visible' }} aria-hidden>
            {data.shapes.map((sh, i) => {
              const stroke = sh.color || '#2563eb'
              return (
                <path
                  key={`sh${i}`}
                  d={shapePath(sh, view)}
                  fill={sh.type === 'polygon' ? stroke : 'none'}
                  fillOpacity={sh.type === 'polygon' ? 0.18 : undefined}
                  fillRule="evenodd"
                  stroke={stroke}
                  strokeWidth={sh.type === 'line' ? 3.5 : 2}
                  strokeOpacity={0.9}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )
            })}
          </svg>
        )}

        {/* Agent-placed markers — numbered + tappable to open a detail card. */}
        {(data.markers ?? []).map((m, i) => {
          const p = geoToScreen(m.lat, m.lng, view)
          if (p.x < -28 || p.y < -28 || p.x > size.w + 28 || p.y > size.h + 28) return null
          return (
            <button
              type="button"
              key={`m${i}`}
              title={m.label}
              aria-label={m.label || `Place ${i + 1}`}
              onPointerDown={(e) => e.stopPropagation()} // don't start a pan from a marker tap
              onClick={(e) => {
                e.stopPropagation()
                setSelected(i)
              }}
              style={numMarker(p.x, p.y, selected === i)}
            >
              {i + 1}
            </button>
          )
        })}

        {/* Viewer-dropped shared pins */}
        {pins.map((pin) => {
          const p = geoToScreen(pin.lat, pin.lng, view)
          if (p.x < -20 || p.y < -20 || p.x > size.w + 20 || p.y > size.h + 20) return null
          return (
            <div key={pin.id} title={pin.by ? `Pin by ${pin.by}` : 'Pin'} style={markerStyle(p.x, p.y, '#1971c2')}>
              <span style={pinGlyph}>📌</span>
            </div>
          )
        })}

        {/* Zoom controls */}
        <div style={{ position: 'absolute', right: 6, top: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button type="button" aria-label="Zoom in" onClick={() => nudgeZoom(1)} style={zoomBtn}>
            +
          </button>
          <button type="button" aria-label="Zoom out" onClick={() => nudgeZoom(-1)} style={zoomBtn}>
            −
          </button>
        </div>

        {/* Attribution (required for OSM tiles) */}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer noopener"
          onPointerDown={(e) => e.stopPropagation()}
          style={{ position: 'absolute', right: 0, bottom: 0, font: '10px/1 system-ui, sans-serif', background: 'rgba(255,255,255,.7)', padding: '1px 4px', borderTopLeftRadius: 6, color: '#333', textDecoration: 'none' }}
        >
          © OpenStreetMap
        </a>

        {/* Tap-to-expand detail card for the selected marker — photo, rating, hours, contact, the agent's note. */}
        {selected !== null &&
          data.markers &&
          data.markers[selected] &&
          (() => {
            const m = data.markers![selected!]
            return (
              <div style={cardWrap} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()} role="dialog" aria-label={m.label || 'Place details'}>
                <button type="button" aria-label="Close" onClick={() => setSelected(null)} style={cardClose}>
                  ✕
                </button>
                {m.photos && m.photos[0] && <img src={m.photos[0]} alt={m.label || ''} style={cardPhoto} loading="lazy" />}
                <div style={cardBody}>
                  <div style={cardTitle}>
                    {selected! + 1}. {m.label || 'Place'}
                  </div>
                  {typeof m.rating === 'number' && (
                    <div style={cardRating}>
                      ★ {m.rating.toFixed(1)}
                      {typeof m.reviews === 'number' ? ` · ${formatReviews(m.reviews)} reviews` : ''}
                    </div>
                  )}
                  {m.description && <div style={cardDesc}>{m.description}</div>}
                  {m.note && <div style={cardNote}>💡 {m.note}</div>}
                  {m.hours && m.hours.length > 0 && (
                    <div style={cardSection}>
                      <div style={cardSectionH}>Hours</div>
                      {m.hours.map((h, j) => (
                        <div key={j} style={cardHour}>
                          {h}
                        </div>
                      ))}
                    </div>
                  )}
                  {(m.phone || m.website) && (
                    <div style={cardLinks}>
                      {m.phone && (
                        <a href={`tel:${m.phone}`} style={cardLink} onPointerDown={(e) => e.stopPropagation()}>
                          📞 {m.phone}
                        </a>
                      )}
                      {m.website && (
                        <a href={m.website} target="_blank" rel="noreferrer noopener" style={cardLink} onPointerDown={(e) => e.stopPropagation()}>
                          🌐 Website
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })()}
      </div>
      {onDropPin && selected === null && <div style={{ font: '11px/1.4 system-ui, sans-serif', opacity: 0.6, marginTop: 3 }}>Tap a numbered place for details · tap the map to drop a shared pin · drag to pan</div>}
    </div>
  )
}

/** "482,000" → "482k"; small counts shown as-is. */
const formatReviews = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))

const markerStyle = (x: number, y: number, _color: string): CSSProperties => ({
  position: 'absolute',
  left: x,
  top: y,
  transform: 'translate(-50%, -100%)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  pointerEvents: 'none',
  filter: 'drop-shadow(0 1px 1px rgba(0,0,0,.35))',
})
const pinGlyph: CSSProperties = { fontSize: 20, lineHeight: 1 }
const zoomBtn: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 6,
  border: 'none',
  background: 'rgba(255,255,255,.92)',
  font: '600 16px/1 system-ui, sans-serif',
  cursor: 'pointer',
  boxShadow: '0 1px 3px rgba(0,0,0,.25)',
  color: '#222',
}
/** A numbered, tappable place marker — orange normally, blue + ring when its card is open. */
const numMarker = (x: number, y: number, active: boolean): CSSProperties => ({
  position: 'absolute',
  left: x,
  top: y,
  transform: 'translate(-50%, -100%)',
  width: 26,
  height: 26,
  borderRadius: 13,
  border: '2px solid rgba(255,255,255,.9)',
  background: active ? '#1971c2' : '#d9480f',
  color: '#fff',
  font: '700 12px/1 system-ui, sans-serif',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  pointerEvents: 'auto',
  padding: 0,
  boxShadow: active ? '0 0 0 3px rgba(25,113,194,.4), 0 2px 5px rgba(0,0,0,.4)' : '0 2px 5px rgba(0,0,0,.4)',
  zIndex: active ? 4 : 3,
})
// Tap-to-expand detail card (a bottom sheet over the map). White/light so it reads on both the chat card and the dark stage.
const cardWrap: CSSProperties = { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '80%', background: '#fff', color: '#1a1a1a', borderTopLeftRadius: 14, borderTopRightRadius: 14, overflowY: 'auto', pointerEvents: 'auto', zIndex: 6, boxShadow: '0 -6px 24px rgba(0,0,0,.35)', textAlign: 'left' }
const cardClose: CSSProperties = { position: 'absolute', right: 8, top: 8, width: 28, height: 28, borderRadius: 14, border: 'none', background: 'rgba(0,0,0,.55)', color: '#fff', font: '600 14px/1 system-ui, sans-serif', cursor: 'pointer', zIndex: 2 }
const cardPhoto: CSSProperties = { width: '100%', maxHeight: 180, objectFit: 'cover', display: 'block' }
const cardBody: CSSProperties = { padding: '10px 14px 16px' }
const cardTitle: CSSProperties = { font: '700 15px/1.3 system-ui, sans-serif' }
const cardRating: CSSProperties = { font: '600 12px/1.4 system-ui, sans-serif', color: '#c77700', marginTop: 3 }
const cardDesc: CSSProperties = { font: '400 12px/1.5 system-ui, sans-serif', color: '#333', marginTop: 6 }
const cardNote: CSSProperties = { font: '500 12px/1.5 system-ui, sans-serif', color: '#178a3a', background: '#eafaf1', borderRadius: 8, padding: '6px 9px', marginTop: 8 }
const cardSection: CSSProperties = { marginTop: 10 }
const cardSectionH: CSSProperties = { font: '700 10px/1 system-ui, sans-serif', letterSpacing: 0.5, textTransform: 'uppercase', color: '#888', marginBottom: 3 }
const cardHour: CSSProperties = { font: '400 11.5px/1.5 system-ui, sans-serif', color: '#333' }
const cardLinks: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }
const cardLink: CSSProperties = { font: '600 12px/1 system-ui, sans-serif', color: '#1971c2', background: '#eef4fb', borderRadius: 999, padding: '6px 11px', textDecoration: 'none' }
