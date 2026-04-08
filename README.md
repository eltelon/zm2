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

## Installing ZM2

```bash
$ npm install -g github:eltelon/pm2#zm2
```

## Quick Start

### Start an application

```bash
$ sudo zm2 start app.js
```

This generates a systemd unit `zm2-app.service`, writes an environment file to `/etc/zm2/env/`, and starts the service.

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
```

### Logs (via journald)

All output goes through journald. No custom log files.

```bash
$ zm2 logs                  # Stream all zm2 logs
$ zm2 logs app-name         # Stream logs for one app
$ zm2 logs --json           # JSON output
$ zm2 logs --format         # key=value output
```

### Monitoring

```bash
$ zm2 monit                 # Terminal-based CPU/memory monitor
```

### Multiple Instances

```bash
$ sudo zm2 start api.js -i 4
```

Creates a systemd template unit `zm2-api@.service` with instances `@0` through `@3`. Each instance gets `NODE_APP_INSTANCE` set to its index.

### Ecosystem Config

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

### Boot Persistence

```bash
# Enable all zm2 services to start on boot
$ sudo zm2 startup

# Disable
$ sudo zm2 unstartup
```

### Configuration Mapping

ZM2 maps familiar PM2 options to native systemd directives:

| ZM2 / ecosystem option | systemd directive |
|---|---|
| `max_memory_restart` | `MemoryMax` |
| `autorestart: true` | `Restart=on-failure` |
| `restart_delay` | `RestartSec` |
| `max_restarts` | `StartLimitBurst` |
| `kill_timeout` | `TimeoutStopSec` |
| `kill_signal` | `KillSignal` |
| `cron_restart` | systemd timer unit |
| `instances: N` | template unit with N instances |

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
2. PM2 dump file (`~/.pm2/dump.pm2`)

After migration:
```bash
$ zm2 list                  # Verify services are running
$ sudo zm2 startup          # Enable boot persistence
$ pm2 kill                  # Stop old PM2 daemon
$ pm2 unstartup             # Remove old PM2 startup hook
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ZM2_HOME` | Custom home directory (default: `~/.zm2`) |
| `ZM2_DEBUG` | Enable debug mode |
| `ZM2_KILL_TIMEOUT` | Process kill timeout (default: 1600ms) |
| `ZM2_KILL_SIGNAL` | Kill signal (default: SIGINT) |
| `ZM2_GRACEFUL_TIMEOUT` | Graceful shutdown timeout |

All `ZM2_*` variables fall back to `PM2_*` equivalents for compatibility.

## What Changed from PM2

ZM2 removes the custom daemon architecture in favor of systemd:

- **No daemon** — CLI talks directly to systemd via `systemctl`
- **No fork/cluster mode** — apps run as `Type=simple` systemd services
- **No custom log files** — journald handles all logging
- **No file watching** — use external tools or CI/CD for deploys
- **No pm2-plus** — cloud monitoring integration removed

## License

ZM2 is made available under the terms of the GNU Affero General Public License 3.0 (AGPL 3.0).

Based on [PM2](https://github.com/Unitech/pm2) by Alexandre Strzelewicz and contributors.
