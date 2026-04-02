# ZM2 API as Systemd Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `zm2 api` from a foreground blocking command to a systemd-managed background service with subcommands for lifecycle control.

**Architecture:** New standalone entry point `lib/API/HttpApiServer.js` for systemd's ExecStart. The existing `API.prototype.api()` becomes a service installer/controller that generates a unit file, installs it via `Systemd.installUnit()`, and manages it via start/stop/restart/remove subcommands. `HttpApi.createServer()` is reused unchanged.

**Tech Stack:** Node.js native modules, systemd via `Systemd.js`, Mocha + Should.js for tests.

**Spec:** `docs/superpowers/specs/2026-04-02-api-systemd-service-design.md`

---

### File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `lib/API/HttpApiServer.js` | Create | Standalone entry point for systemd ExecStart |
| `lib/API/HttpApi.js` | Modify | Add `generateUnitFile()` function |
| `lib/API.js` | Modify (lines 1817-1863) | Replace foreground `api()` with service installer/controller |
| `lib/binaries/CLI.js` | Modify (lines 908-917) | Update `zm2 api` command with subcommands and `--host` |
| `test/programmatic/http_api.mocha.js` | Modify | Add tests for `generateUnitFile` |

---

### Task 1: Add `generateUnitFile` to HttpApi.js

**Files:**
- Modify: `test/programmatic/http_api.mocha.js`
- Modify: `lib/API/HttpApi.js`

- [ ] **Step 1: Write failing tests for `generateUnitFile`**

Append inside `describe('HttpApi')` in `test/programmatic/http_api.mocha.js`:

