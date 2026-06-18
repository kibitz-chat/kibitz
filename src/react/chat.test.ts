import { describe, expect, it } from 'vitest'
import { appendChat, newChatLines, type ChatItem } from './useCall'

const item = (id: number, text = `m${id}`): ChatItem => ({ id, from: 'x', name: 'N', text, self: false })
const mine = (id: number, text = `m${id}`): ChatItem => ({ id, from: 'me', name: 'Me', text, self: true })

describe('appendChat — capped ephemeral buffer', () => {
  it('appends in order without mutating the input', () => {
    const a = [item(1)]
    const b = appendChat(a, item(2))
    expect(b.map((m) => m.id)).toEqual([1, 2])
    expect(a).toHaveLength(1)
  })

  it('drops the oldest lines beyond the cap', () => {
    let list: ChatItem[] = []
    for (let i = 1; i <= 60; i++) list = appendChat(list, item(i), 50)
    expect(list).toHaveLength(50)
    expect(list[0].id).toBe(11)
    expect(list[49].id).toBe(60)
  })
})

describe('newChatLines — freshly-received lines for a headless controller', () => {
  it('returns only lines new since the previous snapshot, by id', () => {
    const prev = [item(1), item(2)]
    const next = [item(1), item(2), item(3), item(4)]
    expect(newChatLines(prev, next).map((m) => m.id)).toEqual([3, 4])
  })

  it('never surfaces our own (self) lines', () => {
    const prev = [item(1)]
    const next = [item(1), mine(2), item(3)]
    expect(newChatLines(prev, next).map((m) => m.id)).toEqual([3])
  })

  it('is robust to the capped buffer dropping old lines (no false positives)', () => {
    const prev = [item(2), item(3)] // line 1 already aged out
    const next = [item(3), item(4)] // 2 aged out, 4 is new
    expect(newChatLines(prev, next).map((m) => m.id)).toEqual([4])
  })

  it('returns nothing when unchanged', () => {
    const same = [item(1), item(2)]
    expect(newChatLines(same, same)).toEqual([])
  })
})
