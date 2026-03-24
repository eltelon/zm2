# CLAUDE.md - PM2 Project Guide

## Project Overview

PM2 is a production process manager for Node.js/Bun applications with a built-in load balancer. Version 6.0.14, licensed under AGPL-3.0. Minimum Node.js version: 16.

## Quick Commands

```bash
npm test              # Run all tests (e2e + unit)
npm run test:unit     # Unit tests only (bash test/unit.sh)
npm run test:e2e      # E2E tests only (bash test/e2e.sh)
pm2 update            # Restart daemon after modifying Daemon.js, God.js, God/*, Watcher.js
```

## Architecture

- **Entry points**: `index.js` (programmatic API), `bin/pm2` (CLI)
- **API** (`lib/API.js`): Main programmatic interface, ~1900 lines
- **Daemon** (`lib/Daemon.js`): Daemon lifecycle, uses pm2-axon for RPC/messaging
- **God** (`lib/God.js` + `lib/God/`): Core process monitoring — ClusterMode, ForkMode, Reload, ActionMethods
- **Client** (`lib/Client.js`): RPC client for daemon communication
- **CLI** (`lib/binaries/CLI.js`): Commander.js-based CLI with 90+ options
- **Process containers**: `ProcessContainer.js` (Node), `ProcessContainerBun.js` (Bun)
- **API modules** (`lib/API/`): Dashboard, Deploy, Log, Startup, Modules, pm2-plus, etc.
- **Tools** (`lib/tools/`): Utility functions (Config, json5, sexec, which, etc.)

## Key Directories

```
bin/          CLI entry points (pm2, pm2-dev, pm2-docker, pm2-runtime)
lib/          Core source code
lib/API/      Extended API modules (Deploy, Log, Startup, Modules, etc.)
lib/God/      Process management submodules (ClusterMode, ForkMode, Reload)
lib/binaries/ CLI implementations
lib/tools/    Utility functions
lib/templates/ Config templates & init scripts (systemd, upstart, launchd)
test/         Tests
test/programmatic/  Unit tests (Mocha + Should.js)
test/e2e/     End-to-end tests (bash scripts)
test/fixtures/ Test fixtures
types/        TypeScript definitions
examples/     Example applications
```

## PM2 Runtime Files

Located at `$HOME/.pm2/`:
- `pm2.log`, `pm2.pid` — daemon log and PID
- `rpc.sock`, `pub.sock` — IPC sockets
- `dump.pm2` — process list dump for resurrection
- `logs/`, `pids/` — app logs and PIDs
- `modules/` — installed PM2 modules

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

## Commit Message Convention

Prefix commits with: `fix:`, `hotfix:`, `feat:`, `docs:`, `BREAKING:`, `refactor:`, `perf:`, `style:`, `test:`, `chore:`

Keep description under 50 chars, lowercase except proper nouns/acronyms.

## CI

GitHub Actions on push/PR — tests on Node 16.x and 24.x, plus separate Bun tests. Requires Python 3 and PHP CLI for some e2e tests. 30-minute timeout.

## Key Dependencies

- `commander` (CLI), `async`, `pm2-axon`/`pm2-axon-rpc` (IPC), `chokidar` (file watching), `croner` (cron), `pidusage` (process monitoring), `vizion` (VCS), `js-yaml`, `@pm2/io`, `@pm2/agent`
