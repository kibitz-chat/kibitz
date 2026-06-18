import { describe, expect, it } from 'vitest'
import { isButtonTarget, isTypingTarget, shortcutFor } from './shortcuts'

describe('shortcutFor — key → call action', () => {
  it('maps m/M to mic (case-insensitive)', () => {
    expect(shortcutFor('m')).toBe('mic')
    expect(shortcutFor('M')).toBe('mic')
  })
  it('maps v/V to camera', () => {
    expect(shortcutFor('v')).toBe('cam')
    expect(shortcutFor('V')).toBe('cam')
  })
  it('maps Space (and the legacy Spacebar) to push-to-talk', () => {
    expect(shortcutFor(' ')).toBe('ptt')
    expect(shortcutFor('Spacebar')).toBe('ptt')
  })
  it('ignores everything else', () => {
    expect(shortcutFor('a')).toBeNull()
    expect(shortcutFor('Enter')).toBeNull()
    expect(shortcutFor('Escape')).toBeNull()
  })
})

describe('isTypingTarget — leave text fields alone', () => {
  const el = (tagName: string, extra?: object) => ({ tagName, ...extra }) as unknown as EventTarget
  it('is true for inputs / textareas / selects / contenteditable', () => {
    expect(isTypingTarget(el('INPUT'))).toBe(true)
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true)
    expect(isTypingTarget(el('SELECT'))).toBe(true)
    expect(isTypingTarget(el('DIV', { isContentEditable: true }))).toBe(true)
  })
  it('is false for non-text elements and null', () => {
    expect(isTypingTarget(el('DIV'))).toBe(false)
    expect(isTypingTarget(el('BUTTON'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('isButtonTarget — let Space activate a focused button', () => {
  const el = (tagName: string, extra?: object) =>
    ({ tagName, getAttribute: (n: string) => (extra as Record<string, string>)?.[n] ?? null, ...extra }) as unknown as EventTarget
  it('is true for <button>, button-like inputs, and role="button"', () => {
    expect(isButtonTarget(el('BUTTON'))).toBe(true)
    expect(isButtonTarget(el('INPUT', { type: 'submit' }))).toBe(true)
    expect(isButtonTarget(el('INPUT', { type: 'button' }))).toBe(true)
    expect(isButtonTarget(el('DIV', { role: 'button' }))).toBe(true)
  })
  it('is false for non-buttons and null', () => {
    expect(isButtonTarget(el('DIV'))).toBe(false)
    expect(isButtonTarget(el('INPUT', { type: 'text' }))).toBe(false)
    expect(isButtonTarget(null)).toBe(false)
  })
})
