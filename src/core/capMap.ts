/**
 * Bound a Map to `cap` entries by evicting the oldest-inserted (Maps keep insertion order) — keeps long-lived
 * per-peer maps (ID tokens, discovered schemas, owned widgets) from growing without limit. Stale entries are
 * never read, so this just caps memory. Generic + pure; shared by the engine and the feature modules.
 */
export function capMap<V>(map: Map<string, V>, cap: number): void {
  while (map.size > cap) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}
