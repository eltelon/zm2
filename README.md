<div align="center">
 <br/>

<h1>ZM2</h1>

<b>Z</b>(apping) <b>M</b>(anager) <b>2</b><br/>
  <i>Systemd Edition</i>
<br/><br/>

A systemd-based process manager for Node.js applications on Linux.<br/>
Forked from <a href="https://github.com/Unitech/pm2">PM2</a>.

<br/>
<br/>
</div>

ZM2 manages your Node.js applications as **systemd services**. No custom daemon, no fork/cluster mode — each app becomes a native systemd unit with all the guarantees that come with it: cgroups, journald, automatic restart, boot persistence.

The CLI stays familiar if you come from PM2:

```bash
$ zm2 start app.js
```

**Linux only.** Requires systemd and root privileges. Node.js >= 16.

## How It Works

There is no background daemon. Every `zm2` invocation talks directly to `systemd` via `systemctl`/`journalctl`:

```
zm2 CLI  ──►  systemctl / journalctl  ──►  systemd units (zm2-<name>.service)
                              │
                              └──►  ~/.zm2/state.json   (ZM2 metadata: pm_id, script, instances)
```

| Artifact | Location |
|---|---|
| Service unit | `/etc/systemd/system/zm2-<name>.service` |
| Template unit (multi-instance) | `/etc/systemd/system/zm2-<name>@.service` |
| Cron-restart timer | `/etc/systemd/system/zm2-<name>-cron.timer` |
| Environment file | `/etc/zm2/env/zm2-<name>.env` |
| ZM2 state (metadata) | `~/.zm2/state.json` |
| HTTP API key | `~/.zm2/api-key` |
| HTTP API service | `zm2-api.service` |

## Installing ZM2

```bash
$ npm install -g github:eltelon/zm2#zm2
```

The package is published as `@zappinginc/zm2`.

## Quick Start

### Start an application

```bash
$ sudo zm2 start app.js
```

This generates a systemd unit `zm2-app.service`, writes an environment file to `/etc/zm2/env/`, enables the unit (boot persistence), and starts the service.

You can start any interpreter (Node.js, Python, Ruby, binaries):

```bash
$ sudo zm2 start app.js
$ sudo zm2 start script.py --interpreter python3
$ sudo zm2 start ./mybin --interpreter none
```

### Managing Applications

```bash
$ zm2 list                                  # List all services
$ zm2 stop     <app_name|id|'all'>          # Stop
$ zm2 restart  <app_name|id|'all'>          # Restart
$ zm2 reload   <app_name|id|'all'>          # Reload (systemctl reload-or-restart)
$ zm2 delete   <app_name|id|'all'>          # Stop + remove unit file
$ zm2 describe <app_name|id>                # Show details
$ zm2 env      <id>                         # Show environment of a process
$ zm2 pid      [app_name]                   # Show PID
$ zm2 reset    <name|id|all>                # Reset restart counter
$ zm2 ping                                  # Check ZM2/systemd connectivity
```

`list` has aliases: `l`, `ps`, `status`. JSON variants: `jlist` and `prettylist`.

### Logs (via journald)

All application output goes through journald. No custom log files.

```bash
$ zm2 logs                  # Stream all zm2 logs
$ zm2 logs app-name         # Stream logs for one app
$ zm2 logs --json           # JSON output
$ zm2 logs --format         # key=value output
$ zm2 logs --lines 200      # Last N lines
$ zm2 logs --nostream       # Print last lines without streaming
$ zm2 logs --err | --out    # Only error / only stdout
```

Raw journald access:

```bash
$ journalctl -u zm2-app -f
```

### Monitoring

```bash
$ zm2 monit                 # Terminal-based CPU/memory monitor
$ zm2 dashboard             # Dashboard with monitoring and logs
```

## HTTP API & Prometheus

ZM2 can run a small HTTP API as a systemd service (`zm2-api.service`) with a Prometheus metrics endpoint. It is installed on demand.

```bash
$ sudo zm2 api                     # Install and start the API service
$ zm2 api stop                     # Stop the service
$ zm2 api restart                  # Restart the service
$ zm2 api status                   # Show running state and API key
$ sudo zm2 api remove              # Stop and remove the service
```

Defaults: port `9615`, bound to `127.0.0.1` (override with `--port`/`--host` or `ZM2_API_PORT`/`ZM2_API_HOST`).

