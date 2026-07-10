import { describe, expect, it } from 'vitest'
import { sanitizeTable, exportTableCsv } from './table'
import { sanitizeDoc, exportDocHtml } from './doc'
import { mapToGeoJson } from '../saveWidget'
import type { MapData } from '../mapWidget'

// Native widget export ("save as itself"). Pure, node-testable kinds only — chart/diagram render to SVG via
// Vega/Mermaid (browser-only) so those are covered by tsc/build + on-device, not here.

describe('exportTableCsv — kbz.table → CSV', () => {
  it('header from labels, rows in column order, RFC-4180 escaping', async () => {
    const data = sanitizeTable({
      title: 'Cities',
      columns: [{ key: 'city', label: 'City' }, { key: 'pop' }],
      rows: [{ city: 'Paris, FR', pop: 2161 }, { city: 'He said "hi"', pop: 5 }],
    })!
    const out = await exportTableCsv(data)
    expect(out.ext).toBe('csv')
    expect(out.base).toBe('Cities')
    const lines = (await out.blob.text()).replace(/^﻿/, '').trim().split('\r\n')
    expect(lines[0]).toBe('City,pop') // label falls back to key when absent
    expect(lines[1]).toBe('"Paris, FR",2161') // comma → quoted
    expect(lines[2]).toBe('"He said ""hi""",5') // quote → doubled + wrapped
  })
})

describe('exportDocHtml — kbz.doc → HTML', () => {
  it('standalone document; title is escaped; body is the rendered markdown', async () => {
    const data = sanitizeDoc({ title: 'Notes <x>', markdown: '# Hi\n\nHello **world**' })!
    const out = await exportDocHtml(data)
    expect(out.ext).toBe('html')
    const text = await out.blob.text()
    expect(text).toContain('<!doctype html>')
    expect(text).toContain('<title>Notes &lt;x&gt;</title>') // escaped — no raw < > in <title>
    expect(text).toContain('<strong>world</strong>') // the rendered body
  })
})

describe('mapToGeoJson — kbz.map → GeoJSON (coordinates are [lng, lat])', () => {
  it('markers → Point, line → LineString, polygon → Polygon', async () => {
    const data: MapData = {
      center: { lat: 48.85, lng: 2.35 },
      zoom: 12,
      markers: [{ lat: 48.86, lng: 2.34, label: 'Louvre' }],
      shapes: [
        { type: 'line', rings: [[{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }]], label: 'route' },
        { type: 'polygon', rings: [[{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }]] },
      ],
      title: 'Paris',
    }
    const out = mapToGeoJson(data)
    expect(out.ext).toBe('geojson')
    expect(out.base).toBe('Paris')
    const fc = JSON.parse(await out.blob.text())
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.features).toHaveLength(3)
    expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [2.34, 48.86] }) // [lng, lat], NOT [lat, lng]
    expect(fc.features[0].properties.label).toBe('Louvre')
    expect(fc.features[1].geometry.type).toBe('LineString')
    expect(fc.features[1].geometry.coordinates).toEqual([[2, 1], [4, 3]])
    expect(fc.features[2].geometry.type).toBe('Polygon')
    expect(fc.features[2].geometry.coordinates[0]).toHaveLength(3)
  })

  it('an empty map → an empty FeatureCollection (no crash)', async () => {
    const out = mapToGeoJson({ center: { lat: 0, lng: 0 }, zoom: 1 })
    const fc = JSON.parse(await out.blob.text())
    expect(fc.features).toEqual([])
  })
})
