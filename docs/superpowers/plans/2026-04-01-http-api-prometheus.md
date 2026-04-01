# HTTP API + Prometheus Exporter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an HTTP server to ZM2 with Prometheus metrics endpoint and REST API for process management, accessible via `zm2 api` CLI command.

**Architecture:** Single `lib/API/HttpApi.js` module using Node's native `http` module. Integrates with existing `API.js` for process operations and `SystemdClient.executeRemote('getMonitorData')` for metrics. API key auth stored at `~/.zm2/api-key` protects `/api/*` routes; `/metrics` is open.

**Tech Stack:** Node.js native `http`, `crypto`, `url` modules. Mocha + Should.js for tests.

**Spec:** `docs/superpowers/specs/2026-04-01-http-api-prometheus-design.md`

---

### File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `lib/API/HttpApi.js` | Create | HTTP server, routing, auth, Prometheus formatter, API handlers |
| `lib/API.js` | Modify (~line 120, plus new method) | Add `api()` method |
| `lib/binaries/CLI.js` | Modify (~line 895) | Add `zm2 api` command |
| `test/programmatic/http_api.mocha.js` | Create | Unit tests |

---

### Task 1: Prometheus metrics formatter

**Files:**
- Create: `test/programmatic/http_api.mocha.js`
- Create: `lib/API/HttpApi.js`

- [ ] **Step 1: Write failing test for `formatPrometheusMetrics`**

```javascript
var should = require('should');
var HttpApi = require('../../lib/API/HttpApi');

describe('HttpApi', function() {
  describe('formatPrometheusMetrics', function() {
    it('should format process data as Prometheus text', function() {
      var processes = [
        {
          pid: 1234,
          name: 'myapp',
          pm_id: 0,
          pm2_env: {
            name: 'myapp',
            status: 'online',
            pm_uptime: Date.now() - 3600000,
            restart_time: 2
          },
          monit: { memory: 52428800, cpu: 12.5 }
        }
      ];

      var output = HttpApi.formatPrometheusMetrics(processes);

      output.should.containEql('# HELP zm2_process_cpu_percent CPU usage percentage');
      output.should.containEql('# TYPE zm2_process_cpu_percent gauge');
      output.should.containEql('zm2_process_cpu_percent{name="myapp"} 12.5');
      output.should.containEql('zm2_process_memory_bytes{name="myapp"} 52428800');
      output.should.containEql('zm2_process_restart_count{name="myapp"} 2');
      output.should.containEql('zm2_process_status{name="myapp",status="online"} 1');
      output.should.containEql('zm2_process_status{name="myapp",status="stopped"} 0');
      output.should.containEql('zm2_process_status{name="myapp",status="errored"} 0');
    });

    it('should handle multiple processes', function() {
      var processes = [
        {
          pid: 1234, name: 'app1', pm_id: 0,
          pm2_env: { name: 'app1', status: 'online', pm_uptime: Date.now() - 1000, restart_time: 0 },
          monit: { memory: 100, cpu: 1.0 }
        },
        {
          pid: 5678, name: 'app2', pm_id: 1,
          pm2_env: { name: 'app2', status: 'stopped', pm_uptime: 0, restart_time: 5 },
          monit: { memory: 0, cpu: 0 }
        }
      ];

      var output = HttpApi.formatPrometheusMetrics(processes);
      output.should.containEql('zm2_process_cpu_percent{name="app1"} 1');
      output.should.containEql('zm2_process_cpu_percent{name="app2"} 0');
      output.should.containEql('zm2_process_status{name="app2",status="stopped"} 1');
      output.should.containEql('zm2_process_status{name="app2",status="online"} 0');
    });

    it('should return empty string for no processes', function() {
      var output = HttpApi.formatPrometheusMetrics([]);
      output.should.equal('');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/programmatic/http_api.mocha.js --timeout 10000 --exit`
Expected: FAIL — `Cannot find module '../../lib/API/HttpApi'`

- [ ] **Step 3: Implement `formatPrometheusMetrics`**

