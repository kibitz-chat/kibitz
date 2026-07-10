// @vitest-environment happy-dom
// DOM-backed tests for the 2nd-layer sanitizer (the rest of the widget suite is node-only by design). Runs the
// real DOMParser walk that protects kbz.doc + kbz.diagram's dangerouslySetInnerHTML.
import { describe, expect, it } from 'vitest'
import { stripDangerousHtml } from './sanitizeHtml'

describe('stripDangerousHtml (DOM)', () => {
  it('drops script / iframe / foreignObject / event handlers / javascript: urls', () => {
    const out = stripDangerousHtml(
      '<p onclick="x()">hi</p><script>alert(1)</script><iframe src="//e"></iframe><svg><foreignObject><b>x</b></foreignObject></svg><a href="javascript:alert(1)">y</a>',
    )
    expect(out).not.toMatch(/<script|<iframe|foreignobject/i)
    expect(out.toLowerCase()).not.toContain('onclick')
    expect(out.toLowerCase()).not.toContain('javascript:')
    expect(out).toContain('hi') // benign content survives
  })

  it('strips an obfuscated javascript: url (control chars/whitespace in the scheme)', () => {
    const out = stripDangerousHtml('<a href="java\tscript:alert(1)">x</a>')
    expect(out.toLowerCase()).not.toContain('javascript')
  })

  it('keeps safe SVG shape + http(s) links + benign attributes', () => {
    const out = stripDangerousHtml('<svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg><a href="https://ok.test">k</a>')
    expect(out).toMatch(/viewbox=/i) // SVG survives the round-trip
    expect(out).toContain('https://ok.test')
  })

  it('neutralises url()/@import in a <style> but keeps the rest (theme survives)', () => {
    const out = stripDangerousHtml('<style>.a{background:url(//evil/track);fill:red}</style>')
    expect(out).not.toContain('evil') // fetch neutralised
    expect(out).toContain('fill:red') // legitimate theme rule preserved
  })
})
