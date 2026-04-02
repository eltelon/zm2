# CLAUDE.md - ZM2 Project Guide

## Project Overview

ZM2 is a **systemd-based** process manager for Node.js applications. Forked from PM2 6.0.14, published as `@zappinginc/zm2`. Licensed under AGPL-3.0. **Linux-only** (requires systemd). Minimum Node.js version: 16.

Each application is managed as a systemd service unit. No daemon, no fork/cluster mode, no custom log files — everything goes through systemd and journald.

## Quick Commands

```bash
npm test              # Run all tests (e2e + unit)
npm run test:unit     # Unit tests only (bash test/unit.sh)
npm run test:e2e      # E2E tests only (bash test/e2e.sh)
```

## Architecture

- **Entry points**: `index.js` (programmatic API), `bin/zm2` (CLI)
- **API** (`lib/API.js`): Main programmatic interface — uses `SystemdClient` instead of daemon RPC
- **SystemdClient** (`lib/SystemdClient.js`): Drop-in replacement for old `Client.js` — dispatches commands to systemd
- **Systemd** (`lib/Systemd.js`): Low-level wrapper around `systemctl` and `journalctl`
- **Systemd/UnitGenerator** (`lib/Systemd/UnitGenerator.js`): Generates systemd unit files from app config
- **Systemd/StateStore** (`lib/Systemd/StateStore.js`): Persists ZM2 metadata to `~/.zm2/state.json`
- **CLI** (`lib/binaries/CLI.js`): Commander.js-based CLI
- **API modules** (`lib/API/`): Dashboard, Deploy, Log (journalctl-based), Startup, Modules
- **Tools** (`lib/tools/`): Utility functions (Config, json5, sexec, which, etc.)

### Data Flow

```
CLI/API → SystemdClient.executeRemote(method, data)
  → dispatch to Systemd.js methods (systemctl/journalctl)
  → StateStore for metadata persistence
```

### Key Mappings (pm2_env → systemd)

| pm2_env field | systemd directive |
|---|---|
| `pm_exec_path` + `exec_interpreter` | `ExecStart` |
| `pm_cwd` | `WorkingDirectory` |
| `user` / `uid` | `User` |
| `autorestart` | `Restart=on-failure` or `Restart=no` |
| `restart_delay` | `RestartSec` |
| `max_restarts` | `StartLimitBurst` |
| `kill_timeout` | `TimeoutStopSec` |
| `max_memory_restart` | `MemoryMax` |
| `instances: N` | Template unit `zm2-app@.service` |
| `cron_restart` | Systemd timer unit |
| env vars | `EnvironmentFile=/etc/zm2/env/<name>.env` |

## Key Directories

```
bin/              CLI entry points (zm2, zm2-dev, zm2-docker, zm2-runtime)
lib/              Core source code
lib/Systemd/      Systemd integration (UnitGenerator, StateStore)
lib/API/          Extended API modules (Deploy, Log, Startup, Modules, etc.)
lib/binaries/     CLI implementations
lib/tools/        Utility functions
lib/templates/    Config templates
test/             Tests
test/programmatic/  Unit tests (Mocha + Should.js)
test/e2e/         End-to-end tests (bash scripts)
types/            TypeScript definitions
examples/         Example applications
```

## Systemd Service Files

Generated units are written to `/etc/systemd/system/zm2-<name>.service`.
Environment files go to `/etc/zm2/env/zm2-<name>.env`.
Requires root privileges.

## ZM2 Runtime Files

Located at `$HOME/.zm2/`:
- `state.json` — registered services metadata (pm_id, name, script, instances)
- `dump.zm2` — legacy process list dump (for migration)

## Logging

All logging goes through **journald**. Use `zm2 logs <name>` which wraps `journalctl -u zm2-<name>`.

## HTTP API & Prometheus

`zm2 api [--port 9615] [--host 127.0.0.1]` installs and starts an HTTP API as a systemd service (`zm2-api.service`). Subcommands:
- `zm2 api` — Install and start the service
- `zm2 api stop` — Stop the service
- `zm2 api restart` — Restart the service
- `zm2 api status` — Show running state and API key
- `zm2 api remove` — Stop and remove the service

Endpoints:
- `GET /metrics` — Prometheus metrics (no auth)
- `GET /api/processes` — List processes (requires bearer token)
- `POST /api/processes` — Create new process (requires bearer token, body: `{script, name?, cwd?, interpreter?, env?}`)
- `POST /api/processes/:name/start|stop|restart` — Control process (requires bearer token)

API key auto-generated on first run, stored at `~/.zm2/api-key`. Printed to stdout on `zm2 api` and `zm2 api status`.
Logs: `journalctl -u zm2-api -f`

## Naming Convention (Fork from PM2)

- **User-facing**: All CLI commands, console messages, env vars, and paths use `zm2`/`ZM2`
- **Internal**: Variable names (`pm2_env`, `pm2_home`) and object property keys (`PM2_ROOT_PATH`) remain as `pm2` for compatibility
- **Env vars**: `ZM2_HOME`, `ZM2_DEBUG`, etc. are preferred, with fallback to `PM2_*` equivalents

## Removed Features (vs upstream PM2)

- **No daemon** — CLI talks directly to systemd
- **No fork/cluster mode** — all apps run as `Type=simple` systemd services
- **No custom log files** — journald handles all logging
- **No file watching** — removed chokidar
- **No pm2-plus** — removed @pm2/agent, @pm2/io integration
- **No pm2-axon/RPC** — removed socket-based communication

## Code Style

- **Indentation**: 2 spaces (tabs for Makefiles)
- **Line endings**: LF
- **Charset**: UTF-8
- **Trailing whitespace**: trimmed
- **Final newline**: yes
- No linter configured; follow existing patterns

## Test Configuration (Mocha)

- Timeout: 10000ms
- Bail: true (exit on first failure)
- Retries: 2
- UI: BDD
- Exit: true

New systemd-specific tests:
- `test/programmatic/systemd_unit_generator.mocha.js` — UnitGenerator tests
- `test/programmatic/systemd_state_store.mocha.js` — StateStore tests

## Commit Message Convention

Prefix commits with: `fix:`, `hotfix:`, `feat:`, `docs:`, `BREAKING:`, `refactor:`, `perf:`, `style:`, `test:`, `chore:`

Keep description under 50 chars, lowercase except proper nouns/acronyms.

## CI

GitHub Actions on push/PR — tests on Node 16.x and 24.x, plus separate Bun tests. E2E tests require Linux with systemd. 30-minute timeout.

## Key Dependencies

- `commander` (CLI), `async`, `pidusage` (process monitoring), `js-yaml`, `dayjs`, `cli-tableau` (tables), `@pm2/blessed` (dashboard TUI), `pm2-deploy` (deployment)
