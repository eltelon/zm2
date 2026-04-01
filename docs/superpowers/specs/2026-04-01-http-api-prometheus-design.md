# ZM2 HTTP API + Prometheus Exporter — Design Spec

## Overview

Add an HTTP server to ZM2 that serves both a Prometheus metrics endpoint and a REST API for managing processes. Accessible via `zm2 api` CLI command.

## Decisions

- **Delivery**: CLI command `zm2 api` (not a background systemd service)
- **Single port**: Metrics and control API on the same port (default 9615)
- **API key auth on API routes**: `/api/*` routes require bearer token; `/metrics` remains open
- **No dependencies**: Uses Node's native `http` module
- **Single file**: `lib/API/HttpApi.js` contains server, routing, and Prometheus formatting

## HTTP Routes

| Method | Route | Body | Description |
|--------|-------|------|-------------|
| GET | `/metrics` | — | Prometheus metrics (text/plain; version=0.0.4) |
| GET | `/api/processes` | — | List all processes with status |
| POST | `/api/processes` | JSON (see below) | Create and start a new process |
| POST | `/api/processes/:name/start` | — | Start a stopped process |
| POST | `/api/processes/:name/stop` | — | Stop a running process |
| POST | `/api/processes/:name/restart` | — | Restart a process |

### POST /api/processes — Request Body

```json
{
  "script": "/path/to/app.js",
  "name": "myapp",
  "cwd": "/path/to",
  "interpreter": "node",
  "env": { "PORT": "3000" }
}
```

- `script` (string, **required**): Path to the script to run.
- `name` (string, optional): Process name. Derived from script filename if omitted.
- `cwd` (string, optional): Working directory. Defaults to script's directory.
- `interpreter` (string, optional): Interpreter binary. Defaults to `node`.
- `env` (object, optional): Environment variables to set for the process.

## Prometheus Metrics

All metrics use the `zm2_` prefix and include a `name` label identifying the process.

### Gauges

| Metric | Type | Description |
|--------|------|-------------|
| `zm2_process_cpu_percent` | gauge | CPU usage percentage (0-100) |
| `zm2_process_memory_bytes` | gauge | Memory usage in bytes |
| `zm2_process_uptime_seconds` | gauge | Seconds since process started |
| `zm2_process_restart_count` | gauge | Total restart count |
| `zm2_process_status` | gauge | 1 if process is in the labeled status, 0 otherwise |

### Example Output

```
# HELP zm2_process_cpu_percent CPU usage percentage
# TYPE zm2_process_cpu_percent gauge
zm2_process_cpu_percent{name="myapp"} 12.5
zm2_process_cpu_percent{name="worker"} 3.2

# HELP zm2_process_memory_bytes Memory usage in bytes
# TYPE zm2_process_memory_bytes gauge
zm2_process_memory_bytes{name="myapp"} 52428800
zm2_process_memory_bytes{name="worker"} 31457280

# HELP zm2_process_uptime_seconds Process uptime in seconds
# TYPE zm2_process_uptime_seconds gauge
zm2_process_uptime_seconds{name="myapp"} 3600
zm2_process_uptime_seconds{name="worker"} 7200

# HELP zm2_process_restart_count Total number of restarts
# TYPE zm2_process_restart_count gauge
zm2_process_restart_count{name="myapp"} 2
zm2_process_restart_count{name="worker"} 0

# HELP zm2_process_status Process status (1 = current, 0 = not current)
# TYPE zm2_process_status gauge
zm2_process_status{name="myapp",status="online"} 1
zm2_process_status{name="myapp",status="stopped"} 0
zm2_process_status{name="myapp",status="errored"} 0
zm2_process_status{name="worker",status="online"} 1
zm2_process_status{name="worker",status="stopped"} 0
zm2_process_status{name="worker",status="errored"} 0
```

## Authentication

API key auth protects all `/api/*` routes. `/metrics` remains unauthenticated so Prometheus can scrape without credentials.

### API Key Management

On startup, `zm2 api`:

