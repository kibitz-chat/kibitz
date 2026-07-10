import { describe, expect, it } from 'vitest'
import {
  applyMapEvent,
  clampLat,
  clampZoom,
  geoToScreen,
  latToTileY,
  lngToTileX,
  type MapPin,
  type MapView,
  normLng,
  parseGeoJson,
  sanitizeMapData,
  screenToGeo,
  shapePath,
  tileUrl,
  tilesForView,
} from './mapWidget'

describe('mapWidget projection math', () => {
  it('places lng/lat 0 at the centre tile and round-trips zoom', () => {
    // At zoom z there are 2^z tiles per axis; the equator/prime-meridian sit on the centre seam.
    expect(lngToTileX(0, 1)).toBeCloseTo(1)
    expect(latToTileY(0, 1)).toBeCloseTo(1)
    expect(lngToTileX(-180, 4)).toBeCloseTo(0)
    expect(lngToTileX(180, 4)).toBeCloseTo(16)
    expect(clampZoom(99)).toBe(19)
    expect(clampZoom(-5)).toBe(0)
  })

  it('clamps latitude to the Mercator range and wraps longitude', () => {
    expect(clampLat(90)).toBeCloseTo(85.05112878)
    expect(clampLat(-90)).toBeCloseTo(-85.05112878)
    expect(normLng(200)).toBeCloseTo(-160)
    expect(normLng(-190)).toBeCloseTo(170)
    expect(normLng(45)).toBeCloseTo(45)
  })

  it('projects the view centre to the viewport centre', () => {
    const v: MapView = { center: { lat: 32.0853, lng: 34.7818 }, zoom: 12, width: 300, height: 200 }
    const p = geoToScreen(v.center.lat, v.center.lng, v)
    expect(p.x).toBeCloseTo(150)
    expect(p.y).toBeCloseTo(100)
  })

  it('screenToGeo inverts geoToScreen', () => {
    const v: MapView = { center: { lat: 40.7128, lng: -74.006 }, zoom: 13, width: 320, height: 240 }
    for (const [sx, sy] of [
      [10, 20],
      [300, 220],
      [160, 120],
    ]) {
      const g = screenToGeo(sx, sy, v)
      const back = geoToScreen(g.lat, g.lng, v)
      expect(back.x).toBeCloseTo(sx, 4)
      expect(back.y).toBeCloseTo(sy, 4)
    }
  })

  it('covers the whole viewport with tiles and fills URLs', () => {
    const v: MapView = { center: { lat: 51.5074, lng: -0.1278 }, zoom: 10, width: 300, height: 200 }
    const tiles = tilesForView(v)
    expect(tiles.length).toBeGreaterThan(0)
    // Every tile is a valid slippy index at this zoom (0 .. 2^z-1) after wrap.
    const n = 2 ** 10
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0)
      expect(t.x).toBeLessThan(n)
      expect(t.y).toBeGreaterThanOrEqual(0)
      expect(t.y).toBeLessThan(n)
    }
    // The viewport's top-left and bottom-right pixels are both inside some tile's 256px box.
    const covers = (px: number, py: number) =>
      tiles.some((t) => px >= t.left && px < t.left + 256 && py >= t.top && py < t.top + 256)
    expect(covers(0, 0)).toBe(true)
    expect(covers(299, 199)).toBe(true)
    expect(tileUrl('https://t/{z}/{x}/{y}.png', { x: 5, y: 6, z: 10, left: 0, top: 0 })).toBe('https://t/10/5/6.png')
  })
})

describe('mapWidget event reducer (shared pins)', () => {
  const pin = (id: string, lat = 1, lng = 2): MapPin => ({ id, lat, lng })

  it('adds a pin, and re-applying the same id is idempotent', () => {
    const a = applyMapEvent([], { t: 'pin', pin: pin('p1') })
    expect(a).toHaveLength(1)
    const b = applyMapEvent(a, { t: 'pin', pin: pin('p1', 9, 9) })
    expect(b).toHaveLength(1) // not duplicated — replaced in place
    expect(b[0]).toMatchObject({ id: 'p1', lat: 9, lng: 9 })
  })

  it('removes a pin and ignores malformed events', () => {
    const set = applyMapEvent(applyMapEvent([], { t: 'pin', pin: pin('a') }), { t: 'pin', pin: pin('b') })
    expect(applyMapEvent(set, { t: 'unpin', id: 'a' })).toEqual([pin('b')])
    expect(applyMapEvent(set, null)).toHaveLength(2)
    expect(applyMapEvent(set, { t: 'pin', pin: { id: 'x', lat: NaN, lng: 0 } })).toHaveLength(2)
    // A lockstep VIEW event rides the ephemeral ctl channel, never the pin reducer — if one ever reaches here
    // it must leave the pins untouched (no pollution of the retained replay log).
    expect(applyMapEvent(set, { t: 'view', center: { lat: 1, lng: 2 }, zoom: 9 })).toEqual(set)
  })

  it('converges regardless of replay order (late-joiner safety)', () => {
    const events = [
      { t: 'pin', pin: pin('a') },
      { t: 'pin', pin: pin('b') },
      { t: 'unpin', id: 'a' },
      { t: 'pin', pin: pin('a') }, // a re-dropped after removal
    ]
    const forward = events.reduce<MapPin[]>((acc, e) => applyMapEvent(acc, e), [])
    expect(forward.map((p) => p.id).sort()).toEqual(['a', 'b'])
  })
})

