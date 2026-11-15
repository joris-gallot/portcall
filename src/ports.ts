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

async function processCommand(pid: number): Promise<string> {
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
