import type { Project, Service } from './config.ts'
import type { LogFilter, LogLine } from './logs.ts'
import type { ServiceRecord } from './state.ts'
import type { ServiceStatus } from './status.ts'
import type { SuperviseSpec } from './supervise.ts'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { ConfigError, findConfig, loadProject } from './config.ts'
import { filterLines, followLogs, formatLine, mergeLogs, readLog } from './logs.ts'
import { logPath } from './paths.ts'
import { isListening } from './ports.ts'
import { isAlive, signal, signalGroup, waitForDeath } from './proc.ts'
import { knownProjects, readState, recordKey, rememberProject, updateState } from './state.ts'
import { projectStatus } from './status.ts'
import { withPortOffset } from './worktrees.ts'

export const SUPERVISE_COMMAND = '__supervise'

const STOP_WAIT_MS = 8000
const CRASH_TAIL_LINES = 30

export interface Io {
  json: boolean
  out: (text: string) => void
  err: (text: string) => void
}

export class UsageError extends Error {}

// ---------------------------------------------------------------- projects

/** `name` is a project name, or `name@worktree` for a worktree with its own ports. */
export async function resolveProject(cwd: string, name?: string): Promise<Project> {
  if (name) {
    const { projects } = knownProjects()
    const exact = projects.filter(project => project.instance === name)
    const matches = exact.length ? exact : projects.filter(project => project.name === name)
    if (matches.length === 0)
      throw new UsageError(`unknown project "${name}": run any portcall command once inside it so portcall knows where it is`)
    const here = matches.find(project => cwd === project.root || cwd.startsWith(`${project.root}/`))
    if (here || matches.length === 1)
      return withPortOffset(here ?? matches[0]!)
    throw new UsageError(`"${name}" exists in several checkouts, run portcall from the one you want${matches.some(p => p.worktree) ? ' or name it as project@worktree' : ''}:\n${matches.map(p => `  ${p.instance}  ${p.root}`).join('\n')}`)
  }
  const file = findConfig(cwd)
  if (!file)
    throw new ConfigError(`no portcall.json in ${cwd} or above (see \`portcall help\`)`)
  const project = await withPortOffset(loadProject(file, readState().offsets))
  rememberProject(project.root)
  return project
}

function selectServices(project: Project, names: string[], runnableOnly = false): Service[] {
  if (names.length === 0)
    return runnableOnly ? project.services.filter(s => s.command) : project.services
  return names.map((name) => {
    const service = project.services.find(s => s.name === name)
    if (!service)
      throw new UsageError(`${project.name} has no service "${name}" (services: ${project.services.map(s => s.name).join(', ')})`)
    if (runnableOnly && !service.command)
      throw new UsageError(`${project.name}/${name} is external (no command): portcall only checks its port`)
    return service
  })
}

// ---------------------------------------------------------------- output

function worktreeFields(project: Project): { worktree?: string, portOffset?: number } {
  return project.worktree ? { worktree: project.worktree, portOffset: project.portOffset } : {}
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(row => row[i]!.length)))
  return rows.map(row => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n')
}

export function duration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60)
    return `${s}s`
  if (s < 3600)
    return `${Math.floor(s / 60)}m`
  if (s < 86_400)
    return `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}`
  return `${Math.floor(s / 86_400)}d`
}

