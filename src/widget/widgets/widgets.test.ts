import { describe, expect, it } from 'vitest'
import { sanitizeTable } from './table'
import { sanitizeDoc, renderMarkdown } from './doc'
import { sanitizeMedia, allowedMediaUrl } from './media'
import { sanitizeForm } from './form'
import { sanitizeChart } from './chart'
import { sanitizeDiagram } from './diagram'
import { stripDangerousHtml } from './sanitizeHtml'

describe('kbz.table sanitize', () => {
  it('accepts {rows} and derives columns from keys', () => {
    const t = sanitizeTable({ title: 'T', rows: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] })!
    expect(t.title).toBe('T')
    expect(t.columns.map((c) => c.key)).toEqual(['a', 'b'])
    expect(t.rows).toHaveLength(2)
  })
  it('accepts a bare array of records', () => {
    const t = sanitizeTable([{ name: 'Ada' }, { name: 'Bo' }])!
    expect(t.rows).toHaveLength(2)
    expect(t.columns[0].key).toBe('name')
  })
  it('coerces non-scalar cells + honours explicit columns; rejects empty', () => {
    const t = sanitizeTable({ columns: [{ key: 'a', label: 'A' }], rows: [{ a: { nested: 1 } }] })!
    expect(t.columns[0].label).toBe('A')
    expect(typeof t.rows[0].a).toBe('string') // object coerced to string, never rendered raw
    expect(sanitizeTable({ rows: [] })).toBeNull()
    expect(sanitizeTable(null)).toBeNull()
  })
})

describe('kbz.doc sanitize + safe markdown', () => {
  it('renders a bounded subset', () => {
    const html = renderMarkdown('# Hi\n\nA **bold** and *em* and `code` and [link](https://x.test).\n\n- one\n- two')
    expect(html).toContain('<h3>Hi</h3>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>em</em>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<a href="https://x.test"')
    expect(html).toContain('<li>one</li>')
  })
  it('ESCAPES raw HTML and never emits scripts (XSS)', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })
  it('drops javascript: and non-http links (keeps them as text)', () => {
    const html = renderMarkdown('[x](javascript:alert(1)) and [y](ftp://h/f)')
    expect(html).not.toContain('href="javascript')
    expect(html).not.toContain('href="ftp')
  })
  it('sanitizeDoc accepts a string or {markdown} and rejects empty', () => {
    expect(sanitizeDoc('hello')!.html).toContain('hello')
    expect(sanitizeDoc({ markdown: '# H' })!.title).toBeUndefined()
    expect(sanitizeDoc('   ')).toBeNull()
  })
})

describe('kbz.media allowlist', () => {
  it('allows http(s) on allowlisted hosts (+ subdomains), rejects others + data:', () => {
    expect(allowedMediaUrl('https://upload.wikimedia.org/a.jpg')).toBe('https://upload.wikimedia.org/a.jpg')
    expect(allowedMediaUrl('https://en.wikipedia.org/x.png')).toBeTruthy()
    expect(allowedMediaUrl('https://evil.com/x.jpg')).toBeNull()
    expect(allowedMediaUrl('http://wikimedia.org.evil.com/x')).toBeNull() // suffix-spoof rejected
    expect(allowedMediaUrl('data:image/png;base64,xxx')).toBeNull()
    expect(allowedMediaUrl('javascript:alert(1)')).toBeNull()
  })
  it('sanitizeMedia keeps type + allowlisted url, drops a bad poster', () => {
    const m = sanitizeMedia({ type: 'video', url: 'https://kibitz.chat/v.mp4', caption: 'hi', poster: 'https://evil.com/p.jpg' })!
    expect(m.type).toBe('video')
    expect(m.url).toBe('https://kibitz.chat/v.mp4')
    expect(m.poster).toBeUndefined()
    expect(sanitizeMedia({ type: 'image', url: 'https://evil.com/x' })).toBeNull()
  })
})

describe('kbz.form (JSON Schema → fields)', () => {
  it('maps property types to fields + required + enum→select', () => {
    const f = sanitizeForm({
      title: 'RSVP',
      schema: {
        properties: { name: { type: 'string', title: 'Your name' }, going: { type: 'boolean' }, size: { type: 'string', enum: ['S', 'M', 'L'] }, n: { type: 'integer' } },
        required: ['name'],
      },
      uiSchema: { name: { placeholder: 'Ada' } },
    })!
    expect(f.title).toBe('RSVP')
    const byName = Object.fromEntries(f.fields.map((x) => [x.name, x]))
    expect(byName.name).toMatchObject({ type: 'text', label: 'Your name', required: true, placeholder: 'Ada' })
    expect(byName.going.type).toBe('checkbox')
    expect(byName.size).toMatchObject({ type: 'select', options: ['S', 'M', 'L'] })
    expect(byName.n.type).toBe('number')
  })
  it('rejects a schema with no fields', () => {
    expect(sanitizeForm({ schema: { properties: {} } })).toBeNull()
    expect(sanitizeForm(null)).toBeNull()
  })
})

describe('kbz.chart (Vega-Lite, SSRF-stripped)', () => {
  it('keeps a valid inline-data spec, STRIPS data.url (SSRF)', () => {
    const c = sanitizeChart({ spec: { mark: 'bar', data: { url: 'http://169.254.169.254/latest', values: [{ a: 1 }] }, encoding: { x: { field: 'a' } } } })!
    const data = c.spec.data as Record<string, unknown>
    expect(data.url).toBeUndefined() // external load blocked
    expect(data.values).toEqual([{ a: 1 }]) // inline data kept
    expect(c.spec.mark).toBe('bar')
  })
  it('rejects a non-chart object', () => {
    expect(sanitizeChart({ foo: 1 })).toBeNull()
    expect(sanitizeChart(null)).toBeNull()
  })
})

describe('kbz.diagram (Mermaid source)', () => {
  it('accepts a string or {source}/{mermaid}, rejects empty', () => {
    expect(sanitizeDiagram('flowchart TD\n A-->B')!.source).toContain('A-->B')
    expect(sanitizeDiagram({ mermaid: 'sequenceDiagram\n A->>B: hi' })!.source).toContain('A->>B')
    expect(sanitizeDiagram('   ')).toBeNull()
  })
})

// stripDangerousHtml needs a DOM (DOMParser); it's a no-op in this node env and is exercised in
// sanitizeHtml.dom.test.ts (happy-dom). Here we only assert its documented node-passthrough contract.
describe('stripDangerousHtml (node passthrough contract)', () => {
  it('returns input unchanged without a DOM (callers already escape/strict-render)', () => {
    expect(typeof DOMParser).toBe('undefined')
    expect(stripDangerousHtml('<b>x</b>')).toBe('<b>x</b>')
  })
})

describe('kbz.doc hardening', () => {
  it('SHOWS the destination host on a link whose text hides it (anti-phishing)', () => {
    const html = sanitizeDoc('[Verify your account](https://evil.example.com/login)')!.html
    expect(html).toContain('kw-doc-host')
    expect(html).toContain('evil.example.com')
  })
  it('output survives the 2nd-layer sanitizer (no handlers/scripts ever)', () => {
    const html = sanitizeDoc('# Hi\n\nplain **text** and a [link](https://ok.test/x)')!.html
    expect(html).not.toMatch(/<script|onerror|onclick|javascript:/i)
    expect(html).toContain('<strong>text</strong>')
  })
})
