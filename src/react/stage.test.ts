import { describe, expect, it } from 'vitest'
import { isPresenting, pickPresenter, presentAtOf } from './stage'

const S = {} as unknown as MediaStream // a stand-in stream (identity only)
const p = (id: string, meta: Record<string, unknown>, stream: MediaStream | null = S) => ({ id, meta, stream })

describe('isPresenting / presentAtOf', () => {
  it('reads the roster-meta convention', () => {
    expect(isPresenting(p('a', { presenting: true }))).toBe(true)
    expect(isPresenting(p('a', {}))).toBe(false)
    expect(presentAtOf(p('a', { presenting: true, presentAt: 5 }))).toBe(5)
    expect(presentAtOf(p('a', { presentAt: 9 }))).toBe(0) // not presenting → 0
  })
})

describe('pickPresenter — newest presenter with a stream wins the stage', () => {
  it('returns null when nobody is presenting', () => {
    expect(pickPresenter([p('a', {}), p('b', {})])).toBeNull()
  })

  it('picks the lone presenter', () => {
    expect(pickPresenter([p('a', {}), p('b', { presenting: true, presentAt: 1 })])?.id).toBe('b')
  })

  it('the highest presentAt wins a take-over', () => {
    const parts = [p('a', { presenting: true, presentAt: 2 }), p('b', { presenting: true, presentAt: 7 })]
    expect(pickPresenter(parts)?.id).toBe('b')
  })

  it('skips a presenter whose share stream has not arrived yet', () => {
    const parts = [p('a', { presenting: true, presentAt: 9 }, null), p('b', { presenting: true, presentAt: 1 })]
    expect(pickPresenter(parts)?.id).toBe('b')
  })
})