function short(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function describe(status: ServiceStatus): string {
  switch (status.state) {
    case 'crashed':
      return status.exitSignal ? `killed by ${status.exitSignal}` : `exit code ${status.exitCode ?? '?'}`
    case 'unmanaged':
      return `started outside portcall: ${short(status.holder?.command ?? '?')}`
    case 'taken':
      return `port held by ${status.holder ? `${short(status.holder.command)} (${status.holder.cwd ?? '?'})` : 'another process'}`
    case 'elsewhere':
      return `run from ${status.root}`
    default:
      return status.external ? 'external' : ''
  }
}

function statusRows(statuses: ServiceStatus[], withProject: boolean): string[][] {
  const head = [...(withProject ? ['PROJECT'] : []), 'SERVICE', 'STATE', 'PORT', 'PID', 'UPTIME', 'INFO']
  const now = Date.now()
  return [head, ...statuses.map(s => [
    ...(withProject ? [s.worktree ? `${s.project}@${s.worktree}` : s.project] : []),
    s.service,
    s.state,
    String(s.port),
    s.pid ? String(s.pid) : '-',
    s.startedAt && (s.state === 'running' || s.state === 'starting') ? duration(now - s.startedAt) : '-',
    describe(s),
  ])]
}

// ---------------------------------------------------------------- status

export async function status(io: Io, cwd: string, opts: { project?: string, all?: boolean }): Promise<number> {
  const state = readState()
  if (opts.all) {
    const { projects, errors } = knownProjects()
    const statuses = (await Promise.all(projects.map(p => projectStatus(p, state)))).flat()
    if (io.json) {
      io.out(JSON.stringify({ services: statuses, errors }, null, 2))
    }
    else {
      io.out(statuses.length ? table(statusRows(statuses, true)) : 'no known projects yet: run portcall once inside a project')
      errors.forEach(e => io.err(`portcall: ${e}`))
    }
    return 0
  }
  const project = await resolveProject(cwd, opts.project)
  const statuses = await projectStatus(project, state)
  io.out(io.json ? JSON.stringify({ project: project.name, ...worktreeFields(project), root: project.root, services: statuses }, null, 2) : table(statusRows(statuses, false)))
  return 0
}

// ---------------------------------------------------------------- up

type Outcome = 'started' | 'already-running' | 'running-outside' | 'external-up' | 'external-down' | 'crashed' | 'timeout' | 'blocked'

interface UpResult {
  service: string
  port: number
  url: string
  outcome: Outcome
  pid?: number
  detail?: string
  logTail?: string[]
}

const UP_FAILURES: Outcome[] = ['crashed', 'timeout', 'blocked']

function startService(project: Project, service: Service, state: { services: Record<string, ServiceRecord> }): { pid: number, exited: () => boolean } {
  const log = logPath(project.instance, service.name)
  const spec: SuperviseSpec = {
    project: project.instance,
    service: service.name,
    command: service.command!,
    cwd: service.cwd,
    env: { PORT: String(service.port), ...service.env },
    log,
  }
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, SUPERVISE_COMMAND, JSON.stringify(spec)], {
    cwd: service.cwd,
    detached: true,
    stdio: 'ignore',
  })
  if (!child.pid)
    throw new Error(`could not start the supervisor for ${service.name}`)
  // Read through the event, not the pid: an exited child of ours stays a zombie until we exit.
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  child.unref()
  state.services[recordKey(project.instance, service.name)] = {
    project: project.instance,
    service: service.name,
    root: project.root,
    port: service.port,
    command: service.command!,
    supervisorPid: child.pid,
    startedAt: Date.now(),
    log,
  }
  return { pid: child.pid, exited: () => exited }
}

async function waitReady(service: Service, exited: () => boolean): Promise<'ready' | 'exited' | 'timeout'> {
  const deadline = Date.now() + service.readyTimeout * 1000
  for (;;) {
    if (exited())
      return 'exited'
    if (await isListening(service.port, 300))
      return 'ready'
    if (Date.now() > deadline)
      return 'timeout'
    await sleep(200)
  }
}

export async function up(io: Io, cwd: string, names: string[], opts: { project?: string, wait: boolean }): Promise<number> {
  const project = await resolveProject(cwd, opts.project)
  const services = selectServices(project, names)
  const statuses = await projectStatus(project, readState(), services)
  const results: UpResult[] = []
  const toStart: Service[] = []

  for (const [i, st] of statuses.entries()) {
    const base = { service: st.service, port: st.port, url: st.url }
    switch (st.state) {
      case 'running':
      case 'starting':
        results.push({ ...base, outcome: st.external ? 'external-up' : 'already-running', pid: st.pid })
        break
      case 'unmanaged':
        results.push({ ...base, outcome: 'running-outside', pid: st.pid, detail: describe(st) })
        break
      case 'elsewhere':
      case 'taken':
        results.push({ ...base, outcome: 'blocked', pid: st.pid, detail: describe(st) })
        break
      case 'stopped':
      case 'crashed':
        if (st.external)
          results.push({ ...base, outcome: 'external-down', detail: 'nothing listens on this port; portcall does not start external services' })
        else
          toStart.push(services[i]!)
    }
  }

  const started = await updateState(state => toStart.map(service => ({ service, ...startService(project, service, state) })))
  results.push(...await Promise.all(started.map(async ({ service, pid, exited }): Promise<UpResult> => {
    const base = { service: service.name, port: service.port, url: `http://localhost:${service.port}`, pid }
    if (!opts.wait)
      return { ...base, outcome: 'started', detail: 'not waiting for the port' }
    const t0 = Date.now()
    const ready = await waitReady(service, exited)
    if (ready === 'ready')
      return { ...base, outcome: 'started', detail: `ready in ${((Date.now() - t0) / 1000).toFixed(1)}s` }
    const logTail = readLog(logPath(project.instance, service.name), service.name).slice(-CRASH_TAIL_LINES).map(l => formatLine(l))
    if (ready === 'exited') {
      const record = readState().services[recordKey(project.instance, service.name)]
      return { ...base, outcome: 'crashed', detail: `exited before listening (code ${record?.exitCode ?? '?'})`, logTail }
    }
    return { ...base, outcome: 'timeout', detail: `still running but nothing listens on ${service.port} after ${service.readyTimeout}s (wrong port in portcall.json?)`, logTail }
  })))

  const order = new Map(services.map((s, i) => [s.name, i]))
  results.sort((a, b) => order.get(a.service)! - order.get(b.service)!)
  const failed = results.some(r => UP_FAILURES.includes(r.outcome))
  if (io.json) {
    io.out(JSON.stringify({ project: project.name, ...worktreeFields(project), ok: !failed, services: results }, null, 2))
  }
  else {
    io.out(table([['SERVICE', 'RESULT', 'URL', 'PID', 'INFO'], ...results.map(r => [r.service, r.outcome, r.url, r.pid ? String(r.pid) : '-', r.detail ?? ''])]))
    for (const r of results.filter(r => r.logTail?.length))
      io.out(`\n--- ${r.service}: last log lines (portcall logs ${r.service}) ---\n${r.logTail!.join('\n')}`)
  }
  return failed ? 1 : 0
}

