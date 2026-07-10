import { useCallback, useEffect, useRef } from 'react'
import { capMap } from '../core/capMap'
import { OWN_SCHEMA_CAP, SCHEMA_CAP, SCHEMA_NAME_MAX, SCHEMA_PER_PEER, appPayloadTooBig, tooBigToSend } from '../core/contentLimits'
import type { ContentHandler, ContentMsg } from '../core/protocol'

export interface SchemaInfo {
  /** Publisher's media peer id (matches the roster). */
  from: string
  /** A stable identifier for the schema (e.g. 'whist.view', 'cobrowse'). */
  name: string
  /** The schema's own version, app-defined (e.g. '1.0.0'). */
  version: string
  /** The schema document — a JSON Schema, an example payload, or any structured-clone-able shape. */
  schema: unknown
}

export interface SchemaLane {
  registerSchema: (name: string, version: string, schema: unknown) => void
  getSchemas: () => readonly SchemaInfo[]
  onSchema: (cb: (s: SchemaInfo) => void) => () => void
  /** Drop peers' discovered schemas (on a call reset/leave; our OWN published schemas survive for re-publish). */
  clearPeers: () => void
}

/**
 * Schema discovery — the room's capability directory — as a self-contained module. Agents + embedded apps publish
 * a self-description of their app/view shape (registerSchema); the UI (agents menu, action bar, host menu) reads
 * getSchemas() to render their menus. Discovery is ORDER-INDEPENDENT: own schemas are re-broadcast on every roster
 * change (via the onRosterChange seam) so a late joiner discovers them. The module owns both maps (peers' + ours)
 * and registers its own gated receive handler. It lives in the engine layer (not the app) so a HEADLESS agent's
 * schemas get the same replay with no app cooperation.
 */
export function useSchema(
  broadcastContent: (m: ContentMsg) => void,
  sendAllowed: () => boolean,
  registerContentHandler: (kind: string, fn: ContentHandler) => () => void,
  onRosterChange: (fn: () => void) => () => void,
  voiceIdRef: { readonly current: string },
): SchemaLane {
  const schemasRef = useRef<Map<string, SchemaInfo>>(new Map()) // PEERS' schemas, keyed `${from} ${name}`
  const ownSchemasRef = useRef<Map<string, { version: string; schema: unknown }>>(new Map()) // ours (for replay)
  const schemaCbsRef = useRef<Set<(s: SchemaInfo) => void>>(new Set())

  const registerSchema = useCallback(
    (name: string, version: string, schema: unknown) => {
      const n = (name || '').slice(0, SCHEMA_NAME_MAX).trim()
      // Gate the publish like any other content send: in a verified-roster room we don't share until mutual
      // pre-share clears (sendAllowed). Bound how many distinct schemas we publish.
      if (!n || tooBigToSend(schema) || !sendAllowed()) return
      const v = (version || '').slice(0, 64)
      ownSchemasRef.current.set(n, { version: v, schema })
      capMap(ownSchemasRef.current, OWN_SCHEMA_CAP)
      broadcastContent({ k: 'schema', name: n, version: v, schema } satisfies ContentMsg)
      // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent is reference-stable
    },
    [sendAllowed],
  )

  // Merge our own schemas (resolved to our CURRENT id, so it's right even if we registered before joining) with
  // peers' discovered ones. A broadcast never echoes home, so ownSchemasRef is the only record of ours.
  const getSchemas = useCallback((): readonly SchemaInfo[] => {
    const own: SchemaInfo[] = [...ownSchemasRef.current].map(([name, { version, schema }]) => ({
      from: voiceIdRef.current,
      name,
      version,
      schema,
    }))
    return [...own, ...schemasRef.current.values()]
    // eslint-disable-next-line react-hooks/exhaustive-deps -- voiceIdRef is a stable ref
  }, [])

  const onSchema = useCallback((cb: (s: SchemaInfo) => void) => {
    schemaCbsRef.current.add(cb)
    return () => {
      schemaCbsRef.current.delete(cb)
    }
  }, [])

  const clearPeers = useCallback(() => {
    schemasRef.current.clear()
  }, [])

  // Receive: a peer self-describing its app/view shape. Bound the name + document (same DoS ceiling as app
  // payloads); newest published entry wins per (from,name); per-peer + total caps stop one peer flooding the map.
  useEffect(() => {
    return registerContentHandler('schema', (from, c) => {
      const s = c as Extract<ContentMsg, { k: 'schema' }>
      const sName = typeof s.name === 'string' ? s.name.slice(0, SCHEMA_NAME_MAX).trim() : ''
      if (!sName || appPayloadTooBig(s.schema)) return
      const key = `${from} ${sName}`
      if (!schemasRef.current.has(key)) {
        let mine = 0
        for (const k of schemasRef.current.keys()) if (k.startsWith(`${from} `)) mine++
        if (mine >= SCHEMA_PER_PEER) return
      }
      const info: SchemaInfo = { from, name: sName, version: typeof s.version === 'string' ? s.version.slice(0, 64) : '', schema: s.schema }
      schemasRef.current.set(key, info)
      capMap(schemasRef.current, SCHEMA_CAP)
      schemaCbsRef.current.forEach((cb) => cb(info))
    })
  }, [registerContentHandler])

  // Re-publish our own schemas on every roster change so late joiners discover them (order-independent). Gated by
  // sendAllowed (same verified-roster hold as registerSchema) and idempotent (latest-wins on receive).
  useEffect(() => {
    return onRosterChange(() => {
      if (!ownSchemasRef.current.size || !sendAllowed()) return
      for (const [name, { version, schema }] of ownSchemasRef.current) {
        broadcastContent({ k: 'schema', name, version, schema } satisfies ContentMsg)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent is reference-stable
  }, [onRosterChange, sendAllowed])

  return { registerSchema, getSchemas, onSchema, clearPeers }
}
