// Inline image attachments for chat. A photo/picked image is shrunk + re-encoded until its base64 fits
// ONE data-mesh message (the same ~256KB ceiling app payloads use), so it rides the existing P2P
// content path with no chunking and the authority never sees it. The pure helpers (fit, validate,
// size-guard, sanitize) are node-testable; the canvas compressor touches the DOM only INSIDE its
// function body, so importing this module in a node test is safe.

/** Serialized-message ceiling for an `img` ContentMsg — mirrors the app-payload DoS ceiling. An image
 *  message above this is dropped on receive, so the compressor targets comfortably under it. */
export const IMG_MAX_BYTES = 256 * 1024
export const IMG_NAME_MAX = 80
/** Bound the base64 string itself (the message is data-dominated) so a peer can't hand us a huge blob. */
export const IMG_DATA_MAX = IMG_MAX_BYTES

/** Allowlisted inline-image mime types (what an <img src> renders + what we'll accept on the wire). */
export const isImgMime = (mime: unknown): mime is string => typeof mime === 'string' && /^image\/(png|jpe?g|webp|gif)$/i.test(mime)

/** True when an img message is too big to send/keep (serialized size). */
export const imgTooBig = (msg: unknown): boolean => {
  try {
    return JSON.stringify(msg).length > IMG_MAX_BYTES
  } catch {
    return false
  }
}

const posInt = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined)
// A base64 payload is [A-Za-z0-9+/] with optional '=' padding — reject anything else so we never feed
// junk to <img src> / an agent's decoder.
const isBase64 = (s: string): boolean => /^[A-Za-z0-9+/]+={0,2}$/.test(s)

export interface ImagePayload {
  mime: string
  data: string
  name?: string
  w?: number
  h?: number
}

/** Validate + clamp an incoming `img` content message into a render-safe payload, or null if malformed.
 *  Pure: the receive-side trust boundary for image content (mime allowlist, base64 sanity, bounded
 *  size/name). */
// `maxData` bounds the base64 length. Defaults to the 256KB INLINE-broadcast cap (a `k:'img'` message must stay
// small). Callers that deliver the bytes via the chunked XFER instead (e.g. seeding a recovered full-res image on
// resume — resendMedia ships it as a 50MB-capable transfer, not an inline broadcast) pass a larger cap so a real
// multi-MB painting isn't silently dropped by the inline limit.
export function sanitizeImg(c: { mime?: unknown; data?: unknown; name?: unknown; w?: unknown; h?: unknown }, maxData: number = IMG_DATA_MAX): ImagePayload | null {
  if (!isImgMime(c.mime)) return null
  const data = c.data
  if (typeof data !== 'string' || !data || data.length > maxData || !isBase64(data)) return null
  const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, IMG_NAME_MAX) : undefined
  return { mime: c.mime, data, ...(name ? { name } : {}), ...(posInt(c.w) ? { w: posInt(c.w) } : {}), ...(posInt(c.h) ? { h: posInt(c.h) } : {}) }
}

/** A renderable data URL from a sanitized payload. */
export const imgDataUrl = (p: { mime: string; data: string }): string => `data:${p.mime};base64,${p.data}`

/** Fit (w,h) into a maxDim×maxDim box, preserving aspect ratio. Never upscales. Pure. */
export function fitDimensions(w: number, h: number, maxDim: number): { w: number; h: number } {
  const safe = (n: number) => Math.max(1, Math.round(n) || 1)
  if (!(w > 0) || !(h > 0) || !(maxDim > 0)) return { w: safe(w), h: safe(h) }
  const longest = Math.max(w, h)
  if (longest <= maxDim) return { w: Math.round(w), h: Math.round(h) }
  const scale = maxDim / longest
  return { w: safe(w * scale), h: safe(h * scale) }
}

// ── Browser-only canvas compressor ───────────────────────────────────────────────────────────────
// Encodes a File/Blob to a base64 JPEG bounded by `maxBytes`, shrinking quality then dimensions until
// it fits. JPEG is chosen for universal <img> support + small size (a shared photo loses transparency,
// which is fine; this is for camera shots / photos, not alpha screenshots). DOM-only; never called in
// node tests.

const DEFAULT_MAX_DIM = 1280
// Leave headroom for base64 inflation (~4/3) + the JSON envelope keys, so the encoded blob fits the
// message ceiling once stringified.
const DEFAULT_MAX_BYTES = Math.floor((IMG_MAX_BYTES * 3) / 4) - 2048

