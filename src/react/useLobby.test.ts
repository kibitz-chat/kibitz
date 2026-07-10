import { describe, expect, it } from 'vitest'
import { lobbyOverlay, visibleKnocks, type Knock } from './useLobby'

describe('lobbyOverlay — the joiner knock state the panel draws', () => {
  it('shows the overlay while waiting for the host', () => {
    expect(lobbyOverlay('waiting')).toBe('waiting')
  })

  it('shows the overlay when the host refuses entry', () => {
    expect(lobbyOverlay('denied')).toBe('denied')
  })

  it('clears once admitted — the normal flow just resumes', () => {
    expect(lobbyOverlay('admitted')).toBeNull()
  })

  it('shows nothing before any knock (no lobby in play)', () => {
    expect(lobbyOverlay(null)).toBeNull()
  })
})

describe('visibleKnocks — the host only acts on a live lobby', () => {
  const list: Knock[] = [{ id: 'a', name: 'Ada', avatar: '🦊' }]

  it('passes the waiting list through while the lobby is on', () => {
    expect(visibleKnocks(true, list)).toEqual(list)
  })

  it('hides any list while the lobby is off', () => {
    expect(visibleKnocks(false, list)).toEqual([])
  })
})