```javascript
  describe('generateUnitFile', function() {
    it('should generate a valid systemd unit file', function() {
      var unit = HttpApi.generateUnitFile({
        nodePath: '/usr/bin/node',
        scriptPath: '/opt/zm2/lib/API/HttpApiServer.js',
        zm2Home: '/home/user/.zm2',
        port: 9615,
        host: '127.0.0.1'
      });

      unit.should.containEql('[Unit]');
      unit.should.containEql('Description=ZM2 API Server');
      unit.should.containEql('After=network.target');
      unit.should.containEql('[Service]');
      unit.should.containEql('Type=simple');
      unit.should.containEql('ExecStart=/usr/bin/node /opt/zm2/lib/API/HttpApiServer.js');
      unit.should.containEql('Environment=ZM2_HOME=/home/user/.zm2');
      unit.should.containEql('Environment=ZM2_API_PORT=9615');
      unit.should.containEql('Environment=ZM2_API_HOST=127.0.0.1');
      unit.should.containEql('Restart=on-failure');
      unit.should.containEql('RestartSec=5');
      unit.should.containEql('TimeoutStopSec=10');
      unit.should.containEql('[Install]');
      unit.should.containEql('WantedBy=multi-user.target');
    });

    it('should use custom port and host', function() {
      var unit = HttpApi.generateUnitFile({
        nodePath: '/usr/bin/node',
        scriptPath: '/opt/zm2/lib/API/HttpApiServer.js',
        zm2Home: '/root/.zm2',
        port: 8080,
        host: '0.0.0.0'
      });

      unit.should.containEql('Environment=ZM2_API_PORT=8080');
      unit.should.containEql('Environment=ZM2_API_HOST=0.0.0.0');
      unit.should.containEql('Environment=ZM2_HOME=/root/.zm2');
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `source ~/.nvm/nvm.sh && nvm use lts/iron && npx mocha test/programmatic/http_api.mocha.js --timeout 10000 --exit`
Expected: FAIL — `HttpApi.generateUnitFile is not a function`

- [ ] **Step 3: Implement `generateUnitFile`**

Add to `lib/API/HttpApi.js` before `module.exports`:

```javascript
function generateUnitFile(opts) {
  var lines = [
    '[Unit]',
    'Description=ZM2 API Server',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart=' + opts.nodePath + ' ' + opts.scriptPath,
    'Environment=ZM2_HOME=' + opts.zm2Home,
    'Environment=ZM2_API_PORT=' + opts.port,
    'Environment=ZM2_API_HOST=' + opts.host,
    'Restart=on-failure',
    'RestartSec=5',
    'TimeoutStopSec=10',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    ''
  ];
  return lines.join('\n');
}
```

Update `module.exports`:

```javascript
module.exports = {
  formatPrometheusMetrics: formatPrometheusMetrics,
  formatProcessList: formatProcessList,
  parseRoute: parseRoute,
  loadOrCreateApiKey: loadOrCreateApiKey,
  checkAuth: checkAuth,
  createServer: createServer,
  generateUnitFile: generateUnitFile
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `source ~/.nvm/nvm.sh && nvm use lts/iron && npx mocha test/programmatic/http_api.mocha.js --timeout 10000 --exit`
Expected: All passing

- [ ] **Step 5: Commit**

```bash
git add lib/API/HttpApi.js test/programmatic/http_api.mocha.js
git commit -m "feat: add generateUnitFile for zm2-api systemd service"
```

---

### Task 2: Create standalone HttpApiServer.js entry point

**Files:**
- Create: `lib/API/HttpApiServer.js`

- [ ] **Step 1: Create the standalone server entry point**

Create `lib/API/HttpApiServer.js`:

```javascript
#!/usr/bin/env node

/**
 * ZM2 API Server — Standalone entry point for systemd.
 *
 * Reads configuration from environment variables:
 *   ZM2_HOME     — Path to ZM2 home directory (default: ~/.zm2)
 *   ZM2_API_PORT — Port to listen on (default: 9615)
 *   ZM2_API_HOST — Host to bind to (default: 127.0.0.1)
 */

'use strict';

var path = require('path');
var HttpApi = require('./HttpApi');

// Read config from environment
var zm2Home = process.env.ZM2_HOME || path.resolve(process.env.HOME || '/root', '.zm2');
var port = parseInt(process.env.ZM2_API_PORT, 10) || 9615;
var host = process.env.ZM2_API_HOST || '127.0.0.1';
var keyPath = path.join(zm2Home, 'api-key');

// Override ZM2_HOME so API constructor picks it up
process.env.ZM2_HOME = zm2Home;

var API = require('../API');
var api = new API({ daemon_mode: false });

api.Client.start(function(err) {
  if (err) {
    console.error('[ZM2 API] Failed to connect to systemd:', err.message);
    process.exit(1);
  }

  var apiKey = HttpApi.loadOrCreateApiKey(keyPath);
  var server = HttpApi.createServer(api, apiKey);

  server.listen(port, host, function() {
    console.log('[ZM2 API] Listening on ' + host + ':' + port);
    console.log('[ZM2 API] Prometheus metrics at /metrics');
  });

  server.on('error', function(err) {
    console.error('[ZM2 API] Server error:', err.message);
    process.exit(1);
  });

  process.on('SIGTERM', function() {
    console.log('[ZM2 API] Shutting down...');
    server.close(function() {
      api.Client.close(function() {
        process.exit(0);
      });
    });
  });
});
```

- [ ] **Step 2: Verify the file can at least be required without errors**

Run: `source ~/.nvm/nvm.sh && nvm use lts/iron && node -e "try { require.resolve('./lib/API/HttpApiServer'); console.log('OK: module resolves'); } catch(e) { console.error(e.message); }"`
Expected: `OK: module resolves`

- [ ] **Step 3: Commit**

```bash
git add lib/API/HttpApiServer.js
git commit -m "feat: add standalone HttpApiServer entry point for systemd"
```

---

### Task 3: Replace API.prototype.api() with service installer/controller

**Files:**
- Modify: `lib/API.js` (lines 1817-1863)

- [ ] **Step 1: Replace the `api()` method**

Read `lib/API.js` and replace the entire `API.prototype.api` function (lines 1817-1863) with:

```javascript
API.prototype.api = function(opts, cb) {
  var that = this;
  var HttpApi = require('./API/HttpApi');
  var Systemd = require('./Systemd');
  var conf = require('../constants');

  var subcommand = opts.subcommand || 'start';
  var port = opts.port || conf.WEB_PORT || 9615;
  var host = opts.host || process.env.ZM2_API_HOST || '127.0.0.1';
  var keyPath = path.join(that.pm2_home, 'api-key');

  switch (subcommand) {
    case 'start':
      // Check if already running
      if (Systemd.unitExists('zm2-api')) {
        try {
          var status = Systemd.getStatus('zm2-api');
          if (status.ActiveState === 'active') {
            Common.printOut(conf.PREFIX_MSG + 'ZM2 API already running on pid ' + status.MainPID);
            var apiKey = HttpApi.loadOrCreateApiKey(keyPath);
            Common.printOut(conf.PREFIX_MSG + 'API Key: ' + apiKey);
            return cb ? cb(null) : that.exitCli(conf.SUCCESS_EXIT);
          }
        } catch (e) { /* unit exists but can't get status, reinstall */ }
      }

      // Generate and install unit
      var scriptPath = path.resolve(__dirname, 'API', 'HttpApiServer.js');
      var unitContent = HttpApi.generateUnitFile({
        nodePath: process.execPath,
        scriptPath: scriptPath,
        zm2Home: that.pm2_home,
        port: port,
        host: host
      });

      try {
        Systemd.installUnit('zm2-api', unitContent);
        Systemd.start('zm2-api');
      } catch (e) {
        Common.printError(conf.PREFIX_MSG_ERR + 'Failed to install/start ZM2 API service: ' + e.message);
        return cb ? cb(e) : that.exitCli(conf.ERROR_EXIT);
      }

      var apiKey = HttpApi.loadOrCreateApiKey(keyPath);
      Common.printOut(conf.PREFIX_MSG + 'ZM2 API started as systemd service');
      Common.printOut(conf.PREFIX_MSG + 'Listening on ' + host + ':' + port);
      Common.printOut(conf.PREFIX_MSG + 'API Key: ' + apiKey);
      Common.printOut(conf.PREFIX_MSG + 'Usage: curl -H "Authorization: Bearer ' + apiKey + '" http://' + host + ':' + port + '/api/processes');
      Common.printOut(conf.PREFIX_MSG + 'Prometheus: http://' + host + ':' + port + '/metrics');
      Common.printOut(conf.PREFIX_MSG + 'Logs: journalctl -u zm2-api -f');
      return cb ? cb(null) : that.exitCli(conf.SUCCESS_EXIT);

    case 'stop':
      if (!Systemd.unitExists('zm2-api')) {
        Common.printOut(conf.PREFIX_MSG + 'ZM2 API is not installed');
        return cb ? cb(null) : that.exitCli(conf.SUCCESS_EXIT);
      }
      try {
        Systemd.stop('zm2-api');
        Common.printOut(conf.PREFIX_MSG + 'ZM2 API stopped');
      } catch (e) {
        Common.printError(conf.PREFIX_MSG_ERR + 'Failed to stop: ' + e.message);
        return cb ? cb(e) : that.exitCli(conf.ERROR_EXIT);
      }
      return cb ? cb(null) : that.exitCli(conf.SUCCESS_EXIT);

    case 'restart':
      if (!Systemd.unitExists('zm2-api')) {
        Common.printOut(conf.PREFIX_MSG + 'ZM2 API is not installed. Run "zm2 api" first.');
        return cb ? cb(null) : that.exitCli(conf.SUCCESS_EXIT);
      }
      try {
        Systemd.restart('zm2-api');
        Common.printOut(conf.PREFIX_MSG + 'ZM2 API restarted');
      } catch (e) {
        Common.printError(conf.PREFIX_MSG_ERR + 'Failed to restart: ' + e.message);
        return cb ? cb(e) : that.exitCli(conf.ERROR_EXIT);
      }
      return cb ? cb(null) : that.exitCli(conf.SUCCESS_EXIT);

    case 'remove':
      if (!Systemd.unitExists('zm2-api')) {
        Common.printOut(conf.PREFIX_MSG + 'ZM2 API is not installed');
        return cb ? cb(null) : that.exitCli(conf.SUCCESS_EXIT);
      }
      try {
        Systemd.removeUnit('zm2-api');
        Common.printOut(conf.PREFIX_MSG + 'ZM2 API service removed');
      } catch (e) {
        Common.printError(conf.PREFIX_MSG_ERR + 'Failed to remove: ' + e.message);
        return cb ? cb(e) : that.exitCli(conf.ERROR_EXIT);
      }
      return cb ? cb(null) : that.exitCli(conf.SUCCESS_EXIT);

    case 'status':
      if (!Systemd.unitExists('zm2-api')) {
        Common.printOut(conf.PREFIX_MSG + 'ZM2 API is not installed');
        return cb ? cb(null) : that.exitCli(conf.SUCCESS_EXIT);
      }
      try {
        var status = Systemd.getStatus('zm2-api');
        Common.printOut(conf.PREFIX_MSG + 'ZM2 API Status:');
        Common.printOut(conf.PREFIX_MSG + '  State:  ' + status.ActiveState + ' (' + status.SubState + ')');
        Common.printOut(conf.PREFIX_MSG + '  PID:    ' + (status.MainPID || 'N/A'));
        if (status.ActiveState === 'active') {
          var apiKey = HttpApi.loadOrCreateApiKey(keyPath);
          Common.printOut(conf.PREFIX_MSG + '  API Key: ' + apiKey);
        }
      } catch (e) {
        Common.printError(conf.PREFIX_MSG_ERR + 'Failed to get status: ' + e.message);
        return cb ? cb(e) : that.exitCli(conf.ERROR_EXIT);
      }
      return cb ? cb(null) : that.exitCli(conf.SUCCESS_EXIT);

    default:
      Common.printError(conf.PREFIX_MSG_ERR + 'Unknown api subcommand: ' + subcommand);
      Common.printError(conf.PREFIX_MSG_ERR + 'Usage: zm2 api [start|stop|restart|status|remove]');
      return cb ? cb(new Error('Unknown subcommand')) : that.exitCli(conf.ERROR_EXIT);
  }
};
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `source ~/.nvm/nvm.sh && nvm use lts/iron && npx mocha test/programmatic/http_api.mocha.js --timeout 10000 --exit`
Expected: All passing (the `api()` method is not tested directly in unit tests)

- [ ] **Step 3: Commit**

```bash
git add lib/API.js
git commit -m "feat: convert zm2 api to systemd service installer/controller"
```

---

### Task 4: Update CLI command with subcommands and --host

**Files:**
- Modify: `lib/binaries/CLI.js` (lines 908-917)

- [ ] **Step 1: Replace the `zm2 api` command**

Read `lib/binaries/CLI.js` and replace the `api` command block (lines 908-917) with:

```javascript
//
// HTTP API server as systemd service
//
commander.command('api [subcommand]')
  .option('--port [port]', 'specify port to listen to', parseInt)
  .option('--host [host]', 'specify host/IP to bind to')
  .description('manage ZM2 HTTP API service (subcommands: start, stop, restart, status, remove)')
  .action(function(subcommand, opts) {
    var validCmds = ['start', 'stop', 'restart', 'status', 'remove'];
    if (subcommand && validCmds.indexOf(subcommand) === -1) {
      Common.printError(cst.PREFIX_MSG_ERR + 'Unknown subcommand: ' + subcommand);
      Common.printError(cst.PREFIX_MSG_ERR + 'Usage: zm2 api [start|stop|restart|status|remove]');
      process.exit(cst.ERROR_EXIT);
    }

    pm2.api({
      subcommand: subcommand || 'start',
      port: opts.port || parseInt(process.env.ZM2_API_PORT, 10) || undefined,
      host: opts.host || process.env.ZM2_API_HOST || undefined
    });
  });
```

- [ ] **Step 2: Verify the CLI command accepts subcommands**

Run: `source ~/.nvm/nvm.sh && nvm use lts/iron && node bin/zm2 api --help`
Expected: Shows `api [subcommand]` with `--port` and `--host` options.

- [ ] **Step 3: Verify existing tests still pass**

Run: `source ~/.nvm/nvm.sh && nvm use lts/iron && npx mocha test/programmatic/http_api.mocha.js --timeout 10000 --exit`
Expected: All passing

- [ ] **Step 4: Commit**

```bash
git add lib/binaries/CLI.js
git commit -m "feat: update zm2 api CLI with subcommands and --host flag"
```

---

### Task 5: Update CLAUDE.md and design spec

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-04-01-http-api-prometheus-design.md`

- [ ] **Step 1: Update CLAUDE.md HTTP API section**

Replace the existing "HTTP API & Prometheus" section in CLAUDE.md with:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for zm2 api systemd service"
```
