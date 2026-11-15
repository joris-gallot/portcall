#!/usr/bin/env node
import type { Io } from './commands.ts'
import type { SuperviseSpec } from './supervise.ts'
import { resolve } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import pkg from '../package.json' with { type: 'json' }
import { agents, down, logs, ports, restart, status, SUPERVISE_COMMAND, up } from './commands.ts'
import { parseSince } from './logs.ts'
import { supervise } from './supervise.ts'

const USAGE = `portcall - run your dev servers in the background, on fixed ports, with logs agents can read

Usage:
  portcall up [service...]        Start services (no-op for the ones already running), wait for their port
  portcall down [service...]      Stop services
  portcall restart [service...]   Stop then start
  portcall status [--all]         What runs, on which port (--all: every project portcall knows)
  portcall logs [service...]      Service output (all services when none named)
  portcall ports                  Every known project's ports, with conflicts
  portcall agents                 Print an AGENTS.md section telling coding agents how to use portcall

Options:
  -p, --project <name>  Act on a known project from anywhere (default: the portcall.json at or above the cwd);
                        <name>@<worktree> for a git worktree with its own ports
  -C, --cwd <dir>       Run as if started in <dir>
      --json            Machine-readable output
      --no-wait         up/restart: return without waiting for the port
      --force           down/restart: also stop a server of this project started outside portcall
  -h, --help            This help
  -v, --version         Print the version

Logs:
  -n, --lines <n>       Last n lines (default 100)
      --since <time>    Only lines after 30s, 5m, 2h, 1d or a date
      --grep <regex>    Only lines matching (case-insensitive)
      --errors          Only error lines, with their stack traces
  -f, --follow          Keep printing new lines

portcall.json, at the project root:
  {
    "name": "myapp",
    "services": {
      "server": { "command": "pnpm dev:server", "port": 3000 },
      "web": { "command": "pnpm dev:web", "port": 5173, "env": { "API_URL": "http://localhost:{ports.server}" } },
      "db": { "port": 5432 }
    }
  }
  A service without "command" is external (a database in Docker...): portcall only checks its port.
  Each command gets PORT set to its port. Logs and state live in ~/.portcall (PORTCALL_HOME).
  "worktrees": true gives each git worktree its own ports (declared + an offset), so they run at once.
`

async function main(argv: string[]): Promise<number> {
  if (argv[0] === SUPERVISE_COMMAND) {
    supervise(JSON.parse(argv[1]!) as SuperviseSpec)
    return -1
  }

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'project': { type: 'string', short: 'p' },
      'cwd': { type: 'string', short: 'C' },
      'json': { type: 'boolean' },
      'all': { type: 'boolean', short: 'a' },
      'no-wait': { type: 'boolean' },
      'force': { type: 'boolean' },
      'lines': { type: 'string', short: 'n' },
      'since': { type: 'string' },
      'grep': { type: 'string' },
      'errors': { type: 'boolean' },
      'follow': { type: 'boolean', short: 'f' },
      'help': { type: 'boolean', short: 'h' },
      'version': { type: 'boolean', short: 'v' },
    },
  })
  const io: Io = {
    json: !!values.json,
    out: text => process.stdout.write(`${text}\n`),
    err: text => process.stderr.write(`${text}\n`),
  }
  if (values.version) {
    io.out(pkg.version)
    return 0
  }
  const [command = 'help', ...names] = positionals
  if (values.help || command === 'help') {
    io.out(USAGE.trimEnd())
    return 0
  }

  const cwd = resolve(values.cwd ?? process.cwd())
  const project = values.project
  const wait = !values['no-wait']
  switch (command) {
    case 'up':
    case 'start':
      return up(io, cwd, names, { project, wait })
    case 'down':
    case 'stop':
      return down(io, cwd, names, { project, force: values.force })
    case 'restart':
      return restart(io, cwd, names, { project, force: values.force, wait })
    case 'status':
    case 'ps':
      return status(io, cwd, { project, all: values.all })
    case 'logs': {
      const lines = values.lines === undefined ? 100 : Number(values.lines)
      if (!Number.isInteger(lines) || lines < 1)
        throw new Error(`--lines: expected a positive number, got "${values.lines}"`)
      let grep: RegExp | undefined
      try {
        grep = values.grep === undefined ? undefined : new RegExp(values.grep, 'i')
      }
      catch {
        throw new Error(`--grep: invalid regular expression "${values.grep}"`)
      }
      return logs(io, cwd, names, {
        project,
        follow: values.follow,
        filter: { limit: lines, since: values.since === undefined ? undefined : parseSince(values.since), grep, errors: values.errors },
      })
    }
    case 'ports':
      return ports(io, cwd)
    case 'agents':
      return agents(io)
    default:
      throw new Error(`unknown command "${command}" (see \`portcall help\`)`)
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    // The supervisor keeps running; everything else exits with its code.
    if (code >= 0)
      process.exitCode = code
  },
  (error: Error) => {
    if (process.argv.includes('--json'))
      process.stdout.write(`${JSON.stringify({ error: error.message })}\n`)
    else
      process.stderr.write(`portcall: ${error.message}\n`)
    process.exitCode = 1
  },
)
