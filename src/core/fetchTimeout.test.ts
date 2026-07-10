import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWithTimeout } from './fetchTimeout'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('fetchWithTimeout', () => {
  it('returns the response when fetch resolves in time', async () => {
    const resp = new Response('ok')
    globalThis.fetch = vi.fn(async () => resp) as unknown as typeof fetch
    await expect(fetchWithTimeout('/x', {}, 50)).resolves.toBe(resp)
  })

  it('passes an AbortSignal through to fetch', async () => {
    const spy = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response('ok')
    })
    globalThis.fetch = spy as unknown as typeof fetch
    await fetchWithTimeout('/y')
    expect(spy).toHaveBeenCalledOnce()
  })

  it('aborts (rejects) when the request outlasts the timeout', async () => {
    // A fetch that never settles on its own — only the timeout's abort ends it.
    globalThis.fetch = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    ) as unknown as typeof fetch
    await expect(fetchWithTimeout('/slow', {}, 10)).rejects.toThrow(/abort/i)
  })
})