Create `lib/API/HttpApi.js`:

```javascript
'use strict';

var http = require('http');
var crypto = require('crypto');
var url = require('url');
var fs = require('fs');
var path = require('path');

var STATUSES = ['online', 'stopped', 'errored'];

function formatPrometheusMetrics(processes) {
  if (!processes || processes.length === 0) return '';

  var lines = [];

  // CPU
  lines.push('# HELP zm2_process_cpu_percent CPU usage percentage');
  lines.push('# TYPE zm2_process_cpu_percent gauge');
  processes.forEach(function(proc) {
    lines.push('zm2_process_cpu_percent{name="' + proc.pm2_env.name + '"} ' + (proc.monit.cpu || 0));
  });
  lines.push('');

  // Memory
  lines.push('# HELP zm2_process_memory_bytes Memory usage in bytes');
  lines.push('# TYPE zm2_process_memory_bytes gauge');
  processes.forEach(function(proc) {
    lines.push('zm2_process_memory_bytes{name="' + proc.pm2_env.name + '"} ' + (proc.monit.memory || 0));
  });
  lines.push('');

  // Uptime
  lines.push('# HELP zm2_process_uptime_seconds Process uptime in seconds');
  lines.push('# TYPE zm2_process_uptime_seconds gauge');
  processes.forEach(function(proc) {
    var uptime = proc.pm2_env.pm_uptime ? Math.floor((Date.now() - proc.pm2_env.pm_uptime) / 1000) : 0;
    lines.push('zm2_process_uptime_seconds{name="' + proc.pm2_env.name + '"} ' + uptime);
  });
  lines.push('');

  // Restart count
  lines.push('# HELP zm2_process_restart_count Total number of restarts');
  lines.push('# TYPE zm2_process_restart_count gauge');
  processes.forEach(function(proc) {
    lines.push('zm2_process_restart_count{name="' + proc.pm2_env.name + '"} ' + (proc.pm2_env.restart_time || 0));
  });
  lines.push('');

  // Status
  lines.push('# HELP zm2_process_status Process status (1 = current, 0 = not current)');
  lines.push('# TYPE zm2_process_status gauge');
  processes.forEach(function(proc) {
    STATUSES.forEach(function(s) {
      var val = proc.pm2_env.status === s ? 1 : 0;
      lines.push('zm2_process_status{name="' + proc.pm2_env.name + '",status="' + s + '"} ' + val);
    });
  });
  lines.push('');

  return lines.join('\n');
}

module.exports = {
  formatPrometheusMetrics: formatPrometheusMetrics
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx mocha test/programmatic/http_api.mocha.js --timeout 10000 --exit`
Expected: 3 passing

- [ ] **Step 5: Commit**

```bash
git add lib/API/HttpApi.js test/programmatic/http_api.mocha.js
git commit -m "feat: add Prometheus metrics formatter for HttpApi"
```

---

### Task 2: JSON response formatters and URL routing

**Files:**
- Modify: `test/programmatic/http_api.mocha.js`
- Modify: `lib/API/HttpApi.js`

- [ ] **Step 1: Write failing tests for `formatProcessList` and `parseRoute`**

Append to `test/programmatic/http_api.mocha.js` inside the `describe('HttpApi')` block:

