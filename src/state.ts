import type { PortOffsets, Project } from './config.ts'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { CONFIG_FILE, loadProject } from './config.ts'
import { portcallHome, projectsPath, statePath } from './paths.ts'

export interface ServiceRecord {
  project: string
  service: string
  root: string
  port: number
  command: string
  supervisorPid: number
  childPid?: number
  startedAt: number
  log: string
  exitCode?: number | null
  exitSignal?: string | null
  exitedAt?: number
}

export interface State {
  services: Record<string, ServiceRecord>
  /** Worktrees of `worktrees: true` projects, by checkout root. */
  offsets?: PortOffsets
}

const LOCK_WAIT_MS = 5000
const STALE_LOCK_MS = 10_000

export function recordKey(project: string, service: string): string {
  return `${project}/${service}`
}

export function readState(): State {
  try {
    const state = JSON.parse(readFileSync(statePath(), 'utf8'))
    if (state && typeof state.services === 'object')
      return state
  }
  catch {}
  return { services: {} }
}

export async function updateState<T>(fn: (state: State) => T): Promise<T> {
  return withLock(() => {
    const state = readState()
    const result = fn(state)
    writeJson(statePath(), state)
    return result
  })
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(portcallHome(), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, file)
}

async function withLock<T>(fn: () => T): Promise<T> {
  mkdirSync(portcallHome(), { recursive: true })
  const lock = join(portcallHome(), 'state.lock')
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'))
      break
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error
      // A portcall killed mid-write leaves its lock behind.
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS)
          unlinkSync(lock)
      }
      catch {}
      if (Date.now() > deadline)
        throw new Error(`state is locked (${lock}); delete it if no portcall command is running`)
      await sleep(20)
    }
  }
  try {
    return fn()
  }
  finally {
    try {
      unlinkSync(lock)
    }
    catch {}
  }
}

function readRoots(): string[] {
  try {
    const roots = JSON.parse(readFileSync(projectsPath(), 'utf8'))
    if (Array.isArray(roots))
      return roots.filter(r => typeof r === 'string')
  }
  catch {}
  return []
}

/** Remembers a project so `status --all`, `ports` and `--project` find it from anywhere. */
export function rememberProject(root: string): void {
  const roots = readRoots()
  if (!roots.includes(root))
    writeJson(projectsPath(), [...roots, root].sort())
}

export interface KnownProjects {
  projects: Project[]
  errors: string[]
}

export function knownProjects(): KnownProjects {
  const projects: Project[] = []
  const errors: string[] = []
  const kept: string[] = []
  const roots = readRoots()
  const offsets = readState().offsets
  for (const root of roots) {
    const file = join(root, CONFIG_FILE)
    if (!existsSync(file))
      continue
    kept.push(root)
    try {
      projects.push(loadProject(file, offsets))
    }
    catch (error) {
      errors.push((error as Error).message)
    }
  }
  if (kept.length !== roots.length)
    writeJson(projectsPath(), kept)
  return { projects, errors }
}
