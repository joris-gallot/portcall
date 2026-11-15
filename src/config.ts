import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { en } from 'zod/locales'
import * as z from 'zod/mini'

// zod/mini ships no messages by default.
z.config(en())

export const CONFIG_FILE = 'portcall.json'

const DEFAULT_READY_TIMEOUT = 60

const nameSchema = z.string().check(z.regex(/^\w[\w.-]*$/, 'use letters, digits, dot, dash or underscore'))

const serviceSchema = z.strictObject({
  command: z.optional(z.string().check(z.minLength(1))).check(z.describe('Shell command that runs the service. Omit it for an external service (a database in Docker...): portcall then only checks its port.')),
  port: z.int().check(z.minimum(1), z.maximum(65535), z.describe('Port the service listens on. Also passed to the command as PORT.')),
  cwd: z.optional(z.string()).check(z.describe('Directory to run the command in, relative to portcall.json. Default: the project root.')),
  env: z.optional(z.record(z.string(), z.string())).check(z.describe('Extra environment. {port} is this service\'s port, {ports.<service>} another service\'s.')),
  readyTimeout: z.optional(z.number().check(z.positive())).check(z.describe('Seconds `portcall up` waits for the port. Default: 60.')),
})

export const configSchema = z.strictObject({
  $schema: z.optional(z.string()),
  name: nameSchema.check(z.describe('Project name, used by `portcall -p <name>` and in the logs folder.')),
  services: z.record(nameSchema, serviceSchema).check(z.describe('The project\'s services, by name.')),
  worktrees: z.optional(z.boolean()).check(z.describe('Let each git worktree of the project run its services at the same time, on ports offset from the declared ones (external services keep theirs). Commands must take their port from PORT and {ports.<service>}. Default: false, all checkouts share the declared ports.')),
})

export interface Service {
  name: string
  /** The port it runs on: `basePort`, plus the worktree's offset for a service with a command. */
  port: number
  /** The port declared in portcall.json. */
  basePort: number
  /** Absent for external services (a database in Docker...): portcall only checks their port. */
  command?: string
  cwd: string
  env: Record<string, string>
  readyTimeout: number
}

export interface Project {
  name: string
  /** Keys its state and logs: the name, or `name@worktree` in a worktree with its own ports. */
  instance: string
  root: string
  file: string
  services: Service[]
  /** Set in a linked git worktree of a project with `worktrees: true`. */
  worktree?: string
  /** Added to the ports of a worktree's services; undefined until portcall assigns one. */
  portOffset?: number
}

/** Offsets of the worktrees with their own ports, by checkout root. */
export type PortOffsets = Record<string, number>

export class ConfigError extends Error {}

export function findConfig(from: string): string | undefined {
  let dir = resolve(from)
  for (;;) {
    const file = join(dir, CONFIG_FILE)
    if (existsSync(file))
      return file
    const parent = dirname(dir)
    if (parent === dir)
      return undefined
    dir = parent
  }
}

/** The worktree name when `dir` is inside a linked git worktree (not the main checkout). */
export function linkedWorktree(dir: string): string | undefined {
  for (let current = resolve(dir); ;) {
    const dotGit = join(current, '.git')
    if (existsSync(dotGit)) {
      let content: string
      try {
        content = readFileSync(dotGit, 'utf8')
      }
      catch {
        return undefined // a directory: the main checkout
      }
      const gitDir = /^gitdir: (.+)$/m.exec(content)?.[1]?.trim()
      if (!gitDir)
        return undefined
      const resolved = resolve(current, gitDir)
      // Submodules also use a .git file; only worktrees have a commondir.
      return existsSync(join(resolved, 'commondir')) ? basename(resolved) : undefined
    }
    const parent = dirname(current)
    if (parent === current)
      return undefined
    current = parent
  }
}

export function loadProject(file: string, offsets: PortOffsets = {}): Project {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  }
  catch (error) {
    throw new ConfigError(`${file}: ${(error as Error).message}`)
  }
  // Real path: process cwds (to tell this project's servers apart) come resolved, e.g. /private/var on macOS.
  return parseProject(raw, join(realpathSync(dirname(file)), basename(file)), offsets)
}

export function parseProject(raw: unknown, file: string, offsets: PortOffsets = {}): Project {
  const parsed = configSchema.safeParse(raw)
  if (!parsed.success)
    throw new ConfigError(`${file}:\n${z.prettifyError(parsed.error)}`)
  const config = parsed.data
  const root = dirname(file)
  const entries = Object.entries(config.services)
  if (entries.length === 0)
    throw new ConfigError(`${file}: "services" is empty`)

  const ports = new Map<number, string>()
  for (const [name, service] of entries) {
    const other = ports.get(service.port)
    if (other)
      throw new ConfigError(`${file}: services "${other}" and "${name}" both use port ${service.port}`)
    ports.set(service.port, name)
  }

  const worktree = config.worktrees ? linkedWorktree(root) : undefined
  const portOffset = worktree ? offsets[root] : undefined
  const effective = new Map(entries.map(([name, service]) => [name, service.port + (service.command ? portOffset ?? 0 : 0)]))
  const services = entries.map(([name, service]): Service => ({
    name,
    port: effective.get(name)!,
    basePort: service.port,
    command: service.command,
    cwd: resolve(root, service.cwd ?? '.'),
    env: expandEnv(service.env ?? {}, effective.get(name)!, effective, file, name),
    readyTimeout: service.readyTimeout ?? DEFAULT_READY_TIMEOUT,
  }))
  const instance = worktree ? `${config.name}@${worktree}` : config.name
  return { name: config.name, instance, root, file, services, ...(worktree ? { worktree, portOffset } : {}) }
}

/** Fills `{port}` (this service) and `{ports.<service>}` (any service of the project). */
function expandEnv(env: Record<string, string>, port: number, byName: Map<string, number>, file: string, service: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    out[key] = value.replace(/\{(port|ports\.([\w.-]+))\}/g, (_, whole: string, other?: string) => {
      if (whole === 'port')
        return String(port)
      const found = byName.get(other!)
      if (found === undefined)
        throw new ConfigError(`${file}: services.${service}.env.${key} refers to unknown service "${other}"`)
      return String(found)
    })
  }
  return out
}
