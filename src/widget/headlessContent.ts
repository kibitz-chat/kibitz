// A headless agent (or any embedder driving the controller from outside the page's DOM) hands binary
// content as a base64 string, not a File object. This turns that wire-friendly payload into the File the
// chunked content transfer (call.sendFile) consumes — so an agent's tool can post a generated image or
// file into the call. Pure + small → unit-testable. Returns null on a missing / undecodable payload.
import { base64ToBytes } from '../core/contentXfer'

export interface ContentPayload {
  /** MIME type, e.g. 'image/png' — drives inline-image vs file-attachment rendering downstream. */
  mime?: string
  /** The content, base64-encoded. Provide this OR `blob` (a ready Blob/File). */
  data?: string
  /** A ready Blob / File — preferred for LARGE content: it skips base64 entirely (no ~33% size bloat, no full
   *  re-decode into a second copy), so a big file never has to round-trip through a giant string. Takes
   *  precedence over `data` when both are present. */
  blob?: Blob
  /** A display / download name; a per-surface fallback is used when omitted. */
  name?: string
}

/** A content payload → a typed File (preferred, so the name survives) or Blob; null if there's nothing usable.
 *  Accepts EITHER a ready `blob` (no base64 — best for large files) or base64 `data`. */
export function payloadToFile(p: unknown, fallbackName: string): File | Blob | null {
  if (!p || typeof p !== 'object') return null
  const { mime, data, name, blob } = p as Record<string, unknown>
  const type = typeof mime === 'string' && mime ? mime : 'application/octet-stream'
  const fname = typeof name === 'string' && name ? name : fallbackName
  // A ready Blob/File: use it directly — no base64 decode, no extra copy (the File wrapper just carries the
  // name + type; it references the same bytes). The key path for large content.
  if (blob instanceof Blob) {
    const t = blob.type || type
    return typeof File === 'function' ? new File([blob], fname, { type: t }) : blob
  }
  if (typeof data !== 'string' || !data) return null
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(data)
  } catch {
    return null // undecodable base64
  }
  if (!bytes.length) return null
  const part = bytes as unknown as BlobPart
  // A File carries the name (sendFile reads file.name for the download); fall back to a typed Blob where
  // the File constructor isn't available (older/SSR environments).
  return typeof File === 'function' ? new File([part], fname, { type }) : new Blob([part], { type })
}
