import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { linkedWorktree, loadProject, parseProject } from '../src/config.ts'
import { isListening } from '../src/ports.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

const SERVER = `
import { createServer } from 'node:http'
console.log('booting on ' + process.env.PORT + ' with ' + process.env.PEERS)
createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')
`

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise(resolve => server.close(resolve))
  return port
}

let main: string
let tree: string
let home: string
let apiPort: number
let dbPort: number

function run(cwd: string, ...args: string[]): { code: number, out: any } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, PORTCALL_HOME: home },
    encoding: 'utf8',
    timeout: 30_000,
  })
  let out: any
  try {
    out = JSON.parse(result.stdout)
  }
  catch {}
  return { code: result.status ?? -1, out }
}

function service(out: any, name: string): any {
  return out.services.find((s: any) => s.service === name)
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=portcall', '-c', 'user.email=portcall@example.com', ...args], { cwd, stdio: 'ignore' })
}

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'portcall-wt-')))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'portcall-home-')))
  main = join(base, 'main')
  tree = join(base, 'feature-x')
  apiPort = await freePort()
  dbPort = await freePort()
  mkdirSync(main)
  writeFileSync(join(main, 'server.mjs'), SERVER)
  writeFileSync(join(main, 'portcall.json'), JSON.stringify({
    name: 'wtdemo',
    worktrees: true,
    services: {
      api: { command: 'node server.mjs', port: apiPort, env: { PEERS: 'api={ports.api} db={ports.db}' }, readyTimeout: 10 },
      db: { port: dbPort },
    },
  }))
  git(main, 'init', '-q')
  git(main, 'add', '.')
  git(main, 'commit', '-q', '-m', 'init')
  git(main, 'worktree', 'add', '-q', '-b', 'feature-x', tree)
})

afterAll(() => {
  run(tree, 'down')
  run(main, 'down')
})

describe('worktrees', () => {
  it('tells a linked worktree from the main checkout', () => {
    expect(linkedWorktree(main)).toBeUndefined()
    expect(linkedWorktree(tree)).toBe('feature-x')
  })

  it('shares the declared ports without worktrees: true', () => {
    const project = parseProject({ name: 'wtdemo', services: { api: { command: 'x', port: apiPort } } }, join(tree, 'portcall.json'), { [tree]: 10 })
    expect(project).toMatchObject({ instance: 'wtdemo', services: [{ port: apiPort }] })
    expect(project.worktree).toBeUndefined()
  })

  it('runs the main checkout on the declared ports', async () => {
    const { code, out } = run(main, 'up', 'api', '--json')
    expect(code).toBe(0)
    expect(out.worktree).toBeUndefined()
    expect(service(out, 'api')).toMatchObject({ outcome: 'started', port: apiPort })
    expect(await isListening(apiPort)).toBe(true)
  })

  it('runs a worktree at the same time, on offset ports', async () => {
    const { code, out } = run(tree, 'up', 'api', '--json')
    expect(code).toBe(0)
    expect(out.worktree).toBe('feature-x')
    expect(out.portOffset).toBeGreaterThan(0)
    expect(out.portOffset % 10).toBe(0)
    const port = apiPort + out.portOffset
    expect(service(out, 'api')).toMatchObject({ outcome: 'started', port })
    expect(await isListening(port)).toBe(true)
    expect(await isListening(apiPort)).toBe(true)

    const status = run(tree, 'status', '--json').out
    expect(service(status, 'api')).toMatchObject({ state: 'running', port, basePort: apiPort, worktree: 'feature-x' })
    // External services keep their port: worktrees share the database.
    expect(service(status, 'db')).toMatchObject({ port: dbPort, worktree: 'feature-x' })
    expect(service(status, 'db').basePort).toBeUndefined()
    expect(service(run(main, 'status', '--json').out, 'api')).toMatchObject({ state: 'running', port: apiPort })
  })

  it('passes the offset ports to the command and keeps logs apart', () => {
    const offset = run(tree, 'status', '--json').out.portOffset
    const treeLines = run(tree, 'logs', 'api', '--json').out.lines.map((l: any) => l.text)
    expect(treeLines).toContain(`booting on ${apiPort + offset} with api=${apiPort + offset} db=${dbPort}`)
    const mainLines = run(main, 'logs', 'api', '--json').out.lines.map((l: any) => l.text)
    expect(mainLines).toContain(`booting on ${apiPort} with api=${apiPort} db=${dbPort}`)
    expect(mainLines.join('\n')).not.toContain(String(apiPort + offset))
  })

  it('keeps the offset across commands and loads', () => {
    const offset = run(tree, 'status', '--json').out.portOffset
    expect(loadProject(join(tree, 'portcall.json'), JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).offsets).portOffset).toBe(offset)
    expect(run(tree, 'up', 'api', '--json').out.portOffset).toBe(offset)
  })

  it('names a worktree as project@worktree from anywhere', () => {
    const { code, out } = run(tmpdir(), 'status', '-p', 'wtdemo@feature-x', '--json')
    expect(code).toBe(0)
    expect(out.worktree).toBe('feature-x')
    // The bare name is the main checkout's.
    expect(run(tmpdir(), 'status', '-p', 'wtdemo', '--json').out.worktree).toBeUndefined()
  })

  it('lists both checkouts in ports without a conflict', () => {
    const { code, out } = run(tmpdir(), 'ports', '--json')
    expect(code).toBe(0)
    const api = out.ports.filter((p: any) => p.project === 'wtdemo' && p.service === 'api')
    expect(api.map((p: any) => p.worktree ?? null).sort()).toEqual(['feature-x', null])
    expect(out.ports.every((p: any) => p.conflict.length === 0)).toBe(true)
  })

  it('stops a worktree without touching the main checkout', async () => {
    const offset = run(tree, 'status', '--json').out.portOffset
    expect(service(run(tree, 'down', 'api', '--json').out, 'api')).toMatchObject({ outcome: 'stopped' })
    expect(await isListening(apiPort + offset)).toBe(false)
    expect(await isListening(apiPort)).toBe(true)
  })
})
