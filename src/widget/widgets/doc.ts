// kbz.doc — a rendered Markdown document. We DON'T pull markdown-it/DOMPurify: a hand-rolled BOUNDED subset is
// safer (we escape ALL text first, then wrap only known-safe tags; links are http(s)-only) and dependency-free.
// Supports: #/##/### headings, **bold**, *italic*/_italic_, `code`, ``` fences ```, - / * / 1. lists, > quotes,
// --- rules, [text](http…) links, paragraphs. Anything else renders as literal escaped text — never raw HTML.
// External links also SHOW their destination host (anti-phishing) so "click here" can't hide where it goes.
import { stripDangerousHtml } from './sanitizeHtml'
import type { WidgetExport } from './types'

export interface DocData {
  title?: string
  markdown: string
  html: string // pre-rendered, sanitized HTML (the renderer just sets it)
}

const MAX_MD = 20000
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Inline formatting on a line of ALREADY-ESCAPED text. Links validated http(s)-only. Order: links → code →
 *  bold → italic (escaping makes order safety-irrelevant — worst case is imperfect formatting, never unsafe). */
function inline(escaped: string): string {
  return escaped
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t, u) => {
      const host = (u.match(/^https?:\/\/([^/]+)/) || [])[1] || ''
      const badge = host && !t.includes(host) ? `<span class="kw-doc-host"> (${host})</span>` : '' // show where it really goes
      return `<a href="${u}" target="_blank" rel="noreferrer noopener">${t}</a>${badge}`
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
}

/** Render the bounded markdown subset to safe HTML (then the caller runs stripDangerousHtml as a 2nd layer). */
export function renderMarkdown(md: string): string {
  const lines = String(md).split('\n').slice(0, 2000) // bound the line count (DoS / pathological input)
  const out: string[] = []
  let i = 0
  let listType: 'ul' | 'ol' | null = null
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`)
      listType = null
    }
  }
  while (i < lines.length) {
    const line = lines[i]
    // fenced code block
    if (/^```/.test(line)) {
      closeList()
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++ // skip closing fence
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`)
      continue
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      closeList()
      const lvl = Math.min(5, 2 + h[1].length) // # → h3 … ### → h5 (keep them modest in a card)
      out.push(`<h${lvl}>${inline(esc(h[2].trim()))}</h${lvl}>`)
      i++
      continue
    }
    if (/^\s*([-*])\s+/.test(line)) {
      if (listType !== 'ul') {
        closeList()
        out.push('<ul>')
        listType = 'ul'
      }
      out.push(`<li>${inline(esc(line.replace(/^\s*[-*]\s+/, '')))}</li>`)
      i++
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      if (listType !== 'ol') {
        closeList()
        out.push('<ol>')
        listType = 'ol'
      }
      out.push(`<li>${inline(esc(line.replace(/^\s*\d+\.\s+/, '')))}</li>`)
      i++
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      closeList()
      out.push(`<blockquote>${inline(esc(line.replace(/^\s*>\s?/, '')))}</blockquote>`)
      i++
      continue
    }
    if (/^\s*---+\s*$/.test(line)) {
      closeList()
      out.push('<hr>')
      i++
      continue
    }
    if (!line.trim()) {
      closeList()
      i++
      continue
    }
    // paragraph: gather consecutive non-blank, non-special lines
    closeList()
    const buf = [line]
    i++
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|\s*[-*]\s|\s*\d+\.\s|\s*>|\s*---+\s*$)/.test(lines[i])) buf.push(lines[i++])
    out.push(`<p>${inline(esc(buf.join(' ')))}</p>`)
  }
  closeList()
  return out.join('\n')
}

export function sanitizeDoc(raw: unknown): DocData | null {
  const d = (typeof raw === 'string' ? { markdown: raw } : raw) as Record<string, unknown> | null
  if (!d || typeof d !== 'object') return null
  const md = typeof d.markdown === 'string' ? d.markdown.slice(0, MAX_MD) : typeof d.text === 'string' ? (d.text as string).slice(0, MAX_MD) : ''
  if (!md.trim()) return null
  return {
    title: typeof d.title === 'string' && d.title.trim() ? d.title.slice(0, 200) : undefined,
    markdown: md,
    html: stripDangerousHtml(renderMarkdown(md)), // 2nd layer over the already-escaped output
  }
}

/** kbz.doc → a self-contained, styled HTML file. The doc AS ITSELF: double-click → a formatted page in any
 *  browser. The body html is already sanitized (sanitizeDoc); the title is esc()'d before interpolation. */
export function exportDocHtml(data: DocData): Promise<WidgetExport> {
  const title = data.title || 'document'
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font:16px/1.6 system-ui,-apple-system,sans-serif;max-width:42rem;margin:2.5rem auto;padding:0 1.2rem;color:#1a1a1a}
  h2,h3,h4,h5{line-height:1.25;margin:1.4em 0 .5em} pre{background:#f4f4f5;padding:.8em 1em;border-radius:8px;overflow:auto}
  code{font-family:ui-monospace,monospace} blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #ddd;color:#555}
  a{color:#1971c2} .kw-doc-host{color:#888;font-size:.85em}
</style></head>
<body>${data.title ? `<h2>${esc(data.title)}</h2>` : ''}${data.html}</body></html>`
  return Promise.resolve({ blob: new Blob([page], { type: 'text/html;charset=utf-8' }), base: title, ext: 'html' })
}
