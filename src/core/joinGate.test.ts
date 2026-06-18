import { describe, it, expect } from 'vitest'
import { addCodeEntry, codeMatch, formatCode, nameAllowed, type CodeEntry } from './joinGate'

describe('nameAllowed — pick-a-name list (no proof)', () => {
  const list = ['Alice', 'Bob ', 'CAROL']
  it('admits a name on the list, case/space-insensitively', () => {
    expect(nameAllowed('alice', list)).toBe(true)
    expect(nameAllowed('  BOB ', list)).toBe(true)
    expect(nameAllowed('carol', list)).toBe(true)
  })
  it('rejects a name not on the list, and blanks', () => {
    expect(nameAllowed('dave', list)).toBe(false)
    expect(nameAllowed('', list)).toBe(false)
    expect(nameAllowed('  ', list)).toBe(false)
    expect(nameAllowed('alice', [])).toBe(false)
  })
})

describe('codeMatch — name + join code', () => {
  const entries: CodeEntry[] = [
    { name: 'Alice', code: 'K7P-Q2M' },
    { name: 'Bob', code: 'R4T-9XW' },
  ]
  it('returns the matching entry for a correct code (trimmed)', () => {
    expect(codeMatch('K7P-Q2M', entries)?.name).toBe('Alice')
    expect(codeMatch('  R4T-9XW ', entries)?.name).toBe('Bob')
  })
  it('returns null for a wrong or blank code', () => {
    expect(codeMatch('NOPE', entries)).toBeNull()
    expect(codeMatch('', entries)).toBeNull()
    expect(codeMatch('K7P-Q2M', [])).toBeNull()
  })
  it('does not match a blank assigned code (defends an empty row)', () => {
    expect(codeMatch('', [{ name: 'X', code: '' }])).toBeNull()
    expect(codeMatch('   ', [{ name: 'X', code: '   ' }])).toBeNull()
  })
})

describe('addCodeEntry — building the code list (immutable, validated)', () => {
  it('appends a trimmed row as a NEW array', () => {
    const a: CodeEntry[] = [{ name: 'Alice', code: 'AAA' }]
    const b = addCodeEntry(a, '  Bob ', ' BBB ')
    expect(b).toEqual([
      { name: 'Alice', code: 'AAA' },
      { name: 'Bob', code: 'BBB' },
    ])
    expect(a).toHaveLength(1) // original untouched
  })
  it('rejects blank name or code', () => {
    expect(addCodeEntry([], '', 'x')).toEqual([])
    expect(addCodeEntry([], 'x', '')).toEqual([])
  })
  it('rejects a duplicate name (case-insensitive)', () => {
    expect(addCodeEntry([{ name: 'Alice', code: 'AAA' }], 'ALICE', 'BBB')).toEqual([{ name: 'Alice', code: 'AAA' }])
  })
})

describe('formatCode — readable random codes', () => {
  it('formats bytes into grouped, unambiguous glyphs', () => {
    const code = formatCode(new Uint8Array([0, 1, 2, 3, 4, 5]))
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/) // no I/O/0/1/L
  })
  it('honors group/size', () => {
    const code = formatCode(new Uint8Array(12).fill(7), 3, 4)
    expect(code.split('-')).toHaveLength(3)
    expect(code.split('-')[0]).toHaveLength(4)
  })
})
