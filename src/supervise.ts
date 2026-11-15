import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { signalGroup } from './proc.ts'
import { recordKey, updateState } from './state.ts'

export interface SuperviseSpec {
  project: string
  service: string
  command: string
  cwd: string
  env: Record<string, string>
  log: string
}

const KILL_AFTER_MS = 5000
const CLOSE_GRACE_MS = 3000

// eslint-disable-next-line no-control-regex
const ANSI = /\x1B(?:\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\][^\x07]*(?:\x07|\x1B\\)|[\x40-\x5A\x5C-\x5F])/g

/** Plain text for the log: no escape codes, and a progress bar (`\r` rewrites) kept at its last state. */
export function cleanLine(line: string): string {
  const text = line.replace(ANSI, '')
  return text.slice(text.lastIndexOf('\r') + 1).trimEnd()
}

/**
 * Runs in its own detached process, one per service: starts the command in a
 * new process group, timestamps its output into the log, records how it ended.
 */
export function supervise(spec: SuperviseSpec): void {
  const key = recordKey(spec.project, spec.service)
  mkdirSync(dirname(spec.log), { recursive: true })
  if (existsSync(spec.log))
    renameSync(spec.log, `${spec.log}.1`)
  const out = createWriteStream(spec.log, { flags: 'a' })
  const write = (tag: string, text: string): void => {
    out.write(`${new Date().toISOString()} [${tag}] ${text}\n`)
  }

  write('portcall', `$ ${spec.command}`)
  const child = spawn('/bin/sh', ['-c', spec.command], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  for (const [stream, tag] of [[child.stdout, 'out'], [child.stderr, 'err']] as const) {
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => {
      const text = cleanLine(line)
      if (text)
        write(tag, text)
    })
  }

  void updateState((state) => {
    const record = state.services[key]
    if (record?.supervisorPid === process.pid)
      record.childPid = child.pid
  })

  let stopping = false
  const stop = (): void => {
    if (stopping)
      return
    stopping = true
    write('portcall', 'stopping')
    signalGroup(child.pid, 'SIGTERM')
    setTimeout(signalGroup, KILL_AFTER_MS, child.pid, 'SIGKILL').unref()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.on('SIGHUP', () => {})

  let finished = false
  const finish = async (code: number | null, sig: string | null): Promise<void> => {
    if (finished)
      return
    finished = true
    write('portcall', stopping ? 'stopped' : `exited with ${sig ? `signal ${sig}` : `code ${code}`}`)
    try {
      await updateState((state) => {
        const record = state.services[key]
        if (record?.supervisorPid !== process.pid)
          return
        if (stopping)
          delete state.services[key]
        else
          Object.assign(record, { exitCode: code, exitSignal: sig, exitedAt: Date.now() })
      })
    }
    finally {
      out.end(() => process.exit(0))
    }
  }

  child.on('error', (error) => {
    write('portcall', `failed to start: ${error.message}`)
    void finish(127, null)
  })
  child.on('exit', (code, sig) => {
    // Children left in the group would keep the pipes open, and `close` would never come.
    signalGroup(child.pid, 'SIGTERM')
    setTimeout(() => void finish(code, sig), CLOSE_GRACE_MS).unref()
    child.on('close', () => void finish(code, sig))
  })
}