async function loadBitmap(src: Blob): Promise<{ width: number; height: number; draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void; close?: () => void }> {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(src)
    return { width: bmp.width, height: bmp.height, draw: (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h), close: () => bmp.close() }
  }
  // Fallback (e.g. Safari without createImageBitmap for some blobs): an <img> via object URL.
  const url = URL.createObjectURL(src)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('image decode failed'))
      i.src = url
    })
    return { width: img.naturalWidth, height: img.naturalHeight, draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h) }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function drawToBlob(bmp: { draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void }, w: number, h: number, mime: string, quality: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  bmp.draw(ctx, w, h)
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), mime, quality))
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result || '')
      const comma = s.indexOf(',')
      resolve(comma >= 0 ? s.slice(comma + 1) : s) // strip the "data:...;base64," prefix
    }
    r.onerror = () => reject(new Error('read failed'))
    r.readAsDataURL(blob)
  })
}

/** Compress a File/Blob image to a base64 JPEG payload that fits one data-mesh message. Browser-only. */
export async function encodeImageToBudget(file: Blob, opts: { maxDim?: number; maxBytes?: number; name?: string } = {}): Promise<ImagePayload> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  let maxDim = opts.maxDim ?? DEFAULT_MAX_DIM
  let quality = 0.82
  const outMime = 'image/jpeg'
  const name = opts.name ? opts.name.slice(0, IMG_NAME_MAX) : undefined
  const bmp = await loadBitmap(file)
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const { w, h } = fitDimensions(bmp.width, bmp.height, maxDim)
      const blob = await drawToBlob(bmp, w, h, outMime, quality)
      if (blob && blob.size <= maxBytes) {
        return { mime: outMime, data: await blobToBase64(blob), w, h, ...(name ? { name } : {}) }
      }
      if (quality > 0.45) quality -= 0.12
      else maxDim = Math.max(320, Math.round(maxDim * 0.8))
    }
    // Last resort — smallest settings; ship whatever we got (still bounded by the receive guard).
    const { w, h } = fitDimensions(bmp.width, bmp.height, maxDim)
    const blob = await drawToBlob(bmp, w, h, outMime, 0.4)
    if (!blob) throw new Error('image encode failed')
    return { mime: outMime, data: await blobToBase64(blob), w, h, ...(name ? { name } : {}) }
  } finally {
    bmp.close?.()
  }
}

// An agent-produced image (e.g. the painter's 1024² PNG from gpt-image-1, several MB) ships through the FULL
// data-channel transfer with no inline cap. On the shared mesh data channel that bulk can starve the media-
// recovery signaling that rides the same stream (head-of-line) — which wedged the painter's own audio mid-call.
// Re-encode big ones to a bounded JPEG before they hit the wire: viewable quality, ~10x smaller. The agent keeps
// its own full-res copy (paint-mcp's cache) for edits — this only shrinks the in-call copy.
export const AGENT_IMG_INLINE_MAX = 200_000 // base64 chars (~150 KB) — at/under this, don't bother re-encoding
export const AGENT_IMG_MAX_BYTES = 480 * 1024 // target for the re-encoded JPEG (was multiple MB)
export const AGENT_IMG_MAX_DIM = 1600

/** Re-encode an agent image payload to a bounded JPEG so it can't clog the data channel. Returns the input
 *  unchanged when it's already small, when re-encoding wouldn't shrink it, or on any failure. Browser-only. */
export async function shrinkAgentImage(p: { mime?: string; data?: string; name?: string }): Promise<{ mime: string; data: string; name?: string }> {
  const mime = p.mime || 'image/png'
  const data = typeof p.data === 'string' ? p.data : ''
  const keep = { mime, data, ...(p.name ? { name: p.name } : {}) }
  if (!data || data.length <= AGENT_IMG_INLINE_MAX) return keep
  try {
    const blob = await (await fetch(`data:${mime};base64,${data}`)).blob()
    const out = await encodeImageToBudget(blob, { maxDim: AGENT_IMG_MAX_DIM, maxBytes: AGENT_IMG_MAX_BYTES, name: p.name })
    return out.data.length < data.length ? { mime: out.mime, data: out.data, ...(p.name ? { name: p.name } : {}) } : keep
  } catch {
    return keep // any decode/encode failure → ship the original rather than nothing
  }
}