- If `~/.zm2/api-key` exists, reads and uses the existing token
- If it does not exist, generates a 32-byte random token (hex encoded, 64 chars) using `crypto.randomBytes`, saves to `~/.zm2/api-key`
- Always prints the token to stdout at startup so the user can copy it
- To regenerate: delete `~/.zm2/api-key` and restart `zm2 api`

### Behavior

- Requests to `/api/*` must include `Authorization: Bearer <token>` header
- Token is validated against the contents of `~/.zm2/api-key`
- Requests without a valid token receive `401 Unauthorized`
- Requests to `/metrics` are always allowed regardless of auth headers

### 401 Response

```json
{
  "success": false,
  "error": "Unauthorized"
}
```

## JSON Response Formats

### GET /api/processes

```json
{
  "processes": [
    {
      "name": "myapp",
      "pm_id": 0,
      "pid": 1234,
      "status": "online",
      "cpu": 12.5,
      "memory": 52428800,
      "uptime": 3600,
      "restarts": 2
    }
  ]
}
```

### POST success (start/stop/restart/create)

```json
{
  "success": true,
  "message": "Process myapp restarted"
}
```

### Error responses

```json
{
  "success": false,
  "error": "Process notfound not found"
}
```

### HTTP Status Codes

| Code | When |
|------|------|
| 200 | Successful GET or POST |
| 400 | Invalid JSON body or missing required fields |
| 401 | Missing or invalid bearer token on `/api/*` routes |
| 404 | Unknown route or process not found |
| 405 | Wrong HTTP method for route |
| 500 | Internal error (systemd communication failure) |

## Architecture

### New File

- `lib/API/HttpApi.js` — Server, routing, Prometheus formatter, API handlers.

### Modified Files

- `lib/binaries/CLI.js` — Add `zm2 api` command.
- `lib/API.js` — Add `api()` method that instantiates and starts `HttpApi`.

### Data Flow

```
HTTP Request
  → HttpApi.handleRequest(req, res)
    → Route matching (URL parsing + method check)
      → GET /metrics:
          SystemdClient.executeRemote('getMonitorData')
          → formatPrometheusMetrics(processes) → text/plain response
      → GET /api/processes:
          SystemdClient.executeRemote('getMonitorData')
          → formatProcessList(processes) → JSON response
      → POST /api/processes:
          Parse JSON body
          → API.start(script, opts) → JSON response
      → POST /api/processes/:name/start:
          API._operate('startProcessId', name) → JSON response
      → POST /api/processes/:name/stop:
          API._operate('stopProcessId', name) → JSON response
      → POST /api/processes/:name/restart:
          API._operate('restartProcessId', name) → JSON response
```

### Integration with API.js

`HttpApi` receives a reference to the `API` instance in its constructor. It uses:

- `api.Client.executeRemote('getMonitorData', {}, cb)` — for metrics and process list
- `api.start(script, opts, cb)` — for creating new processes
- `api.stop(name, cb)` — for stopping
- `api.restart(name, {}, cb)` — for restarting
- `api.Client.executeRemote('startProcessId', {id: name}, cb)` — for starting stopped processes

Note: `start` for stopped processes goes through `SystemdClient` directly because `API.start()` is designed for new process creation from a script path. For already-registered processes, `startProcessId` resumes the existing systemd unit.

### CLI Integration

```
zm2 api [--port <number>]
```

- Default port: 9615 (configurable via `--port` flag or `ZM2_API_PORT` env var)
- Generates API key on first run, reuses on subsequent runs (saved at `~/.zm2/api-key`)
- Logs to stdout: `ZM2 API listening on 0.0.0.0:9615`
- Stays in foreground (blocking command)
- Graceful shutdown on SIGINT/SIGTERM

## Testing

Unit tests in `test/programmatic/http_api.mocha.js`:

- Prometheus output format validation (HELP/TYPE lines, label format, numeric values)
- JSON response structure for each route
- Bearer token auth enforcement: 401 on `/api/*` without valid token, 200 with valid token
- `/metrics` accessible without auth
- 404/405/400 error handling
- Process name extraction from URL
- Request body parsing and validation

No E2E HTTP tests (would require systemd). Unit tests cover formatting and routing logic.