// ---------------------------------------------------------------- down

async function stopRecord(record: ServiceRecord): Promise<void> {
  if (!record.exitedAt) {
    signal(record.supervisorPid, 'SIGTERM')
    if (!(await waitForDeath(record.supervisorPid, STOP_WAIT_MS)))
      signal(record.supervisorPid, 'SIGKILL')
    if (isAlive(record.childPid)) {
      signalGroup(record.childPid, 'SIGTERM')
      if (!(await waitForDeath(record.childPid!, 3000)))
        signalGroup(record.childPid, 'SIGKILL')
    }
  }
  await updateState((state) => {
    const key = recordKey(record.project, record.service)
    if (state.services[key]?.supervisorPid === record.supervisorPid)
      delete state.services[key]
  })
}

async function stopPid(pid: number): Promise<void> {
  signal(pid, 'SIGTERM')
  if (!(await waitForDeath(pid, STOP_WAIT_MS)))
    signal(pid, 'SIGKILL')
}

interface DownResult {
  service: string
  outcome: 'stopped' | 'not-running' | 'skipped'
  detail?: string
}

export async function down(io: Io, cwd: string, names: string[], opts: { project?: string, force?: boolean, quiet?: boolean }): Promise<number> {
  const project = await resolveProject(cwd, opts.project)
  const services = selectServices(project, names)
  const state = readState()
  const statuses = await projectStatus(project, state, services)
  const results = await Promise.all(statuses.map(async (st): Promise<DownResult> => {
    const record = state.services[recordKey(project.instance, st.service)]
    if (st.external)
      return { service: st.service, outcome: 'skipped', detail: 'external, not managed by portcall' }
    switch (st.state) {
      case 'running':
      case 'starting':
      case 'crashed':
        await stopRecord(record!)
        return { service: st.service, outcome: 'stopped' }
      case 'elsewhere':
        if (!opts.force)
          return { service: st.service, outcome: 'skipped', detail: `${describe(st)}; --force to stop it from here` }
        await stopRecord(record!)
        return { service: st.service, outcome: 'stopped', detail: describe(st) }
      case 'unmanaged':
        if (!opts.force)
          return { service: st.service, outcome: 'skipped', detail: `${describe(st)} (pid ${st.pid}); --force to stop it` }
        await stopPid(st.pid!)
        return { service: st.service, outcome: 'stopped', detail: describe(st) }
      case 'taken':
        return { service: st.service, outcome: 'skipped', detail: `${describe(st)}; not part of this project, portcall leaves it alone` }
      case 'stopped':
        return { service: st.service, outcome: 'not-running' }
    }
  }))
  if (!opts.quiet) {
    if (io.json)
      io.out(JSON.stringify({ project: project.name, services: results }, null, 2))
    else
      io.out(table([['SERVICE', 'RESULT', 'INFO'], ...results.map(r => [r.service, r.outcome, r.detail ?? ''])]))
  }
  return 0
}

