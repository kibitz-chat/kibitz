import { describe, it, expect } from 'vitest'
import { pageableViews } from './pageableViews'

// Defaults for the dimensions a given test isn't exercising.
const base = { canTouch: true, carSurface: true, multiParty: true }
const views = (o: Partial<typeof base>) => pageableViews({ ...base, ...o })

describe('pageableViews', () => {
  it('always offers Speaker, on every surface', () => {
    for (const canTouch of [true, false])
      for (const carSurface of [true, false])
        for (const multiParty of [true, false])
          expect(pageableViews({ canTouch, carSurface, multiParty })).toContain('speaker')
  })

  it('drops Car on a desktop (no touch) even on a car surface', () => {
    expect(views({ canTouch: false })).not.toContain('car')
  })

  it('drops Car off a car surface — the embedded widget, even maximized', () => {
    expect(views({ canTouch: true, carSurface: false })).not.toContain('car')
  })

  it('offers Car only on a touch car surface (the room window / installed app)', () => {
    expect(views({ canTouch: true, carSurface: true })).toContain('car')
  })

  it('Gallery (grid) needs ≥2 people — redundant with Speaker when alone', () => {
    expect(views({ multiParty: false })).not.toContain('gallery')
    expect(views({ multiParty: true })).toContain('gallery')
  })

  it('Strip is the embedded WIDGET only (not a car surface) — the room window uses Car instead', () => {
    expect(views({ carSurface: false })).toContain('strip')
    expect(views({ carSurface: true })).not.toContain('strip')
  })

  it('the embedded widget solo (touch, no car surface) → Speaker + Strip', () => {
    expect(views({ canTouch: true, carSurface: false, multiParty: false })).toEqual(['speaker', 'strip'])
  })

  it('the room window (touch car surface, group) → Car + Speaker + Gallery — no Strip', () => {
    expect(views({ canTouch: true, carSurface: true, multiParty: true })).toEqual(['car', 'speaker', 'gallery'])
  })

  it('preserves VIEW_ORDER ordering for the offered subset', () => {
    // Everything that can co-exist: a touch car surface offers Car/Speaker/Gallery (Strip is widget-only).
    expect(views({})).toEqual(['car', 'speaker', 'gallery'])
  })
})
