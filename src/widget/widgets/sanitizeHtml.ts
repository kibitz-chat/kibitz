// A DOM-based belt-and-suspenders sanitizer for the two kinds that inject markup via dangerouslySetInnerHTML:
// kbz.doc (our own escaped-Markdown HTML) and kbz.diagram (Mermaid's strict-mode SVG). This is the SECOND layer
// — Doc text is already escaped and Mermaid runs securityLevel:'strict' — but a real DOM walk (not regex) means
// a future Doc-renderer edit or a Mermaid strict-mode bypass (it has CVE history) can't reach a live handler.
//
// Parses with DOMParser (real tree, no regex-bypass), then drops dangerous ELEMENTS, on* handlers, javascript:/
// data:text-html URLs, and url()/@import in styles. SVG round-trips through the HTML parser's foreign-content
// path (viewBox/marker refs preserved). No-DOM (SSR/tests without DOMParser) → returns input unchanged (the
// callers already escape/strict-render, so this only ADDS safety).

const DROP_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'foreignobject', 'link', 'meta', 'base', 'noscript', 'template', 'form'])
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'background'])

function dangerousUrl(v: string): boolean {
  // drop the control chars/whitespace browsers ignore inside a scheme, then test it
  const s = v.replace(/[\u0000-\u0020]+/g, '').toLowerCase()
  return /^(javascript|vbscript|data):/.test(s) && !/^data:image\//.test(s)
}

function scrub(el: Element): void {
  for (const child of Array.from(el.children)) {
    if (DROP_TAGS.has(child.tagName.toLowerCase())) {
      child.remove()
      continue
    }
    // Keep <style> (Mermaid's theme lives here) but neutralise its only dangerous bits — url()/@import (fetch)
    // and expression() — while preserving fill/stroke/etc. so the diagram stays legible.
    if (child.tagName.toLowerCase() === 'style') {
      const css = child.textContent || ''
      if (/url\s*\(|@import|expression/i.test(css)) {
        child.textContent = css
          .replace(/@import[^;]*;?/gi, '')
          .replace(/url\s*\([^)]*\)/gi, 'none')
          .replace(/expression\s*\([^)]*\)/gi, 'none')
      }
      continue
    }
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) child.removeAttribute(attr.name)
      else if ((URL_ATTRS.has(name) || name.endsWith(':href')) && dangerousUrl(attr.value)) child.removeAttribute(attr.name)
      else if (name === 'style' && /url\s*\(|expression|@import/i.test(attr.value)) child.removeAttribute(attr.name)
    }
    scrub(child)
  }
}

export function stripDangerousHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return html
  try {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
    scrub(doc.body)
    return doc.body.innerHTML
  } catch {
    return '' // if it won't parse, drop it rather than inject raw
  }
}
