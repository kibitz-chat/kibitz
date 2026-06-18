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

describe('chooseSignal (shared dynamic broker choice)', () => {
  beforeEach(() => _resetSignalChoice())
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

  it('falls back to the public broker when host is null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ host: null })))
    expect(await chooseSignal()).toBeUndefined()
  })

  it('falls back to the public broker when /api/signal errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    expect(await chooseSignal()).toBeUndefined()
  })

  it('caches the choice so concurrent peers share one answer (single fetch)', async () => {
    const f = vi.fn(async () => ok({ host: 'x.workers.dev' }))
    vi.stubGlobal('fetch', f)
    await Promise.all([chooseSignal(), chooseSignal()])
    await chooseSignal()
    expect(f).toHaveBeenCalledTimes(1)
  })
})