```javascript
  describe('formatProcessList', function() {
    it('should format processes as JSON-ready object', function() {
      var processes = [
        {
          pid: 1234, name: 'myapp', pm_id: 0,
          pm2_env: { name: 'myapp', status: 'online', pm_uptime: Date.now() - 3600000, restart_time: 2 },
          monit: { memory: 52428800, cpu: 12.5 }
        }
      ];

      var result = HttpApi.formatProcessList(processes);
      result.processes.should.be.an.Array();
      result.processes.length.should.equal(1);
      var p = result.processes[0];
      p.name.should.equal('myapp');
      p.pm_id.should.equal(0);
      p.pid.should.equal(1234);
      p.status.should.equal('online');
      p.cpu.should.equal(12.5);
      p.memory.should.equal(52428800);
      p.restarts.should.equal(2);
      p.should.have.property('uptime');
    });
  });

  describe('parseRoute', function() {
    it('should parse GET /metrics', function() {
      var route = HttpApi.parseRoute('GET', '/metrics');
      route.handler.should.equal('metrics');
    });

    it('should parse GET /api/processes', function() {
      var route = HttpApi.parseRoute('GET', '/api/processes');
      route.handler.should.equal('listProcesses');
    });

    it('should parse POST /api/processes', function() {
      var route = HttpApi.parseRoute('POST', '/api/processes');
      route.handler.should.equal('createProcess');
    });

    it('should parse POST /api/processes/:name/start', function() {
      var route = HttpApi.parseRoute('POST', '/api/processes/myapp/start');
      route.handler.should.equal('startProcess');
      route.name.should.equal('myapp');
    });

    it('should parse POST /api/processes/:name/stop', function() {
      var route = HttpApi.parseRoute('POST', '/api/processes/myapp/stop');
      route.handler.should.equal('stopProcess');
      route.name.should.equal('myapp');
    });

    it('should parse POST /api/processes/:name/restart', function() {
      var route = HttpApi.parseRoute('POST', '/api/processes/worker/restart');
      route.handler.should.equal('restartProcess');
      route.name.should.equal('worker');
    });

    it('should return 404 for unknown routes', function() {
      var route = HttpApi.parseRoute('GET', '/unknown');
      route.handler.should.equal('notFound');
    });

    it('should return 405 for wrong method', function() {
      var route = HttpApi.parseRoute('DELETE', '/api/processes/myapp/stop');
      route.handler.should.equal('methodNotAllowed');
    });

    it('should return 405 for GET on action routes', function() {
      var route = HttpApi.parseRoute('GET', '/api/processes/myapp/stop');
      route.handler.should.equal('methodNotAllowed');
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha test/programmatic/http_api.mocha.js --timeout 10000 --exit`
Expected: FAIL — `HttpApi.formatProcessList is not a function`

- [ ] **Step 3: Implement `formatProcessList` and `parseRoute`**

Add to `lib/API/HttpApi.js` before `module.exports`:

```javascript
function formatProcessList(processes) {
  return {
    processes: (processes || []).map(function(proc) {
      return {
        name: proc.pm2_env.name,
        pm_id: proc.pm_id,
        pid: proc.pid,
        status: proc.pm2_env.status,
        cpu: proc.monit.cpu || 0,
        memory: proc.monit.memory || 0,
        uptime: proc.pm2_env.pm_uptime ? Math.floor((Date.now() - proc.pm2_env.pm_uptime) / 1000) : 0,
        restarts: proc.pm2_env.restart_time || 0
      };
    })
  };
}

function parseRoute(method, pathname) {
  // GET /metrics
  if (pathname === '/metrics' && method === 'GET') {
    return { handler: 'metrics' };
  }

  // GET /api/processes
  if (pathname === '/api/processes' && method === 'GET') {
    return { handler: 'listProcesses' };
  }

  // POST /api/processes
  if (pathname === '/api/processes' && method === 'POST') {
    return { handler: 'createProcess' };
  }

  // POST /api/processes/:name/(start|stop|restart)
  var actionMatch = pathname.match(/^\/api\/processes\/([^/]+)\/(start|stop|restart)$/);
  if (actionMatch) {
    if (method !== 'POST') {
      return { handler: 'methodNotAllowed' };
    }
    var actionMap = { start: 'startProcess', stop: 'stopProcess', restart: 'restartProcess' };
    return { handler: actionMap[actionMatch[2]], name: decodeURIComponent(actionMatch[1]) };
  }

  // Wrong method on known paths
  if (pathname === '/metrics' || pathname === '/api/processes') {
    return { handler: 'methodNotAllowed' };
  }

  return { handler: 'notFound' };
}
```

Update `module.exports`:

```javascript
module.exports = {
  formatPrometheusMetrics: formatPrometheusMetrics,
  formatProcessList: formatProcessList,
  parseRoute: parseRoute
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx mocha test/programmatic/http_api.mocha.js --timeout 10000 --exit`
Expected: All passing

