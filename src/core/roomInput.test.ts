import { describe, it, expect } from 'vitest'
import { parseRoomTarget } from './roomInput'

const ORIGIN = 'https://kibitz.chat'

describe('parseRoomTarget — paste a link/code to JOIN a room from an installed PWA', () => {
  it('a full link with a bare hash room → same-origin room URL', () => {
    expect(parseRoomTarget('https://kibitz.chat/#tidal-3pu4s1ghy1', ORIGIN)).toBe(
      'https://kibitz.chat/#tidal-3pu4s1ghy1',
    )
  })

  it('the WhatsApp-friendly /j/<room> share form → same-origin fragment room URL', () => {
    expect(parseRoomTarget('https://kibitz.chat/j/tidal-yyo3ktiys1', ORIGIN)).toBe(
      'https://kibitz.chat/#tidal-yyo3ktiys1',
    )
  })

  it('/j/<room> keeps a grant query param', () => {
    expect(parseRoomTarget('https://kibitz.chat/j/tidal-x?k=GRANT', ORIGIN)).toBe('https://kibitz.chat/?k=GRANT#tidal-x')
  })

  it('/j/ with a reserved word is not a room', () => {
    expect(parseRoomTarget('https://kibitz.chat/j/new', ORIGIN)).toBeNull()
  })

  it('re-homes a link from ANOTHER origin onto OURS (stay in the installed app)', () => {
    // A localhost test link, or a link opened on a different deploy, still joins HERE.
    expect(parseRoomTarget('http://localhost:5174/#room-xyz', ORIGIN)).toBe('https://kibitz.chat/#room-xyz')
  })

  it('preserves a legacy gate-in-QUERY link (gate params + self credential `gt`)', () => {
    const got = parseRoomTarget('https://kibitz.chat/?g=invite&gk=abc&gt=tok#room-7', ORIGIN)
    expect(got).toBe('https://kibitz.chat/?g=invite&gk=abc&gt=tok#room-7')
  })

  it('preserves a new gate-in-FRAGMENT link (gate rides the hash after the room)', () => {
    const got = parseRoomTarget('https://kibitz.chat/#room-7?g=invite&gk=abc', ORIGIN)
    expect(got).toBe('https://kibitz.chat/#room-7?g=invite&gk=abc')
  })

  it('preserves a license grant query param (?k=…) for the module-load grant logic', () => {
    const got = parseRoomTarget('https://kibitz.chat/?k=GRANT#room-9', ORIGIN)
    expect(got).toBe('https://kibitz.chat/?k=GRANT#room-9')
  })

  it('a bare room code → a hash room URL', () => {
    expect(parseRoomTarget('tidal-3pu4s1ghy1', ORIGIN)).toBe('https://kibitz.chat/#tidal-3pu4s1ghy1')
  })

  it('normalizes a messy bare code (case, spaces, punctuation)', () => {
    expect(parseRoomTarget('  Tidal Room!  ', ORIGIN)).toBe('https://kibitz.chat/#tidal-room')
  })

  it('a relative #fragment link resolves against our origin', () => {
    expect(parseRoomTarget('#room-abc', ORIGIN)).toBe('https://kibitz.chat/#room-abc')
  })

  it('the bare homepage (no room) → null', () => {
    expect(parseRoomTarget('https://kibitz.chat/', ORIGIN)).toBeNull()
    expect(parseRoomTarget('https://kibitz.chat', ORIGIN)).toBeNull()
  })

  it('a static page link (no room in the hash) → null', () => {
    expect(parseRoomTarget('https://kibitz.chat/privacy', ORIGIN)).toBeNull()
    expect(parseRoomTarget('https://kibitz.chat/docs', ORIGIN)).toBeNull()
  })

  it('reserved hash routes are not rooms → null', () => {
    expect(parseRoomTarget('https://kibitz.chat/#new', ORIGIN)).toBeNull()
    expect(parseRoomTarget('#new', ORIGIN)).toBeNull()
    expect(parseRoomTarget('https://kibitz.chat/#privacy', ORIGIN)).toBeNull()
  })

  it('empty / whitespace / junk that normalizes away → null', () => {
    expect(parseRoomTarget('', ORIGIN)).toBeNull()
    expect(parseRoomTarget('   ', ORIGIN)).toBeNull()
    expect(parseRoomTarget('!!!', ORIGIN)).toBeNull()
  })

  it('a totally malformed URL string → null (not a crash)', () => {
    expect(parseRoomTarget('http://[bad', ORIGIN)).toBeNull()
  })

  it('a malformed %-escape in the hash does not throw', () => {
    // decodeURIComponent('%zz') would throw — the parser must not. `%zz` normalizes to `zz`.
    expect(parseRoomTarget('https://kibitz.chat/#%zz', ORIGIN)).toBe('https://kibitz.chat/#%zz')
  })

  // The embed demo pages carry the room in a ?room= QUERY param (kibitz.chat/embed*.html?room=…) — the
  // form copied from a floating widget. Re-home it to the fragment route so it joins from the app.
  it('an embed-page link with ?room= → same-origin fragment room URL', () => {
    expect(parseRoomTarget('https://kibitz.chat/embed-spa.html?room=trip-5pxtai5zbd', ORIGIN)).toBe(
      'https://kibitz.chat/#trip-5pxtai5zbd',
    )
    expect(parseRoomTarget('https://kibitz.chat/embed.html?room=tidal-x', ORIGIN)).toBe('https://kibitz.chat/#tidal-x')
  })

  it('?room= keeps OTHER same-origin params but moves the room to the hash', () => {
    expect(parseRoomTarget('https://kibitz.chat/embed.html?room=room-5&k=GRANT', ORIGIN)).toBe(
      'https://kibitz.chat/?k=GRANT#room-5',
    )
  })

  it('a cross-origin embed link re-homes the room onto ours (and drops the foreign query)', () => {
    expect(parseRoomTarget('https://evil.example/embed.html?room=room-6&idclient=x', ORIGIN)).toBe(
      'https://kibitz.chat/#room-6',
    )
  })

  it('?room= with a reserved word is not a room', () => {
    expect(parseRoomTarget('https://kibitz.chat/embed.html?room=new', ORIGIN)).toBeNull()
  })

  it('never escapes our origin — a sneaky hash/query stays inert on kibitz.chat', () => {
    // Whatever rides the query/fragment, the host is fixed to OUR origin (no open redirect).
    const got = parseRoomTarget('https://kibitz.chat/#room-1/../../evil', ORIGIN)
    expect(got?.startsWith('https://kibitz.chat/')).toBe(true)
  })

  // --- review 2026-06-17: reserved #help/#wake + cross-origin query stripping ---

  it('reserved app routes #help and #wake are not rooms → null', () => {
    expect(parseRoomTarget('https://kibitz.chat/#help', ORIGIN)).toBeNull()
    expect(parseRoomTarget('https://kibitz.chat/#wake', ORIGIN)).toBeNull()
    expect(parseRoomTarget('https://kibitz.chat/j/help', ORIGIN)).toBeNull()
    expect(parseRoomTarget('#help', ORIGIN)).toBeNull()
  })

  it('drops a CROSS-ORIGIN link’s query params (never graft a foreign ?idclient/?k onto our origin)', () => {
    // A crafted off-origin link must not carry its query onto our origin — App.tsx reads
    // ?idclient / ?k / ?galaxy from location.search. The room id (hash/path) still re-homes.
    expect(parseRoomTarget('https://evil.example/?idclient=ATTACKER#room-xyz', ORIGIN)).toBe(
      'https://kibitz.chat/#room-xyz',
    )
    expect(parseRoomTarget('https://evil.example/j/room-xyz?k=GRANT', ORIGIN)).toBe('https://kibitz.chat/#room-xyz')
  })

  it('still keeps query params from a SAME-ORIGIN link (gate/grant must survive)', () => {
    expect(parseRoomTarget('https://kibitz.chat/?k=GRANT#room-9', ORIGIN)).toBe('https://kibitz.chat/?k=GRANT#room-9')
  })
})
