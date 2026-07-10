// Shared content-lane limits + payload validators. These were local to useCall; they live here so feature
// MODULES (usePay, useApp, …) can share them without importing back from the engine (which would be a cycle).

export const PAY_URL_MAX = 512
export const PAY_NOTE_MAX = 80

// Schema discovery (agent/app capability advertisement) limits.
export const SCHEMA_NAME_MAX = 120 // schema identifiers are short labels (e.g. 'whist.view')
export const SCHEMA_CAP = 200 // bound the discovered-schema map across many peers × many schemas
export const SCHEMA_PER_PEER = 25 // ...and per peer, so one peer can't evict everyone else's schemas
export const OWN_SCHEMA_CAP = 50 // bound how many distinct schemas WE publish (no app needs more)

// Bounded interactive widgets (maps, etc.).
export const OWN_WIDGET_CAP = 32 // bound how many widget instances WE own (and thus retain + replay)
export const WIDGET_EVENTS_CAP = 1000 // bound the retained interaction log per owned widget (DoS ceiling for replay)

// App messages are OPAQUE developer payloads (co-browse / shared game state), so their shape is the app's
// business — but unbounded P2P app data is a memory/CPU DoS vector. A generous serialized-size backstop: an
// oversized payload is DROPPED on receive (an untrusted peer can't flood us) and not sent. Rate-limiting, schema
// validation, and backpressure stay the app's responsibility (the engine is a transport); this is only the
// safety ceiling. Best-effort: payloads JSON can't serialize (Blob/ArrayBuffer/Map) skip the check.
export const APP_MAX_BYTES = 256 * 1024

export const appPayloadTooBig = (data: unknown): boolean => {
  try {
    return JSON.stringify(data).length > APP_MAX_BYTES
  } catch {
    return false // not JSON-serializable — can't measure cheaply; let it through (app's call)
  }
}

// Send-side: same check, but tell the developer their payload was dropped (vs the silent receive-side drop of a
// peer's oversized message). Bounding the payload is the app's job.
export const tooBigToSend = (data: unknown): boolean => {
  if (!appPayloadTooBig(data)) return false
  // eslint-disable-next-line no-console
  console.warn(`[kibitz] app payload exceeds ${APP_MAX_BYTES} bytes — not sent; bound it in your app`)
  return true
}