- [ ] **Step 5: Commit**

```bash
git add lib/API/HttpApi.js test/programmatic/http_api.mocha.js
git commit -m "feat: add JSON formatter and URL router for HttpApi"
```

---

### Task 3: API key auth

**Files:**
- Modify: `test/programmatic/http_api.mocha.js`
- Modify: `lib/API/HttpApi.js`

- [ ] **Step 1: Write failing tests for `loadOrCreateApiKey` and `checkAuth`**

Append to `test/programmatic/http_api.mocha.js` inside `describe('HttpApi')`:

```javascript
  describe('loadOrCreateApiKey', function() {
    var tmpDir = path.join(__dirname, '..', 'tmp_api_key_test');
    var keyPath;

    beforeEach(function() {
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      keyPath = path.join(tmpDir, 'api-key');
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    });

    afterEach(function() {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
      if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir);
    });

    it('should generate a new key if none exists', function() {
      var key = HttpApi.loadOrCreateApiKey(keyPath);
      key.should.be.a.String();
      key.length.should.equal(64);
      fs.existsSync(keyPath).should.be.true();
      fs.readFileSync(keyPath, 'utf8').should.equal(key);
    });

    it('should reuse existing key', function() {
      fs.writeFileSync(keyPath, 'existingtoken123');
      var key = HttpApi.loadOrCreateApiKey(keyPath);
      key.should.equal('existingtoken123');
    });
  });

  describe('checkAuth', function() {
    it('should return true for valid bearer token', function() {
      HttpApi.checkAuth('Bearer abc123', 'abc123').should.be.true();
    });

    it('should return false for invalid token', function() {
      HttpApi.checkAuth('Bearer wrong', 'abc123').should.be.false();
    });

    it('should return false for missing header', function() {
      HttpApi.checkAuth(undefined, 'abc123').should.be.false();
    });

    it('should return false for malformed header', function() {
      HttpApi.checkAuth('Basic abc123', 'abc123').should.be.false();
    });
  });
```

Add at the top of the test file:

```javascript
var path = require('path');
var fs = require('fs');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha test/programmatic/http_api.mocha.js --timeout 10000 --exit`
Expected: FAIL — `HttpApi.loadOrCreateApiKey is not a function`

- [ ] **Step 3: Implement `loadOrCreateApiKey` and `checkAuth`**

Add to `lib/API/HttpApi.js` before `module.exports`:

```javascript
function loadOrCreateApiKey(keyPath) {
  try {
    return fs.readFileSync(keyPath, 'utf8').trim();
  } catch (e) {
    // File doesn't exist, generate new key
    var key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    return key;
  }
}

function checkAuth(authHeader, apiKey) {
  if (!authHeader) return false;
  var parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return false;
  return parts[1] === apiKey;
}
```

Update `module.exports`:

```javascript
module.exports = {
  formatPrometheusMetrics: formatPrometheusMetrics,
  formatProcessList: formatProcessList,
  parseRoute: parseRoute,
  loadOrCreateApiKey: loadOrCreateApiKey,
  checkAuth: checkAuth
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx mocha test/programmatic/http_api.mocha.js --timeout 10000 --exit`
Expected: All passing

- [ ] **Step 5: Commit**

```bash
git add lib/API/HttpApi.js test/programmatic/http_api.mocha.js
git commit -m "feat: add API key auth for HttpApi"
```

---

### Task 4: HTTP server and request handling

**Files:**
- Modify: `test/programmatic/http_api.mocha.js`
- Modify: `lib/API/HttpApi.js`

- [ ] **Step 1: Write failing integration tests for the HTTP server**

Append to `test/programmatic/http_api.mocha.js` inside `describe('HttpApi')`:

