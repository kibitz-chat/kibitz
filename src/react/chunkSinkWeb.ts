// Browser-only disk sinks for streamed large-file receive (docs/large-transfer.md). OPFS works cross-platform
// incl. iOS Safari 15.2+ (the path that makes phones first-class); File System Access is desktop-Chromium
// (best UX — writes straight to the user's chosen file). Both degrade to MemSink. NOT unit-tested (they need
// the browser storage APIs) — exercised on-device per the 2-device matrix in the design doc.
import { type ChunkSink, type SinkKind, MemSink, chooseSinkKind, tightChunk } from '../core/chunkSink'

// Minimal structural types for the not-everywhere-typed storage APIs (avoids a lib bump).
interface FsWritable {
  // We only ever feed a Uint8Array chunk; typing it directly sidesteps the BufferSource<ArrayBuffer> generic.
  write(data: Uint8Array | Blob): Promise<void>
  seek?(position: number): Promise<void>
  truncate?(size: number): Promise<void>
  close(): Promise<void>
  abort?(): Promise<void>
}
interface OpfsFileHandle {
  createWritable(opts?: { keepExistingData?: boolean }): Promise<FsWritable>
  getFile(): Promise<File>
}
interface OpfsDir {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileHandle>
  removeEntry(name: string): Promise<void>
}
type SavePicker = (opts?: { suggestedName?: string }) => Promise<{ createWritable(): Promise<FsWritable> }>

