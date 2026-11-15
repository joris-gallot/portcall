import type { ChildProcess } from 'node:child_process'
import type { Server } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isListening } from '../src/ports.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

const SERVER = `
import { createServer } from 'node:http'
const port = Number(process.env.PORT)
console.log('booting on ' + port + ' with ' + process.env.GREETING)
createServer((req, res) => {
  if (req.url === '/boom') {
    console.error('Error: boom from handler')
    console.error('    at handler (server.mjs:6:5)')
    res.statusCode = 500
  }
  res.end('ok')
}).listen(port, '127.0.0.1', () => console.log('listening'))
`

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise(resolve => server.close(resolve))
  return port
}

let root: string
let home: string
const ports: Record<string, number> = {}

function run(...args: string[]): { code: number, out: any, text: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: { ...process.env, PORTCALL_HOME: home },
    encoding: 'utf8',
    timeout: 30_000,
  })
  const text = result.stdout + result.stderr
  let out: any
  try {
    out = JSON.parse(result.stdout)
  }
  catch {}
  return { code: result.status ?? -1, out, text }
}

function service(out: any, name: string): any {
  return out.services.find((s: any) => s.service === name)
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'portcall-app-')))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'portcall-home-')))
  for (const name of ['api', 'crash', 'db', 'taken'])
    ports[name] = await freePort()
  writeFileSync(join(root, 'server.mjs'), SERVER)
  writeFileSync(join(root, 'portcall.json'), JSON.stringify({
    name: 'demo',
    services: {
      api: { command: 'node server.mjs', port: ports.api, env: { GREETING: 'hello-{port}' }, readyTimeout: 10 },
      crash: { command: `node -e "console.error('Error: cannot find module x'); process.exit(3)"`, port: ports.crash, readyTimeout: 10 },
      db: { port: ports.db },
      taken: { command: 'node server.mjs', port: ports.taken, readyTimeout: 10 },
    },
  }))
})

afterAll(() => {
  run('down', '--force')
})

describe('portcall', () => {
  it('starts a service, waits for its port and logs its output', async () => {
    const { code, out } = run('up', 'api', 'db', '--json')
    expect(code).toBe(0)
    expect(service(out, 'api')).toMatchObject({ outcome: 'started' })
    expect(service(out, 'db')).toMatchObject({ outcome: 'external-down' })
    expect(await isListening(ports.api!)).toBe(true)

    const status = run('status', '--json').out
    expect(service(status, 'api')).toMatchObject({ state: 'running', port: ports.api })
    expect(service(status, 'db')).toMatchObject({ state: 'stopped', external: true })

    const logs = run('logs', 'api', '--json').out
    expect(logs.lines.map((l: any) => l.text)).toContain(`booting on ${ports.api} with hello-${ports.api}`)
  })

  it('does not start a running service twice', () => {
    const { code, out } = run('up', 'api', '--json')
    expect(code).toBe(0)
    expect(service(out, 'api')).toMatchObject({ outcome: 'already-running' })
  })

  it('finds errors with their stack in the logs', async () => {
    await fetch(`http://127.0.0.1:${ports.api}/boom`)
    await new Promise(resolve => setTimeout(resolve, 300))
    const { out } = run('logs', 'api', '--errors', '--json')
    expect(out.lines.map((l: any) => l.text)).toEqual(['Error: boom from handler', '    at handler (server.mjs:6:5)'])
    expect(out.lines[0].stream).toBe('err')
  })

  it('reports a crash with the log tail and keeps it in status', () => {
    const { code, out } = run('up', 'crash', '--json')
    expect(code).toBe(1)
    expect(service(out, 'crash')).toMatchObject({ outcome: 'crashed' })
    expect(service(out, 'crash').logTail.join('\n')).toContain('cannot find module x')
    expect(service(run('status', '--json').out, 'crash')).toMatchObject({ state: 'crashed', exitCode: 3 })
    run('down', 'crash')
    expect(service(run('status', '--json').out, 'crash')).toMatchObject({ state: 'stopped' })
  })

  it('refuses a port held by a process outside the project', async () => {
    const intruder: Server = createServer()
    await new Promise<void>(resolve => intruder.listen(ports.taken, '127.0.0.1', resolve))
    try {
      const { code, out } = run('up', 'taken', '--json')
      expect(code).toBe(1)
      expect(service(out, 'taken')).toMatchObject({ outcome: 'blocked' })
    }
    finally {
      await new Promise(resolve => intruder.close(resolve))
    }
  })

  it('sees a server of the project started by hand, and stops it only with --force', async () => {
    const manual: ChildProcess = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(ports.taken) }, stdio: 'ignore' })
    try {
      for (let i = 0; i < 50 && !(await isListening(ports.taken!)); i++)
        await new Promise(resolve => setTimeout(resolve, 100))
      expect(service(run('status', '--json').out, 'taken')).toMatchObject({ state: 'unmanaged', pid: manual.pid })
      expect(service(run('up', 'taken', '--json').out, 'taken')).toMatchObject({ outcome: 'running-outside' })
      expect(service(run('down', 'taken', '--json').out, 'taken')).toMatchObject({ outcome: 'skipped' })
      expect(service(run('down', 'taken', '--force', '--json').out, 'taken')).toMatchObject({ outcome: 'stopped' })
      expect(await isListening(ports.taken!)).toBe(false)
    }
    finally {
      manual.kill()
    }
  })

  it('stops a service and frees its port', async () => {
    const { code, out } = run('down', '--json')
    expect(code).toBe(0)
    expect(service(out, 'api')).toMatchObject({ outcome: 'stopped' })
    expect(await isListening(ports.api!)).toBe(false)
    expect(service(run('status', '--json').out, 'api')).toMatchObject({ state: 'stopped' })
  })

  it('lists known projects and their ports from anywhere', () => {
    const { out } = run('ports', '--json', '-C', tmpdir())
    expect(out.ports.map((p: any) => p.port).sort()).toEqual(Object.values(ports).sort())
  })
})
