# portcall

CLI that runs local dev servers detached, on the ports declared in each project's `portcall.json`, with logs agents can read. Published to npm as `portcall`. Must stay usable on its own: no dependency on any editor or agent host.

## Layout

- `src/cli.ts`: argv parsing and usage; also the entry of the hidden `__supervise` command.
- `src/commands.ts`: `up`, `down`, `restart`, `status`, `logs`, `ports`, `agents`.
- `src/supervise.ts`: the detached per-service supervisor (process group, timestamped log, exit record).
- `src/status.ts`: a service's state from the state file, its pids and its port.
- `src/state.ts`: `~/.portcall/state.json` (locked updates) and the known projects list.
- `src/config.ts`: `portcall.json` schema (zod). Run `node scripts/schema.ts` after changing it, to regenerate `schema.json`.

## Conventions

- Node runs the TypeScript sources directly (type stripping): imports end in `.ts`, no enums or parameter properties.
- No runtime dependencies: zod (`zod/mini`) is a devDependency that tsdown bundles into `dist`. Bundle any new library the same way.
- Output is for agents first: short, stable wording, every command with `--json`. Changing a JSON field is a breaking change.
- `pnpm lint:fix`, `pnpm typecheck`, `pnpm test` (the CLI tests spawn real servers) and `pnpm build` must pass.
