import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildSignalConfig, chooseSignal, _resetSignalChoice } from './signalConfig'

const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response

describe('buildSignalConfig', () => {
  it('returns undefined (public broker) when blank/null', () => {
    expect(buildSignalConfig('')).toBeUndefined()
    expect(buildSignalConfig('   ')).toBeUndefined()
    expect(buildSignalConfig(null)).toBeUndefined()
    expect(buildSignalConfig(undefined)).toBeUndefined()
  })

  it('builds secure PeerJS options, stripping scheme/trailing slash', () => {
    expect(buildSignalConfig('https://signal.kibitz.chat/')).toEqual({
      host: 'signal.kibitz.chat',
      port: 443,
      path: '/',
      secure: true,
    })
  })
})

const DEFAULT = { host: 'signal.kibitz.chat', port: 443, path: '/', secure: true }

describe('chooseSignal (shared dynamic broker choice)', () => {
  beforeEach(() => {
    _resetSignalChoice()
    try {
      localStorage.clear()
    } catch {
      /* node env without localStorage — the remembered-host path is a no-op there */
    }
  })
  afterEach(() => vi.unstubAllGlobals())

  it('uses our worker when /api/signal reports it healthy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ host: 'kibitz-signal.acme.workers.dev' })))
    expect(await chooseSignal()).toEqual({
      host: 'kibitz-signal.acme.workers.dev',
      port: 443,
      path: '/',
      secure: true,
    })
  })

  it('NEVER uses the public broker — falls back to the self-hosted default when host is null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ host: null })))
    expect(await chooseSignal()).toEqual(DEFAULT)
  })

  it('NEVER uses the public broker — falls back to the self-hosted default when /api/signal errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    expect(await chooseSignal()).toEqual(DEFAULT)
  })

  it('reuses the LAST healthy host on a later probe failure (stays on one broker across networks)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ host: 'x.workers.dev' })))
    expect(await chooseSignal()).toEqual({ host: 'x.workers.dev', port: 443, path: '/', secure: true })
    // Next probe FAILS (e.g. the same client now on 4G): must reuse x.workers.dev, not the default and never public.
    _resetSignalChoice()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('timeout')
      }),
    )
    const second = await chooseSignal()
    // jsdom persists the remembered host; a node env (no localStorage) can't, so it lands on the default — both
    // are self-hosted, never public.
    expect(second).toEqual(
      typeof localStorage !== 'undefined' ? { host: 'x.workers.dev', port: 443, path: '/', secure: true } : DEFAULT,
    )
  })

  it('caches the choice so concurrent peers share one answer (single fetch)', async () => {
    const f = vi.fn(async () => ok({ host: 'x.workers.dev' }))
    vi.stubGlobal('fetch', f)
    await Promise.all([chooseSignal(), chooseSignal()])
    await chooseSignal()
    expect(f).toHaveBeenCalledTimes(1)
  })
})