export async function restart(io: Io, cwd: string, names: string[], opts: { project?: string, force?: boolean, wait: boolean }): Promise<number> {
  const project = await resolveProject(cwd, opts.project)
  const runnable = selectServices(project, names, true).map(s => s.name)
  await down(io, cwd, runnable, { ...opts, quiet: true })
  return up(io, cwd, runnable, opts)
}

// ---------------------------------------------------------------- logs

export async function logs(io: Io, cwd: string, names: string[], opts: { project?: string, filter: LogFilter, follow?: boolean }): Promise<number> {
  const project = await resolveProject(cwd, opts.project)
  const services = selectServices(project, names, true)
  const files = services.map(s => ({ file: logPath(project.instance, s.name), service: s.name }))
  const width = services.length > 1 ? Math.max(...services.map(s => s.name.length)) : 0
  const lines = filterLines(mergeLogs(files.map(f => readLog(f.file, f.service))), opts.filter)
  const toJson = (l: LogLine): object => ({ time: l.time?.toISOString(), service: l.service, stream: l.tag, text: l.text })

  if (io.json && !opts.follow)
    io.out(JSON.stringify({ project: project.name, lines: lines.map(toJson) }, null, 2))
  else if (lines.length)
    lines.forEach(l => io.out(io.json ? JSON.stringify(toJson(l)) : formatLine(l, width)))
  else if (!opts.follow)
    io.out(files.some(f => readLog(f.file, f.service).length) ? '(no matching lines)' : '(no logs yet: start it with `portcall up`)')

  if (opts.follow)
    await followLogs(files, l => io.out(io.json ? JSON.stringify(toJson(l)) : formatLine(l, width)), opts.filter)
  return 0
}

// ---------------------------------------------------------------- ports

export async function ports(io: Io, cwd: string): Promise<number> {
  if (findConfig(cwd))
    await resolveProject(cwd)
  const { projects, errors } = knownProjects()
  const state = readState()
  // Checkouts share external services, and every port without `worktrees: true`: those claims go by project name.
  const claimant = (project: Project, service: Service): string => service.command ? project.instance : project.name
  const claims = new Map<number, Set<string>>()
  for (const project of projects) {
    for (const service of project.services)
      claims.set(service.port, (claims.get(service.port) ?? new Set()).add(claimant(project, service)))
  }
  const seen = new Set<string>()
  const rows: (ServiceStatus & { conflict: string[] })[] = []
  for (const project of projects) {
    if (seen.has(project.instance))
      continue
    seen.add(project.instance)
    for (const [i, st] of (await projectStatus(project, state)).entries()) {
      const own = claimant(project, project.services[i]!)
      const others = [...claims.get(st.port)!].filter(name => name !== own)
      rows.push({ ...st, conflict: others })
    }
  }
  rows.sort((a, b) => a.port - b.port)
  if (io.json) {
    io.out(JSON.stringify({ ports: rows, errors }, null, 2))
  }
  else {
    io.out(rows.length
      ? table([['PORT', 'PROJECT', 'SERVICE', 'STATE', 'INFO'], ...rows.map(r => [
          String(r.port),
          r.worktree ? `${r.project}@${r.worktree}` : r.project,
          r.service,
          r.state,
          [r.conflict.length ? `CONFLICT with ${r.conflict.join(', ')}` : '', describe(r)].filter(Boolean).join('; '),
        ])])
      : 'no known projects yet: run portcall once inside a project')
    errors.forEach(e => io.err(`portcall: ${e}`))
  }
  return rows.some(r => r.conflict.length) ? 1 : 0
}

// ---------------------------------------------------------------- agents

export const AGENTS_SNIPPET = `## Dev servers

Dev servers run under portcall (config: \`portcall.json\`). Never start them yourself (no \`pnpm dev\`, \`vite\`, \`tsx watch\`, \`node --watch\`...).

- \`portcall status\`: what runs, on which port. Check it before assuming a server is down.
- \`portcall up [service]\`: start what is not running; a no-op for what already is. It waits for the port and prints the log tail if the server crashes.
- \`portcall restart <service>\`: after changing env, config or dependencies (watch mode reloads code by itself).
- \`portcall logs <service> --errors\`, \`--since 2m\`, \`--grep <regex>\`, \`-n 200\`: server output, e.g. after a failing request.
- Leave servers running when you are done. Add \`--json\` to any command for machine-readable output.
`

export function agents(io: Io): number {
  io.out(AGENTS_SNIPPET.trimEnd())
  return 0
}
