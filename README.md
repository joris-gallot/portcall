# portcall

Run your local dev servers in the background, on fixed ports, with logs your coding agents can read.

When several apps run at once, dev servers pile up: ports to keep apart, terminals to keep open, and coding agents that start a second `pnpm dev`, forget the one they started, or can't see the backend error behind a failing request. portcall gives each project a `portcall.json`, runs its servers detached, and answers the questions an agent (or you) keeps asking:

```sh
portcall status                 # what runs, on which port
portcall up                     # start what is not running, wait for the ports
portcall logs server --errors   # the error behind that 500, with its stack trace
portcall restart web
portcall ports                  # every project's ports, and conflicts between them
```

## Install

```sh
npm i -g portcall
```

Node 20.19+, macOS or Linux.

## Configure

`portcall.json` at the project root:

```json
{
  "$schema": "https://unpkg.com/portcall/schema.json",
  "name": "myapp",
  "services": {
    "server": { "command": "pnpm dev:server", "port": 3000 },
    "web": {
      "command": "pnpm dev:web",
      "port": 5173,
      "env": { "VITE_API_URL": "http://localhost:{ports.server}" }
    },
    "db": { "port": 5432 }
  }
}
```

- Each command runs with `PORT` set to its service's port. `env` takes `{port}` and `{ports.<service>}`.
- A service without `command` is external (a database in Docker, a tunnel...): portcall only checks that its port answers.
- `cwd` runs a command in a subfolder; `readyTimeout` (seconds, default 60) bounds how long `up` waits for the port.
- `"worktrees": true` lets each git worktree run its own servers at the same time (see below).

### Git worktrees

By default, every checkout of a project shares its declared ports: one checkout runs a service at a time, and the others see it as `elsewhere`.

With `"worktrees": true`, each linked worktree gets its own ports. The first time portcall runs in a worktree, it picks an offset (a multiple of 10) that moves the worktree's services onto ports no known project declares and nothing listens on, and keeps it. The main checkout keeps the declared ports, and external services (a database...) keep theirs: worktrees share them.

```sh
cd ../myapp-feature-x      # git worktree add ../myapp-feature-x
portcall up                # server on 3010, web on 5183 (offset 10)
portcall status --json     # "port": 3010, "basePort": 3000, "worktree": "myapp-feature-x"
portcall logs -p myapp@myapp-feature-x
```

This only works if the app takes its ports from portcall rather than hardcoding them: read `PORT` (in `vite.config`, `server: { port: Number(process.env.PORT) || 5173, strictPort: true }`), and pass the other services' URLs through `env` with `{ports.<service>}`, including proxy targets and allowed origins.

## Commands

| Command | |
| --- | --- |
| `portcall up [service...]` | Start services and wait for their port. A no-op for services already running; prints the log tail when one crashes. A service that listens on another port than its own (Vite without `strictPort` when its port is taken...) is stopped and reported as `wrong-port`. |
| `portcall down [service...]` | Stop services (the whole process group, so `pnpm dev` takes its children with it). |
| `portcall restart [service...]` | Stop, then start. |
| `portcall status [--all]` | State, port, pid and uptime of each service; `--all` for every known project. Also lists processes started in the project that listen on ports `portcall.json` does not declare (`undeclaredPorts`): a server on the wrong port, or a forgotten one. |
| `portcall logs [service...]` | `-n 200`, `--since 5m`, `--grep <regex>`, `--errors`, `-f`. |
| `portcall ports` | Every known project's ports, with conflicts. Exits 1 on a conflict. |
| `portcall agents` | Prints a section to paste into `AGENTS.md` / `CLAUDE.md`. |

Every command takes `--json`, `-p <project>` (act on a known project from anywhere; `<project>@<worktree>` for a worktree with its own ports) and `-C <dir>`.

### Service states

| State | Meaning |
| --- | --- |
| `running` / `starting` | portcall runs it; its port answers / doesn't yet |
| `crashed` | portcall ran it and it exited on its own (`status` shows the exit code, `logs` why) |
| `stopped` | nothing on its port |
| `unmanaged` | its port is held by a process started inside the project, outside portcall (say, in a terminal). `up` leaves it be; `down --force` stops it |
| `taken` | its port is held by something outside the project. portcall never touches it |
| `elsewhere` | portcall runs it from another checkout of the project (a git worktree, without `"worktrees": true`) |

## With coding agents

Run `portcall agents` and paste the result into the project's agent instructions. Agents then check `portcall status` instead of guessing, start servers with `portcall up` (which never starts a second copy), and read `portcall logs --errors` after a failing request instead of asking you to copy the terminal.

In [Zeron](https://zeron.sh), the [portcall plugin](https://github.com/joris-gallot/portcall-zeron) shows a project's servers beside the chat, with start, stop and their errors.

## How it works

`portcall up` starts one small detached supervisor per service. It runs the command in its own process group, writes its output, timestamped and without escape codes, to `~/.portcall/logs/<project>/<service>.log` (the previous run is kept as `.log.1`), and records how the service ended. State lives in `~/.portcall` (`PORTCALL_HOME` to move it). Servers keep running when the terminal or agent session that started them ends.

## License

MIT