describe('sanitizeMapData (untrusted agent payload)', () => {
  it('rejects payloads without a finite centre', () => {
    expect(sanitizeMapData(null)).toBeNull()
    expect(sanitizeMapData({ zoom: 10 })).toBeNull()
    expect(sanitizeMapData({ center: { lat: 'x', lng: 0 } })).toBeNull()
  })

  it('normalizes centre/zoom and caps + filters markers', () => {
    const d = sanitizeMapData({
      center: { lat: 95, lng: 200 },
      zoom: 99,
      title: 'x'.repeat(500),
      markers: [{ lat: 1, lng: 2, label: 'ok' }, { lat: 'bad', lng: 0 }, { lat: 3, lng: 4 }],
    })
    expect(d).not.toBeNull()
    expect(d!.center.lat).toBeCloseTo(85.05112878)
    expect(d!.center.lng).toBeCloseTo(-160)
    expect(d!.zoom).toBe(19)
    expect(d!.title!.length).toBe(200)
    expect(d!.markers).toHaveLength(2) // the NaN marker dropped
  })

  it('caps marker count', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ lat: i / 10, lng: i / 10 }))
    const d = sanitizeMapData({ center: { lat: 0, lng: 0 }, zoom: 5, markers: many }, 200)
    expect(d!.markers).toHaveLength(200)
  })

  it('passes through + sanitizes rich marker fields (cards) and the intro', () => {
    const d = sanitizeMapData({
      center: { lat: 48.86, lng: 2.29 },
      zoom: 13,
      title: 'Main Sights of Paris',
      intro: 'Ten must-see sights',
      markers: [
        {
          lat: 48.8584,
          lng: 2.2945,
          label: 'Eiffel Tower',
          note: 'Book ahead',
          description: 'Iron lattice tower',
          photos: ['https://upload.wikimedia.org/p.jpg', 'not-a-url', 'https://evil-tracker.example/q.png', 'https://en.wikipedia.org/r.png'],
          rating: 4.7,
          reviews: 482000.6,
          hours: ['Mon: 9–18', 'Tue: 9–18'],
          phone: '+33 1 23',
          website: 'https://toureiffel.paris',
        },
      ],
    })
    const m = d!.markers![0]
    expect(d!.intro).toBe('Ten must-see sights')
    expect(m.note).toBe('Book ahead')
    // only allowlisted hosts survive: the non-http url AND the arbitrary tracker host are both dropped
    expect(m.photos).toEqual(['https://upload.wikimedia.org/p.jpg', 'https://en.wikipedia.org/r.png'])
    expect(m.rating).toBe(4.7)
    expect(m.reviews).toBe(482001) // rounded
    expect(m.hours).toHaveLength(2)
    expect(m.website).toBe('https://toureiffel.paris')
  })

  it('drops a non-http website and clamps an out-of-range rating', () => {
    const d = sanitizeMapData({ center: { lat: 0, lng: 0 }, zoom: 5, markers: [{ lat: 1, lng: 1, website: 'javascript:alert(1)', rating: 9 }] })
    const m = d!.markers![0]
    expect(m.website).toBeUndefined() // only http(s)
    expect(m.rating).toBe(5) // clamped 0..5
  })
})

describe('GeoJSON overlay', () => {
  it('parses a FeatureCollection into line/polygon shapes + standalone points', () => {
    const { shapes, points } = parseGeoJson({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { name: 'route', color: '#ff0000' }, geometry: { type: 'LineString', coordinates: [[2.29, 48.85], [2.34, 48.86]] } },
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[2.3, 48.85], [2.35, 48.85], [2.35, 48.87], [2.3, 48.85]]] } },
        { type: 'Feature', properties: { title: 'spot' }, geometry: { type: 'Point', coordinates: [2.33, 48.86] } },
      ],
    })
    expect(shapes).toHaveLength(2)
    expect(shapes[0]).toMatchObject({ type: 'line', label: 'route', color: '#ff0000' })
    const r = shapes[0].rings[0] // [lng,lat] → {lat,lng}
    expect(r).toHaveLength(2)
    expect(r[0].lat).toBeCloseTo(48.85)
    expect(r[0].lng).toBeCloseTo(2.29)
    expect(r[1].lat).toBeCloseTo(48.86)
    expect(shapes[1].type).toBe('polygon')
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ label: 'spot' })
    expect(points[0].lat).toBeCloseTo(48.86)
  })
  it('rejects an unsafe color + bad coords; accepts a bare geometry', () => {
    const { shapes } = parseGeoJson({ type: 'LineString', coordinates: [[0, 0], [1, 1], ['x', 'y'], [200, 99]] })
    expect(shapes[0].rings[0]).toHaveLength(2) // the NaN + out-of-range points dropped
    const css = parseGeoJson({ type: 'Feature', properties: { color: 'red;}</style>' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } })
    expect(css.shapes[0].color).toBeUndefined() // injection-shaped colour rejected
  })
  it('sanitizeMapData threads geojson shapes + merges its points into markers', () => {
    const d = sanitizeMapData({
      center: { lat: 48.86, lng: 2.33 },
      zoom: 12,
      geojson: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [2.33, 48.86] } },
    })
    expect(d!.markers).toHaveLength(1) // the Point became a marker
    const withLine = sanitizeMapData({ center: { lat: 0, lng: 0 }, zoom: 5, geojson: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } })
    expect(withLine!.shapes).toHaveLength(1)
  })
  it('shapePath projects rings to an SVG path (closed for polygons)', () => {
    const v: MapView = { center: { lat: 0, lng: 0 }, zoom: 4, width: 400, height: 400 }
    const line = shapePath({ type: 'line', rings: [[{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }]] }, v)
    expect(line.startsWith('M')).toBe(true)
    expect(line.endsWith('Z')).toBe(false) // a line is open
    const poly = shapePath({ type: 'polygon', rings: [[{ lat: 0, lng: 0 }, { lat: 1, lng: 0 }, { lat: 1, lng: 1 }]] }, v)
    expect(poly.endsWith('Z')).toBe(true) // a polygon closes
  })
})
