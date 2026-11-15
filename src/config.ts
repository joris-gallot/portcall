import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'

export const CONFIG_FILE = 'portcall.json'

const DEFAULT_READY_TIMEOUT = 60

const nameSchema = z.string().regex(/^\w[\w.-]*$/, 'use letters, digits, dot, dash or underscore')

const serviceSchema = z.strictObject({
  command: z.string().min(1).optional().describe('Shell command that runs the service. Omit it for an external service (a database in Docker...): portcall then only checks its port.'),
  port: z.number().int().min(1).max(65535).describe('Port the service listens on. Also passed to the command as PORT.'),
  cwd: z.string().optional().describe('Directory to run the command in, relative to portcall.json. Default: the project root.'),
  env: z.record(z.string(), z.string()).optional().describe('Extra environment. {port} is this service\'s port, {ports.<service>} another service\'s.'),
  readyTimeout: z.number().positive().optional().describe('Seconds `portcall up` waits for the port. Default: 60.'),
})

export const configSchema = z.strictObject({
  $schema: z.string().optional(),
  name: nameSchema.describe('Project name, used by `portcall -p <name>` and in the logs folder.'),
  services: z.record(nameSchema, serviceSchema).describe('The project\'s services, by name.'),
})

export interface Service {
  name: string
  port: number
  /** Absent for external services (a database in Docker...): portcall only checks their port. */
  command?: string
  cwd: string
  env: Record<string, string>
  readyTimeout: number
}

export interface Project {
  name: string
  root: string
  file: string
  services: Service[]
}

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

export function loadProject(file: string): Project {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  }
  catch (error) {
    throw new ConfigError(`${file}: ${(error as Error).message}`)
  }
  // Real path: process cwds (to tell this project's servers apart) come resolved, e.g. /private/var on macOS.
  return parseProject(raw, join(realpathSync(dirname(file)), basename(file)))
}

export function parseProject(raw: unknown, file: string): Project {
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

  const services = entries.map(([name, service]): Service => ({
    name,
    port: service.port,
    command: service.command,
    cwd: resolve(root, service.cwd ?? '.'),
    env: expandEnv(service.env ?? {}, service.port, ports, file, name),
    readyTimeout: service.readyTimeout ?? DEFAULT_READY_TIMEOUT,
  }))
  return { name: config.name, root, file, services }
}

/** Fills `{port}` (this service) and `{ports.<service>}` (any service of the project). */
function expandEnv(env: Record<string, string>, port: number, ports: Map<number, string>, file: string, service: string): Record<string, string> {
  const byName = new Map([...ports].map(([p, name]) => [name, p]))
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
