import { afterEach, describe, expect, it } from 'vitest'
import { joinRoom, type Room } from './room'
import { createLocalBus } from './localBus'
import type { CallMember } from './protocol'
import { asContent, readEngineMeta, META_ENGINE } from '../react/useCall'

/**
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *  VERSION SKEW — a mixed-build room must interoperate. See COMPATIBILITY.md ("the serverless
 *  twist: mixed-build rooms"). Deploys aren't atomic and embedders cache `widget.js`, so two
 *  DIFFERENT builds WILL share a room with no server in the middle to translate. This pins that
 *  an old peer and a new peer keep working together.
 *
 *  Why we SIMULATE the old peer instead of loading the frozen `public/v0.1.0/widget.js`: that
 *  artifact is a self-mounting IIFE bundle (a whole widget), not an importable module — it can't
 *  run headless against `createLocalBus` in a unit test. What actually crosses the version
 *  boundary is the WIRE (the roster meta + the `ContentMsg` kinds), so we exercise the real
 *  engine from HEAD on one side and a FROZEN v0.1.0-shaped decoder/peer on the other. (The live
 *  two-bundle check belongs in the Playwright e2e matrix; this guards the contract in CI.)
 * ────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Flush microtasks + the connect/open timer (same as localBus.test.ts). */
const tick = () => new Promise((r) => setTimeout(r, 0))

// A FROZEN copy of v0.1.0's `asContent` accepted-kind set (chat|app|pay|ink|idtoken|caps) — what a
// peer built BEFORE `schema` existed would narrow with. Kept verbatim so this test fails loudly if
// the live decoder ever stops accepting a kind the old one did (a BREAK), and proves a new additive
// kind is correctly DROPPED by the old one (forward-compat). Do NOT "update" this to add `schema`:
// the whole point is that it predates it.
const V010_KINDS = new Set(['chat', 'app', 'pay', 'ink', 'idtoken', 'caps'])
const asContentV010 = (msg: unknown): unknown =>
  msg && typeof msg === 'object' && V010_KINDS.has((msg as { k?: string }).k as string) ? msg : null

describe('version skew: additive wire is forward- AND backward-compatible', () => {
  it('an OLD build (v0.1.0 decoder) silently DROPS a new `schema` message — no kbz-v1 bump needed', () => {
    const fresh = { k: 'schema', name: 'app.view', version: '1.0.0', schema: { type: 'object' } }
    expect(asContentV010(fresh)).toBeNull() // old peer ignores what it doesn't know
    expect(asContent(fresh)?.k).toBe('schema') // new peer understands it
  })

  it('a NEW build accepts every kind an OLD build emits (the live decoder is a SUPERSET, never narrower)', () => {
    const samples: Record<string, unknown> = {
      chat: { k: 'chat', text: 'hi' },
      app: { k: 'app', data: { x: 1 } },
      pay: { k: 'pay', url: 'https://x' },
      ink: { k: 'ink', e: { k: 'clear' } },
      idtoken: { k: 'idtoken', jwt: 'a.b.c' },
      caps: { k: 'caps', grants: {} },
    }
    for (const kind of V010_KINDS) {
      // what the old peer would have accepted…
      expect(asContentV010(samples[kind])).not.toBeNull()
      // …the new peer still accepts (no shipped kind was dropped/renamed).
      expect(asContent(samples[kind])?.k).toBe(kind)
    }
  })

  it('both decoders reject junk identically (an unknown future kind is null on both)', () => {
    for (const junk of [null, {}, { k: 'reaction', emoji: '👍' }, 'nope']) {
      expect(asContent(junk)).toBeNull()
      expect(asContentV010(junk)).toBeNull()
    }
  })
})

describe('version skew: roster meta negotiation degrades across builds', () => {
  it('reads the engine block from a NEW peer and strips it from the app meta', () => {
    const raw = { seat: 1, userId: 'u-7', [META_ENGINE]: { v: '0.2.0', f: ['schema.v1', 'caps.v1'] } }
    const { engine, features, appMeta } = readEngineMeta(raw)
    expect(engine).toBe('0.2.0')
    expect(features).toEqual(['schema.v1', 'caps.v1'])
    expect(appMeta).toEqual({ seat: 1, userId: 'u-7' }) // the reserved key never leaks to the app
  })

  it('degrades cleanly for an OLD peer (no engine block): engine/features undefined, app meta intact', () => {
    const { engine, features, appMeta } = readEngineMeta({ seat: 2 })
    expect(engine).toBeUndefined()
    expect(features).toBeUndefined()
    expect(appMeta).toEqual({ seat: 2 })
    // and an absent meta entirely (truly ancient) doesn't throw
    expect(readEngineMeta(undefined)).toEqual({ appMeta: {} })
  })
})

describe('version skew: a mixed-build room over the REAL presence engine (createLocalBus)', () => {
  const rooms: Room[] = []
  afterEach(() => {
    rooms.forEach((r) => r.close())
    rooms.length = 0
  })

  it('a new peer (~kbz meta) and an old peer (plain meta) both roster, and each reads the other correctly', async () => {
    const bus = createLocalBus()
    const neu = joinRoom('skew', { transport: bus })
    const old = joinRoom('skew', { transport: bus })
    rooms.push(neu, old)
    await tick()

    let neuRoster: readonly CallMember[] = []
    let oldRoster: readonly CallMember[] = []
    neu.link.onRoster((m) => (neuRoster = m))
    old.link.onRoster((m) => (oldRoster = m))

    // The new build rides its engine version + features under the reserved key; the old build
    // (predating negotiation) announces plain app meta only.
    neu.link.setSelf(true, false, 'New', '', 'vnew', { seat: 1, [META_ENGINE]: { v: '0.2.0', f: ['schema.v1'] } })
    old.link.setSelf(true, false, 'Old', '', 'vold', { seat: 2 })
    await tick()

    // Presence interop: the meta difference does NOT break the roster — both see both.
    expect(neuRoster.map((m) => m.id).sort()).toEqual(['vnew', 'vold'])
    expect(oldRoster.map((m) => m.id).sort()).toEqual(['vnew', 'vold'])

    // The new peer reading the OLD peer's entry: no engine block → undefined, app meta intact.
    const oldAsSeenByNew = neuRoster.find((m) => m.id === 'vold')!
    expect(readEngineMeta(oldAsSeenByNew.meta)).toEqual({ engine: undefined, features: undefined, appMeta: { seat: 2 } })

    // An OLD reader of the NEW peer's entry just sees the raw meta (incl. the reserved key) and is
    // unbothered — the engine carries meta verbatim, so an old build that never calls readEngineMeta
    // treats ~kbz as opaque host data, exactly as forward-compat requires.
    const newAsSeenByOld = oldRoster.find((m) => m.id === 'vnew')!
    expect(newAsSeenByOld.meta).toMatchObject({ seat: 1, [META_ENGINE]: { v: '0.2.0', f: ['schema.v1'] } })
    // …and a NEW reader of it strips the reserved key back out.
    expect(readEngineMeta(newAsSeenByOld.meta)).toEqual({ engine: '0.2.0', features: ['schema.v1'], appMeta: { seat: 1 } })
  })
})
