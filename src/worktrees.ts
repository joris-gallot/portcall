import type { Project } from './config.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_FILE, loadProject } from './config.ts'
import { isListening } from './ports.ts'
import { knownProjects, readState, updateState } from './state.ts'

const OFFSET_STEP = 10
const MAX_TRIES = 100

/**
 * Gives a worktree of a `worktrees: true` project its port offset the first time portcall meets it:
 * the first multiple of 10 that moves its services onto ports no known project declares and nothing listens on.
 */
export async function withPortOffset(project: Project): Promise<Project> {
  if (!project.worktree || project.portOffset !== undefined)
    return project
  const claimed = new Set(knownProjects().projects.filter(p => p.root !== project.root).flatMap(p => p.services.map(s => s.port)))
  for (const service of project.services)
    claimed.add(service.basePort)
  const runnable = project.services.filter(s => s.command)

  let chosen: number | undefined
  for (let i = 1; i <= MAX_TRIES && chosen === undefined; i++) {
    const offset = i * OFFSET_STEP
    const ports = runnable.map(s => s.basePort + offset)
    if (ports.some(port => port > 65535))
      break
    if (ports.some(port => claimed.has(port)))
      continue
    if (!(await Promise.all(ports.map(port => isListening(port)))).some(Boolean))
      chosen = offset
  }
  if (chosen === undefined)
    throw new Error(`no free port offset for ${project.instance}: every candidate port is declared or in use`)

  await updateState((state) => {
    const offsets = state.offsets ??= {}
    for (const root of Object.keys(offsets)) {
      if (!existsSync(join(root, CONFIG_FILE)))
        delete offsets[root]
    }
    // A concurrent portcall in the same worktree may have assigned one first.
    offsets[project.root] ??= chosen
  })
  return loadProject(project.file, readState().offsets)
}
