import type { Project, Service } from './config.ts'
import type { Holder } from './ports.ts'
import type { State } from './state.ts'
import { sep } from 'node:path'
import { logPath } from './paths.ts'
import { descendsFrom, isListening, portHolder, processCommand, processCwds, processParents, treePorts, userListeners } from './ports.ts'
import { isAlive } from './proc.ts'
import { recordKey } from './state.ts'

/**
 * - running / starting: portcall runs it (listening or not yet)
 * - crashed: portcall ran it and it exited on its own
 * - stopped: nothing on its port
 * - unmanaged: its port is held by a process started in this project, outside portcall
 * - taken: its port is held by something else
 * - elsewhere: portcall runs it from another checkout of the project (a git worktree)
 */
export type ServiceState = 'running' | 'starting' | 'crashed' | 'stopped' | 'unmanaged' | 'taken' | 'elsewhere'

export interface ServiceStatus {
  project: string
  service: string
  port: number
  /** Set in a worktree with its own ports: the port declared in portcall.json. */
  basePort?: number
  /** Set in a linked worktree of a `worktrees: true` project. */
  worktree?: string
  url: string
  state: ServiceState
  external: boolean
  pid?: number
  startedAt?: number
  exitCode?: number | null
  exitSignal?: string | null
  root?: string
  holder?: Holder
  /** Set while portcall runs it and its port does not answer: the ports its process group listens on instead. */
  listeningOn?: number[]
  log?: string
}

/** A process started inside a project that listens on a port its portcall.json does not declare. */
export interface UndeclaredListener {
  project: string
  worktree?: string
  port: number
  pid: number
  command: string
  cwd: string
}

function inside(dir: string | undefined, root: string): boolean {
  return !!dir && (dir === root || dir.startsWith(root + sep))
}

export async function serviceStatus(project: Project, service: Service, state: State): Promise<ServiceStatus> {
  const base = {
    project: project.name,
    service: service.name,
    port: service.port,
    ...(service.port !== service.basePort ? { basePort: service.basePort } : {}),
    ...(project.worktree ? { worktree: project.worktree } : {}),
    url: `http://localhost:${service.port}`,
    external: !service.command,
  }
  const record = state.services[recordKey(project.instance, service.name)]

  if (record) {
    const alive = isAlive(record.supervisorPid) || isAlive(record.childPid)
    const managed = { pid: record.childPid ?? record.supervisorPid, startedAt: record.startedAt, log: record.log }
    if (record.root !== project.root && alive)
      return { ...base, ...managed, state: 'elsewhere', root: record.root }
    if (record.exitedAt || !alive)
      return { ...base, ...managed, state: 'crashed', exitCode: record.exitCode, exitSignal: record.exitSignal }
    if (await isListening(service.port))
      return { ...base, ...managed, state: 'running' }
    const listeningOn = record.childPid ? await treePorts(record.childPid) : []
    return { ...base, ...managed, state: 'starting', ...(listeningOn.length ? { listeningOn } : {}) }
  }

  const log = service.command ? logPath(project.instance, service.name) : undefined
  if (!(await isListening(service.port)))
    return { ...base, log, state: 'stopped' }
  if (base.external)
    return { ...base, state: 'running' }
  const holder = await portHolder(service.port)
  return { ...base, log, holder, pid: holder?.pid, state: inside(holder?.cwd, project.root) ? 'unmanaged' : 'taken' }
}

export async function projectStatus(project: Project, state: State, only?: Service[]): Promise<ServiceStatus[]> {
  return Promise.all((only ?? project.services).map(service => serviceStatus(project, service, state)))
}

/**
 * Listeners started inside these projects on ports they do not declare, e.g. a dev server that
 * slid to the next port, or one started by hand and forgotten. Servers portcall runs are left out.
 */
export async function undeclaredListeners(projects: Project[], state: State): Promise<UndeclaredListener[]> {
  const listeners = await userListeners()
  const pids = [...new Set(listeners.map(l => l.pid))]
  const [cwds, parents] = await Promise.all([processCwds(pids), processParents()])
  const managed = new Set(Object.values(state.services).map(r => r.supervisorPid))
  // Deepest root first: a worktree nested in its main checkout owns its own processes.
  const byDepth = [...projects].sort((a, b) => b.root.length - a.root.length)
  const found: Omit<UndeclaredListener, 'command'>[] = []
  for (const { pid, port } of listeners) {
    const cwd = cwds.get(pid)
    const project = byDepth.find(p => inside(cwd, p.root))
    if (!project || descendsFrom(pid, managed, parents) || project.services.some(s => s.port === port))
      continue
    found.push({ project: project.name, ...(project.worktree ? { worktree: project.worktree } : {}), port, pid, cwd: cwd! })
  }
  const commands = new Map(await Promise.all([...new Set(found.map(f => f.pid))].map(async pid => [pid, await processCommand(pid)] as const)))
  return found.map(f => ({ ...f, command: commands.get(f.pid) ?? '' })).sort((a, b) => a.port - b.port)
}
