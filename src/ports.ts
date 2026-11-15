import { execFile } from 'node:child_process'
import { readlink } from 'node:fs/promises'
import { connect } from 'node:net'
import process from 'node:process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** Vite and friends often bind `::1` only, so both loopbacks are tried. */
export async function isListening(port: number, timeoutMs = 500): Promise<boolean> {
  const results = await Promise.all(['127.0.0.1', '::1'].map(host => canConnect(host, port, timeoutMs)))
  return results.some(Boolean)
}

export interface Holder {
  pid: number
  command: string
  cwd?: string
}

/** Best effort: needs `lsof`, and only sees processes of the current user. */
export async function portHolder(port: number): Promise<Holder | undefined> {
  let stdout: string
  try {
    ({ stdout } = await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']))
  }
  catch {
    return undefined
  }
  const pid = Number(stdout.trim().split('\n')[0])
  if (!pid)
    return undefined
  const [command, cwd] = await Promise.all([processCommand(pid), processCwd(pid)])
  return { pid, command, cwd }
}

export interface Listener {
  pid: number
  port: number
}

/** Parses `lsof -F pn` output; a process listening on both loopbacks appears once per port. */
function parseListeners(stdout: string): Listener[] {
  const seen = new Set<string>()
  const out: Listener[] = []
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p'))
      pid = Number(line.slice(1))
    const port = line.startsWith('n') ? Number(line.slice(line.lastIndexOf(':') + 1)) : 0
    if (pid && port && !seen.has(`${pid}:${port}`)) {
      seen.add(`${pid}:${port}`)
      out.push({ pid, port })
    }
  }
  return out
}

/** Best effort, like `portHolder`: lsof exits 1 when it finds nothing. */
async function lsofListeners(args: string[]): Promise<Listener[]> {
  try {
    return parseListeners((await exec('lsof', ['-nP', '-a', ...args, '-iTCP', '-sTCP:LISTEN', '-Fpn'])).stdout)
  }
  catch {
    return []
  }
}

/** Parent pid of every process. */
export async function processParents(): Promise<Map<number, number>> {
  const parents = new Map<number, number>()
  try {
    const { stdout } = await exec('ps', ['-ax', '-o', 'pid=,ppid='])
    for (const line of stdout.trim().split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number)
      if (pid && ppid !== undefined)
        parents.set(pid, ppid)
    }
  }
  catch {}
  return parents
}

/** True when `pid` is one of `roots` or descends from one. */
export function descendsFrom(pid: number, roots: Set<number>, parents: Map<number, number>): boolean {
  for (let current: number | undefined = pid, depth = 0; current && current > 1 && depth < 64; current = parents.get(current), depth++) {
    if (roots.has(current))
      return true
  }
  return false
}

/**
 * Ports a process and its descendants listen on: what a service started by portcall actually opened.
 * By tree, not process group: pnpm runs scripts in groups of their own.
 */
export async function treePorts(pid: number): Promise<number[]> {
  const parents = await processParents()
  const roots = new Set([pid])
  const pids = [...parents.keys()].filter(p => descendsFrom(p, roots, parents))
  if (pids.length === 0)
    return []
  return [...new Set((await lsofListeners(['-p', pids.join(',')])).map(l => l.port))].sort((a, b) => a - b)
}

/** Every TCP listener of the current user. */
export function userListeners(): Promise<Listener[]> {
  return lsofListeners(['-u', String(process.getuid!())])
}

/** Working directories of several processes at once. */
export async function processCwds(pids: number[]): Promise<Map<number, string>> {
  const cwds = new Map<number, string>()
  if (pids.length === 0)
    return cwds
  if (process.platform === 'linux') {
    await Promise.all(pids.map(async (pid) => {
      const cwd = await processCwd(pid)
      if (cwd)
        cwds.set(pid, cwd)
    }))
    return cwds
  }
  try {
    const { stdout } = await exec('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'])
    let pid = 0
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p'))
        pid = Number(line.slice(1))
      else if (line.startsWith('n') && pid)
        cwds.set(pid, line.slice(1))
    }
  }
  catch {}
  return cwds
}

export async function processCommand(pid: number): Promise<string> {
  try {
    return (await exec('ps', ['-o', 'command=', '-p', String(pid)])).stdout.trim()
  }
  catch {
    return ''
  }
}

async function processCwd(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'linux')
      return await readlink(`/proc/${pid}/cwd`)
    const { stdout } = await exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    return stdout.split('\n').find(line => line.startsWith('n'))?.slice(1)
  }
  catch {
    return undefined
  }
}