const randId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`

/** What disk sinks this browser actually supports. */
export function detectSinkCaps(): { fsa: boolean; opfs: boolean } {
  const fsa = typeof (globalThis as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'
  const nav = globalThis.navigator as Navigator & { storage?: { getDirectory?: unknown } }
  const opfs = !!(nav && nav.storage && typeof nav.storage.getDirectory === 'function')
  return { fsa, opfs }
}

/** The receiver's real free storage, for the up-front fit check. `{}` when unavailable (→ tier cap only). */
export async function estimateStorage(): Promise<{ quota?: number; usage?: number }> {
  try {
    const nav = globalThis.navigator as Navigator & { storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> } }
    if (nav?.storage?.estimate) return await nav.storage.estimate()
  } catch {
    /* not available — fall through */
  }
  return {}
}

/** Best-effort durability hint so the browser is less likely to evict an in-progress OPFS transfer. */
export async function requestPersist(): Promise<void> {
  try {
    const nav = globalThis.navigator as Navigator & { storage?: { persist?: () => Promise<boolean> } }
    await nav?.storage?.persist?.()
  } catch {
    /* ignore */
  }
}

// OPFS sink — async createWritable (no Worker; a sync access handle in a Worker is a Phase-2 perf upgrade).
// Streams each chunk to a sandboxed temp file; finish() returns the disk-backed File. The temp is removed by
// cleanup() once the chat buffer evicts the attachment (after its object URL is revoked). The render mime
// isn't needed here — chat keeps it on the Attachment, and an object URL renders regardless of File.type.
async function createOpfsSink(): Promise<ChunkSink> {
  return makeOpfsSink(`xfer-${randId()}`)
}

/** Reopen an OPFS file left by a prior session (cross-reload resume): TRUNCATE to the last whole-chunk
 *  boundary (a crash may have left a half-written trailing chunk), then return the append-mode sink + `have`
 *  (whole chunks safely on disk) so the receiver resumes from exactly there. Null if the file is gone. */
export async function reopenOpfsSink(name: string, chunkBytes: number): Promise<{ sink: ChunkSink; have: number; bytes: number } | null> {
  try {
    const { dir, handle } = await opfsHandle(name, false)
    const size = (await handle.getFile()).size
    const have = Math.floor(size / chunkBytes)
    const bytes = have * chunkBytes
    const writable = await handle.createWritable({ keepExistingData: true })
    if (bytes < size) await writable.truncate?.(bytes) // drop a partial trailing chunk from the crash
    await writable.seek?.(bytes) // append after the last complete chunk
    return { sink: opfsSink(name, writable, handle, dir), have, bytes }
  } catch {
    return null // file vanished / evicted — caller drops the persisted record
  }
}

// Cast through `unknown` so we use OUR structural OpfsDir/FsWritable (which accept a Uint8Array chunk) rather
// than intersecting with the DOM lib's FileSystemWritableFileStream (BufferSource<ArrayBuffer>).
async function opfsHandle(name: string, create: boolean): Promise<{ dir: OpfsDir; handle: OpfsFileHandle }> {
  const nav = globalThis.navigator as unknown as { storage: { getDirectory(): Promise<OpfsDir> } }
  const dir = await nav.storage.getDirectory()
  const handle = await dir.getFileHandle(name, { create })
  return { dir, handle }
}

// Build a fresh OPFS-backed sink over a new file `name`.
async function makeOpfsSink(name: string): Promise<ChunkSink> {
  const { dir, handle } = await opfsHandle(name, true)
  const writable = await handle.createWritable()
  return opfsSink(name, writable, handle, dir)
}

// The ChunkSink object over an already-open writable (shared by fresh-create and reopen-append).
function opfsSink(name: string, writable: FsWritable, handle: OpfsFileHandle, dir: OpfsDir): ChunkSink {
  let closed = false
  return {
    kind: 'opfs',
    fileName: name,
    async write(chunk) {
      // tightChunk: iOS Safari's OPFS write() ignores a view's byteOffset → write the exact chunk, not its
      // whole backing buffer (else an xfer.v2 frame header leaks onto disk; see core/chunkSink.ts).
      await writable.write(tightChunk(chunk))
    },
    async finish() {
      closed = true
      await writable.close()
      return await handle.getFile() // a File backed by the OPFS temp — render/download without re-buffering
    },
    async abort() {
      if (!closed) {
        try {
          await writable.abort?.()
        } catch {
          /* ignore */
        }
      }
      try {
        await dir.removeEntry(name)
      } catch {
        /* ignore */
      }
    },
    async cleanup() {
      try {
        await dir.removeEntry(name)
      } catch {
        /* already gone */
      }
    },
  }
}

// File System Access sink — streams straight to a file the user picks. Returns null if they cancel the
// picker (caller falls back to OPFS/MEM). finish() returns an empty Blob: the bytes are already on disk at
// the user's location, so there's nothing to render inline (a file download, not an image preview).
async function createFsaSink(mime: string, name?: string): Promise<ChunkSink | null> {
  const picker = (globalThis as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker
  if (!picker) return null
  let writable: FsWritable
  try {
    const fh = await picker({ suggestedName: name })
    writable = await fh.createWritable()
  } catch {
    return null // user cancelled / denied
  }
  return {
    kind: 'fsa',
    async write(chunk) {
      await writable.write(tightChunk(chunk)) // same view-byteOffset hazard as OPFS (see core/chunkSink.ts)
    },
    async finish() {
      await writable.close()
      return new Blob([], { type: mime }) // saved to the user's disk; no in-memory copy to hand back
    },
    async abort() {
      try {
        await writable.abort?.()
      } catch {
        /* ignore */
      }
    },
  }
}

/**
 * Create the best receive sink available, falling back gracefully:
 *   fsa (if asked + supported + user picks a file) → opfs → mem.
 * `prefer` lets the caller force a tier (e.g. small payloads always take mem). The chosen `kind` may differ
 * from the request when a higher tier is unavailable or declined.
 */
export async function createReceiveSink(opts: { mime: string; name?: string; prefer?: SinkKind }): Promise<ChunkSink> {
  const caps = detectSinkCaps()
  const want = opts.prefer ?? chooseSinkKind(caps)
  if (want === 'fsa' && caps.fsa) {
    const sink = await createFsaSink(opts.mime, opts.name)
    if (sink) return sink
    // user cancelled the save dialog → fall through to OPFS/MEM
  }
  if ((want === 'fsa' || want === 'opfs') && caps.opfs) {
    try {
      await requestPersist()
      return await createOpfsSink()
    } catch {
      /* OPFS failed (quota / permission) → MEM */
    }
  }
  return new MemSink(opts.mime)
}