```javascript
  describe('HTTP server', function() {
    var server;
    var port = 19615;
    var apiKey = 'testtoken123';
    var mockApi;

    before(function(done) {
      // Mock API object with the methods HttpApi needs
      mockApi = {
        Client: {
          executeRemote: function(method, data, cb) {
            if (method === 'getMonitorData') {
              return cb(null, [
                {
                  pid: 1234, name: 'testapp', pm_id: 0,
                  pm2_env: { name: 'testapp', status: 'online', pm_uptime: Date.now() - 60000, restart_time: 1 },
                  monit: { memory: 1024, cpu: 5.5 }
                }
              ]);
            }
            if (method === 'startProcessId') {
              return cb(null, { pm_id: data.id, status: 'online' });
            }
            if (method === 'stopProcessId') {
              return cb(null, { pm_id: data.id, status: 'stopped' });
            }
            if (method === 'restartProcessId') {
              return cb(null, { pm_id: data.id, status: 'online' });
            }
            return cb(new Error('Unknown method: ' + method));
          }
        },
        start: function(script, opts, cb) {
          cb(null, [{ pm2_env: { name: opts.name || 'app', status: 'online' } }]);
        }
      };

      server = HttpApi.createServer(mockApi, apiKey);
      server.listen(port, done);
    });

    after(function(done) {
      server.close(done);
    });

    it('GET /metrics should return prometheus text without auth', function(done) {
      http.get('http://127.0.0.1:' + port + '/metrics', function(res) {
        res.statusCode.should.equal(200);
        res.headers['content-type'].should.startWith('text/plain');
        var body = '';
        res.on('data', function(chunk) { body += chunk; });
        res.on('end', function() {
          body.should.containEql('zm2_process_cpu_percent{name="testapp"} 5.5');
          done();
        });
      });
    });

    it('GET /api/processes should require auth', function(done) {
      http.get('http://127.0.0.1:' + port + '/api/processes', function(res) {
        res.statusCode.should.equal(401);
        done();
      });
    });

    it('GET /api/processes should return JSON with valid auth', function(done) {
      var opts = {
        hostname: '127.0.0.1', port: port, path: '/api/processes',
        headers: { 'Authorization': 'Bearer ' + apiKey }
      };
      http.get(opts, function(res) {
        res.statusCode.should.equal(200);
        var body = '';
        res.on('data', function(chunk) { body += chunk; });
        res.on('end', function() {
          var data = JSON.parse(body);
          data.processes.should.be.an.Array();
          data.processes[0].name.should.equal('testapp');
          done();
        });
      });
    });

    it('POST /api/processes/:name/stop should stop process', function(done) {
      var opts = {
        hostname: '127.0.0.1', port: port, path: '/api/processes/testapp/stop',
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey }
      };
      var req = http.request(opts, function(res) {
        res.statusCode.should.equal(200);
        var body = '';
        res.on('data', function(chunk) { body += chunk; });
        res.on('end', function() {
          var data = JSON.parse(body);
          data.success.should.be.true();
          done();
        });
      });
      req.end();
    });

    it('POST /api/processes/:name/restart should restart process', function(done) {
      var opts = {
        hostname: '127.0.0.1', port: port, path: '/api/processes/testapp/restart',
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey }
      };
      var req = http.request(opts, function(res) {
        res.statusCode.should.equal(200);
        var body = '';
        res.on('data', function(chunk) { body += chunk; });
        res.on('end', function() {
          var data = JSON.parse(body);
          data.success.should.be.true();
          done();
        });
      });
      req.end();
    });

    it('POST /api/processes should create a new process', function(done) {
      var postData = JSON.stringify({ script: '/tmp/app.js', name: 'newapp' });
      var opts = {
        hostname: '127.0.0.1', port: port, path: '/api/processes',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      var req = http.request(opts, function(res) {
        res.statusCode.should.equal(200);
        var body = '';
        res.on('data', function(chunk) { body += chunk; });
        res.on('end', function() {
          var data = JSON.parse(body);
          data.success.should.be.true();
          done();
        });
      });
      req.write(postData);
      req.end();
    });

    it('POST /api/processes should return 400 without script', function(done) {
      var postData = JSON.stringify({ name: 'noapp' });
      var opts = {
        hostname: '127.0.0.1', port: port, path: '/api/processes',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      var req = http.request(opts, function(res) {
        res.statusCode.should.equal(400);
        done();
      });
      req.write(postData);
      req.end();
    });

    it('GET /unknown should return 404', function(done) {
      var opts = {
        hostname: '127.0.0.1', port: port, path: '/unknown',
        headers: { 'Authorization': 'Bearer ' + apiKey }
      };
      http.get(opts, function(res) {
        res.statusCode.should.equal(404);
        done();
      });
    });

    it('DELETE /api/processes/myapp/stop should return 405', function(done) {
      var opts = {
        hostname: '127.0.0.1', port: port, path: '/api/processes/myapp/stop',
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + apiKey }
      };
      var req = http.request(opts, function(res) {
        res.statusCode.should.equal(405);
        done();
      });
      req.end();
    });
  });
```