The API key is auto-generated on first run and stored at `~/.zm2/api-key` (permissions `0600`). It is printed on `zm2 api` and `zm2 api status`.

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/metrics` | No | Prometheus metrics (see below) |
| `GET` | `/api/processes` | Bearer | List processes with status, cpu, memory, uptime, restarts |
| `POST` | `/api/processes` | Bearer | Create a process. Body: `{script, name?, cwd?, interpreter?, env?}` (max 64 KB) |
| `POST` | `/api/processes/:name/start` | Bearer | Start a process |
| `POST` | `/api/processes/:name/stop` | Bearer | Stop a process |
| `POST` | `/api/processes/:name/restart` | Bearer | Restart a process |

All `/api/*` routes require `Authorization: Bearer <api-key>`.

```bash
# List processes
$ curl -H "Authorization: Bearer $KEY" http://127.0.0.1:9615/api/processes

# Create a process
$ curl -X POST -H "Authorization: Bearer $KEY" \
     -H "Content-Type: application/json" \
     -d '{"script":"/srv/api/server.js","name":"api","env":{"PORT":"3000"}}' \
     http://127.0.0.1:9615/api/processes

# Restart a process
$ curl -X POST -H "Authorization: Bearer $KEY" \
     http://127.0.0.1:9615/api/processes/api/restart

# Prometheus metrics (no auth)
$ curl http://127.0.0.1:9615/metrics
```

### Prometheus Metrics

`GET /metrics` exposes (OpenMetrics text format):

| Metric | Type | Description |
|---|---|---|
| `zm2_process_cpu_percent` | gauge | CPU usage percentage |
| `zm2_process_memory_bytes` | gauge | Memory usage in bytes |
| `zm2_process_uptime_seconds` | gauge | Process uptime in seconds |
| `zm2_process_restart_count` | gauge | Total number of restarts |
| `zm2_process_status` | gauge | 1 = current status (labels: `online`/`stopped`/`errored`) |

All metrics are labeled with `name="<app>"`.

API logs: `journalctl -u zm2-api -f`.

## Multiple Instances

```bash
$ sudo zm2 start api.js -i 4
```

Creates a systemd template unit `zm2-api@.service` with instances `@0` through `@3`. Each instance gets `NODE_APP_INSTANCE` set to its index.

## Ecosystem Config

```bash
$ zm2 ecosystem             # Generate ecosystem.config.js template
$ sudo zm2 start ecosystem.config.js
```

```javascript
module.exports = {
  apps: [{
    name: 'api',
    script: 'server.js',
    instances: 2,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
}
```

## Boot Persistence

Units are enabled automatically when started with `zm2 start` (they survive reboot immediately). To manage it explicitly:

```bash
# Enable all zm2 services to start on boot
$ sudo zm2 startup

# Disable
$ sudo zm2 unstartup
```

Start an app without enabling it on boot:

```bash
$ sudo zm2 start app.js --no-autostart
```

## Configuration Mapping

ZM2 maps familiar PM2 options to native systemd directives:

| ZM2 / ecosystem option | systemd directive |
|---|---|
| `max_memory_restart` | `MemoryMax` |
| `autorestart: true` | `Restart=on-failure` |
| `autorestart: false` | `Restart=no` |
| `restart_delay` | `RestartSec` |
| `max_restarts` | `StartLimitBurst` |
| `min_uptime` | `StartLimitIntervalSec` |
| `kill_timeout` | `TimeoutStopSec` |
| `listen_timeout` | `TimeoutStartSec` |
| `kill_signal` | `KillSignal` |
| `stop_exit_codes` | `SuccessExitStatus` |
| `user` / `uid` | `User` |
| `gid` | `Group` |
| `cwd` | `WorkingDirectory` |
| `cron_restart` | systemd timer unit |
| `instances: N` | template unit with N instances |

Other useful start options: `--node-args`, `--interpreter`, `--uid`, `--gid`, `--env <name>` (ecosystem env section), `--update-env`, `--cron <pattern>`, `--wait-ready`.

## Migrating from PM2

ZM2 can migrate your running PM2 processes to systemd services:

```bash
# Preview what would be migrated
$ sudo zm2 migrate --dry-run

# Migrate all PM2 apps
$ sudo zm2 migrate all

# Migrate a specific app
$ sudo zm2 migrate api-server
```

The migrate command reads from:
1. A running PM2 daemon (`pm2 jlist`)
2. PM2 dump file (`~/.pm2/dump.pm2`, or `.bak`)

After migration:
```bash
$ zm2 list                  # Verify services are running
$ sudo zm2 startup          # Enable boot persistence
$ pm2 kill                  # Stop old PM2 daemon
$ pm2 unstartup             # Remove old PM2 startup hook
```

## Other Commands

```bash
$ zm2 serve [path] [port]             # Static file server
$ zm2 deploy <file>                   # Deploy via pm2-deploy (ecosystem.config.js)
$ zm2 install <module>                # Install a module (NPM/tarball/git)
$ zm2 uninstall <module>              # Remove a module
$ zm2 module:update <module>          # Update a module
$ zm2 dump                            # Save process list to ~/.zm2/dump.zm2
$ zm2 resurrect                       # Restore processes from dump
$ zm2 cleardump                       # Clear dump file
$ zm2 logrotate                       # Install logrotate config (legacy, journald-based)
$ zm2 flush                           # Legacy log flush (no-op with journald)
$ zm2 report                          # Generate a diagnostic report
$ zm2 examples                        # Show usage examples
```

`pull`, `forward` and `backward` (git-based deploy) are **not supported** — they return an error stub; use `git` directly.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ZM2_HOME` | Custom home directory (default: `~/.zm2`) |
| `ZM2_DEBUG` | Enable debug mode |
| `ZM2_KILL_TIMEOUT` | Process kill timeout (default: 1600ms) |
| `ZM2_KILL_SIGNAL` | Kill signal (default: SIGINT) |
| `ZM2_GRACEFUL_TIMEOUT` | Graceful shutdown timeout |
| `ZM2_API_PORT` | HTTP API port (default: 9615) |
| `ZM2_API_HOST` | HTTP API bind address (default: 127.0.0.1) |

All `ZM2_*` variables fall back to `PM2_*` equivalents for compatibility.

## What Changed from PM2

ZM2 removes the custom daemon architecture in favor of systemd:

- **No daemon** — CLI talks directly to systemd via `systemctl`
- **No fork/cluster mode** — apps run as `Type=simple` systemd services (`instances: N` maps to template units, not cluster workers)
- **No custom log files** — journald handles all logging
- **No file watching** — use external tools or CI/CD for deploys
- **No pm2-plus** — cloud monitoring integration removed
- **No pm2-axon/RPC** — socket-based communication removed
- **No Docker mode** — container support removed
- **No vizion** — `pull`/`forward`/`backward` return error stubs

## License

ZM2 is made available under the terms of the GNU Affero General Public License 3.0 (AGPL 3.0).

Based on [PM2](https://github.com/Unitech/pm2) by Alexandre Strzelewicz and contributors.