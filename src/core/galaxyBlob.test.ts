import { describe, it, expect } from 'vitest'
import { buildGalaxyBlob, parseGalaxyBlob, type GalaxyConfig } from './galaxySignal'

// buildGalaxyBlob is the inverse of parseGalaxyBlob — needed to turn a DISCOVERED hub
// (the fixed identity + its found LAN IP) into a shareable ?galaxy= link.
describe('buildGalaxyBlob', () => {
  const fp = new Uint8Array(32).map((_, i) => (i * 7) % 256)

  it('serializes a g1 config (no TURN) and round-trips through the parser', () => {
    const cfg: GalaxyConfig = { ufrag: 'uf', pwd: 'pw', fp, endpoints: [{ addr: '192.168.1.5', port: 4711 }] }
    const blob = buildGalaxyBlob(cfg)
    expect(blob.startsWith('g1|uf|pw|')).toBe(true)
    expect(blob.endsWith('|192.168.1.5~4711')).toBe(true)
    const back = parseGalaxyBlob(blob)
    expect(back).not.toBeNull()
    expect(back!.ufrag).toBe('uf')
    expect(back!.pwd).toBe('pw')
    expect([...back!.fp]).toEqual([...fp])
    expect(back!.endpoints).toEqual([{ addr: '192.168.1.5', port: 4711 }])
    expect(back!.turn).toBeUndefined()
  })

  it('serializes a g2 config (with TURN + multiple endpoints) and round-trips exactly', () => {
    const cfg: GalaxyConfig = {
      ufrag: 'wbxlanhub01',
      pwd: 'secretpwd',
      fp,
      endpoints: [
        { addr: '192.168.42.1', port: 4711 },
        { addr: 'kbz-ab12cd.local', port: 4711 },
      ],
      turn: { port: 3478, user: 'wblan', pass: 'turnpass' },
    }
    const blob = buildGalaxyBlob(cfg)
    expect(blob.startsWith('g2|wbxlanhub01|secretpwd|')).toBe(true)
    expect(blob).toContain('|3478,wblan,turnpass|')
    const back = parseGalaxyBlob(blob)
    expect(back).toEqual(cfg)
  })
})
