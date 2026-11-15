import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError, findConfig, loadProject, parseProject } from '../src/config.ts'

const FILE = '/repo/portcall.json'

describe('parseProject', () => {
  it('reads services, resolves cwd and fills port placeholders', () => {
    const project = parseProject({
      name: 'kinora',
      services: {
        server: { command: 'pnpm dev:server', port: 3000, env: { SELF: 'http://localhost:{port}' } },
        web: { command: 'pnpm dev', port: 5173, cwd: 'packages/web', env: { API: 'http://localhost:{ports.server}/api' } },
        db: { port: 5436 },
      },
    }, FILE)
    expect(project.root).toBe('/repo')
    expect(project.services.map(s => s.name)).toEqual(['server', 'web', 'db'])
    expect(project.services[0]!.env).toEqual({ SELF: 'http://localhost:3000' })
    expect(project.services[1]!).toMatchObject({ cwd: '/repo/packages/web', env: { API: 'http://localhost:3000/api' }, readyTimeout: 60 })
    expect(project.services[2]!.command).toBeUndefined()
  })

  it('rejects two services on one port', () => {
    expect(() => parseProject({ name: 'a', services: { x: { command: 'x', port: 1 }, y: { command: 'y', port: 1 } } }, FILE))
      .toThrow(/"x" and "y" both use port 1/)
  })

  it('rejects a placeholder naming an unknown service', () => {
    expect(() => parseProject({ name: 'a', services: { x: { command: 'x', port: 1, env: { U: '{ports.nope}' } } } }, FILE))
      .toThrow(/unknown service "nope"/)
  })

  it('rejects unknown keys and bad ports with a readable message', () => {
    expect(() => parseProject({ name: 'a', services: { x: { port: 70000, comand: 'typo' } } }, FILE)).toThrow(ConfigError)
    expect(() => parseProject({ name: 'a', services: {} }, FILE)).toThrow(/empty/)
  })
})

describe('findConfig', () => {
  it('walks up from a nested directory', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'portcall-config-')))
    writeFileSync(join(root, 'portcall.json'), JSON.stringify({ name: 'x', services: { s: { port: 1 } } }))
    mkdirSync(join(root, 'a/b'), { recursive: true })
    const file = findConfig(join(root, 'a/b'))
    expect(file).toBe(join(root, 'portcall.json'))
    expect(loadProject(file!).root).toBe(root)
  })
})