Add at top of test file:

```javascript
var http = require('http');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha test/programmatic/http_api.mocha.js --timeout 10000 --exit`
Expected: FAIL — `HttpApi.createServer is not a function`

- [ ] **Step 3: Implement `createServer`**

Add to `lib/API/HttpApi.js` before `module.exports`:

```javascript
function sendJson(res, statusCode, data) {
  var body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, cb) {
  var body = '';
  req.on('data', function(chunk) { body += chunk; });
  req.on('end', function() {
    if (!body) return cb(null, null);
    try {
      cb(null, JSON.parse(body));
    } catch (e) {
      cb(e);
    }
  });
}

function createServer(api, apiKey) {
  var server = http.createServer(function(req, res) {
    var parsed = url.parse(req.url);
    var pathname = parsed.pathname;
    var method = req.method;
    var route = parseRoute(method, pathname);

    // Auth check for /api/* routes
    if (pathname.startsWith('/api/')) {
      if (!checkAuth(req.headers['authorization'], apiKey)) {
        return sendJson(res, 401, { success: false, error: 'Unauthorized' });
      }
    }

    switch (route.handler) {
      case 'metrics':
        api.Client.executeRemote('getMonitorData', {}, function(err, list) {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            return res.end('Internal Server Error');
          }
          var output = formatPrometheusMetrics(list);
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
          res.end(output);
        });
        break;

      case 'listProcesses':
        api.Client.executeRemote('getMonitorData', {}, function(err, list) {
          if (err) return sendJson(res, 500, { success: false, error: err.message });
          sendJson(res, 200, formatProcessList(list));
        });
        break;

      case 'createProcess':
        readBody(req, function(err, data) {
          if (err) return sendJson(res, 400, { success: false, error: 'Invalid JSON' });
          if (!data || !data.script) return sendJson(res, 400, { success: false, error: 'Missing required field: script' });
          var opts = {};
          if (data.name) opts.name = data.name;
          if (data.cwd) opts.cwd = data.cwd;
          if (data.interpreter) opts.interpreter = data.interpreter;
          if (data.env) opts.env = data.env;
          api.start(data.script, opts, function(err) {
            if (err) return sendJson(res, 500, { success: false, error: err.message || String(err) });
            sendJson(res, 200, { success: true, message: 'Process ' + (data.name || data.script) + ' created' });
          });
        });
        break;

      case 'startProcess':
        api.Client.executeRemote('startProcessId', { id: route.name }, function(err) {
          if (err) return sendJson(res, 500, { success: false, error: err.message });
          sendJson(res, 200, { success: true, message: 'Process ' + route.name + ' started' });
        });
        break;

      case 'stopProcess':
        api.Client.executeRemote('stopProcessId', { id: route.name }, function(err) {
          if (err) return sendJson(res, 500, { success: false, error: err.message });
          sendJson(res, 200, { success: true, message: 'Process ' + route.name + ' stopped' });
        });
        break;

      case 'restartProcess':
        api.Client.executeRemote('restartProcessId', { id: route.name }, function(err) {
          if (err) return sendJson(res, 500, { success: false, error: err.message });
          sendJson(res, 200, { success: true, message: 'Process ' + route.name + ' restarted' });
        });
        break;

      case 'methodNotAllowed':
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        break;

      case 'notFound':
      default:
        sendJson(res, 404, { success: false, error: 'Not found' });
        break;
    }
  });

  return server;
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
  createServer: createServer
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx mocha test/programmatic/http_api.mocha.js --timeout 10000 --exit`
Expected: All passing

