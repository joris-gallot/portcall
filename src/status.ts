import type { Project, Service } from './config.ts'
import type { Holder } from './ports.ts'
import type { State } from './state.ts'
import { sep } from 'node:path'
import { logPath } from './paths.ts'
import { isListening, portHolder } from './ports.ts'
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
  url: string
  state: ServiceState
  external: boolean
  pid?: number
  startedAt?: number
  exitCode?: number | null
  exitSignal?: string | null
  root?: string
  holder?: Holder
  log?: string
}

function inside(dir: string | undefined, root: string): boolean {
  return !!dir && (dir === root || dir.startsWith(root + sep))
}

export async function serviceStatus(project: Project, service: Service, state: State): Promise<ServiceStatus> {
  const base = {
    project: project.name,
    service: service.name,
    port: service.port,
    url: `http://localhost:${service.port}`,
    external: !service.command,
  }
  const record = state.services[recordKey(project.name, service.name)]

  if (record) {
    const alive = isAlive(record.supervisorPid) || isAlive(record.childPid)
    const managed = { pid: record.childPid ?? record.supervisorPid, startedAt: record.startedAt, log: record.log }
    if (record.root !== project.root && alive)
      return { ...base, ...managed, state: 'elsewhere', root: record.root }
    if (record.exitedAt || !alive)
      return { ...base, ...managed, state: 'crashed', exitCode: record.exitCode, exitSignal: record.exitSignal }
    return { ...base, ...managed, state: await isListening(service.port) ? 'running' : 'starting' }
  }

  const log = service.command ? logPath(project.name, service.name) : undefined
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
