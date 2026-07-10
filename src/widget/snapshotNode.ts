// Snapshot a rendered widget DOM node to a PNG data URL, so a chart / table / diagram can be STAGED AS PIXELS —
// the presenter shares the image and every viewer (including a LATE JOINER) just watches it, with no need for the
// widget's underlying data. This is the widget twin of image staging: it lets us route widgets through the same
// presenter-renders-and-shares fallback as photos/videos (per-viewer self-render is deferred — see STAGE_WIDGET_PIXELS).
//
// Zero-dependency: the SVG <foreignObject> technique. It works for the app's OWN, same-origin renders — Vega SVG
// charts, Mermaid SVG diagrams, and the HTML table/doc/form renderers (which style mostly inline). It does NOT
// inline external stylesheet rules, and it TAINTS on a cross-origin image (e.g. map tiles) → toDataURL throws.
// On any failure it returns null so the caller can fall back to the per-peer pointer path instead of a blank stage.
export async function widgetNodeToPng(node: HTMLElement): Promise<string | null> {
  try {
    const rect = node.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width || node.offsetWidth || 320))
    const h = Math.max(1, Math.round(rect.height || node.offsetHeight || 200))
    // Wrap the cloned node in an XHTML-namespaced <div> so the browser parses it as HTML inside the SVG
    // foreignObject; a self-contained <svg> child (Vega/Mermaid) keeps its own namespace through serialization.
    const wrap = document.createElement('div')
    wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
    wrap.appendChild(node.cloneNode(true))
    const xml = new XMLSerializer().serializeToString(wrap)
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<foreignObject x="0" y="0" width="100%" height="100%">${xml}</foreignObject>` +
      `</svg>`
    const img = new Image()
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const cx = canvas.getContext('2d')
    if (!cx) return null
    cx.fillStyle = '#ffffff' // widgets render dark-on-light; a white backdrop avoids a transparent → black stage
    cx.fillRect(0, 0, w, h)
    cx.drawImage(img, 0, 0)
    return canvas.toDataURL('image/png') // a cross-origin image taints the canvas → this throws → caught → null
  } catch {
    return null
  }
}
