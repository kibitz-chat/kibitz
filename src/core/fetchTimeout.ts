/**
 * `fetch()` with a hard timeout. A stalled request aborts and rejects instead of
 * hanging forever.
 *
 * Used for the `/api/*` config fetches (ICE servers, signaling choice) that gate
 * JOINING a call: the Join button stays disabled until they resolve, so on a slow
 * or flaky cellular link a request with no timeout leaves Join permanently dead.
 * With a timeout, the caller falls back fast (STUN-only / the public broker) and
 * the call still connects — never worse than before, just bounded.
 */
export async function fetchWithTimeout(input: string, init: RequestInit = {}, ms = 4000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(input, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}