- [ ] **Step 5: Commit**

```bash
git add lib/API/HttpApi.js test/programmatic/http_api.mocha.js
git commit -m "feat: add HTTP server with routing and auth for HttpApi"
```

---

### Task 5: CLI and API.js integration

**Files:**
- Modify: `lib/API.js` (~line 120 for method, add after existing methods)
- Modify: `lib/binaries/CLI.js` (~line 895, near `serve` command)

- [ ] **Step 1: Add `api()` method to `lib/API.js`**

Read the file to find the exact location. Add after the `serve` method or at the end of the class, before `module.exports`:

```javascript
/**
 * Start the HTTP API server with Prometheus metrics
 */
API.prototype.api = function(opts, cb) {
  var that = this;
  var HttpApi = require('./API/HttpApi');
  var conf = require('../constants');

  var port = opts.port || conf.WEB_PORT || 9615;
  var keyPath = path.join(that.pm2_home, 'api-key');

  that.Client.start(function(err) {
    if (err) {
      console.error('[ZM2][ERROR] Failed to connect to systemd:', err.message);
      return cb ? cb(err) : that.exitCli(1);
    }

    var apiKey = HttpApi.loadOrCreateApiKey(keyPath);
    var server = HttpApi.createServer(that, apiKey);

    server.listen(port, '0.0.0.0', function() {
      console.log('ZM2 API listening on 0.0.0.0:' + port);
      console.log('API Key: ' + apiKey);
      console.log('Usage: curl -H "Authorization: Bearer ' + apiKey + '" http://localhost:' + port + '/api/processes');
      console.log('Prometheus: http://localhost:' + port + '/metrics');
    });

    server.on('error', function(err) {
      console.error('[ZM2][ERROR] API server error:', err.message);
      if (cb) cb(err);
    });

    process.on('SIGINT', function() {
      console.log('\nShutting down ZM2 API...');
      server.close(function() {
        that.Client.close(function() {
          process.exit(0);
        });
      });
    });

    process.on('SIGTERM', function() {
      server.close(function() {
        that.Client.close(function() {
          process.exit(0);
        });
      });
    });
  });
};
```

- [ ] **Step 2: Add `zm2 api` command to `lib/binaries/CLI.js`**

Add near the `serve` command (around line 895):

```javascript
commander.command('api')
  .option('--port [port]', 'specify port to listen to', parseInt)
  .description('start HTTP API server with Prometheus metrics endpoint')
  .action(function(opts) {
    pm2.api({
      port: opts.port || process.env.ZM2_API_PORT
    });
  });
```

- [ ] **Step 3: Verify the CLI command is wired correctly**

Run: `node bin/zm2 api --help`
Expected output should show the `api` command with `--port` option.

- [ ] **Step 4: Commit**

```bash
git add lib/API.js lib/binaries/CLI.js
git commit -m "feat: add zm2 api command for HTTP API server"
```

---

### Task 6: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add HTTP API section to CLAUDE.md**

Add after the "Logging" section:

```markdown
## HTTP API & Prometheus

`zm2 api [--port 9615]` starts an HTTP server with:
- `GET /metrics` — Prometheus metrics (no auth)
- `GET /api/processes` — List processes (requires bearer token)
- `POST /api/processes` — Create new process (requires bearer token, body: `{script, name?, cwd?, interpreter?, env?}`)
- `POST /api/processes/:name/start|stop|restart` — Control process (requires bearer token)

API key auto-generated on first run, stored at `~/.zm2/api-key`. Printed to stdout on startup.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add HTTP API section to CLAUDE.md"
```
