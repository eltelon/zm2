/**
 * Copyright 2013-2022 the PM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

'use strict';

var http = require('http');
var crypto = require('crypto');
var url = require('url');
var fs = require('fs');
var path = require('path');

var STATUSES = ['online', 'stopped', 'errored'];

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatPrometheusMetrics(processes) {
  if (!processes || processes.length === 0) return '';

  var lines = [];

  // CPU
  lines.push('# HELP zm2_process_cpu_percent CPU usage percentage');
  lines.push('# TYPE zm2_process_cpu_percent gauge');
  processes.forEach(function(proc) {
    lines.push('zm2_process_cpu_percent{name="' + escapeLabel(proc.pm2_env.name) + '"} ' + (proc.monit.cpu || 0));
  });
  lines.push('');

  // Memory
  lines.push('# HELP zm2_process_memory_bytes Memory usage in bytes');
  lines.push('# TYPE zm2_process_memory_bytes gauge');
  processes.forEach(function(proc) {
    lines.push('zm2_process_memory_bytes{name="' + escapeLabel(proc.pm2_env.name) + '"} ' + (proc.monit.memory || 0));
  });
  lines.push('');

  // Uptime
  lines.push('# HELP zm2_process_uptime_seconds Process uptime in seconds');
  lines.push('# TYPE zm2_process_uptime_seconds gauge');
  processes.forEach(function(proc) {
    var uptime = proc.pm2_env.pm_uptime ? Math.floor((Date.now() - proc.pm2_env.pm_uptime) / 1000) : 0;
    lines.push('zm2_process_uptime_seconds{name="' + escapeLabel(proc.pm2_env.name) + '"} ' + uptime);
  });
  lines.push('');

  // Restart count
  lines.push('# HELP zm2_process_restart_count Total number of restarts');
  lines.push('# TYPE zm2_process_restart_count gauge');
  processes.forEach(function(proc) {
    lines.push('zm2_process_restart_count{name="' + escapeLabel(proc.pm2_env.name) + '"} ' + (proc.pm2_env.restart_time || 0));
  });
  lines.push('');

  // Status
  lines.push('# HELP zm2_process_status Process status (1 = current, 0 = not current)');
  lines.push('# TYPE zm2_process_status gauge');
  processes.forEach(function(proc) {
    STATUSES.forEach(function(s) {
      var val = proc.pm2_env.status === s ? 1 : 0;
      lines.push('zm2_process_status{name="' + escapeLabel(proc.pm2_env.name) + '",status="' + s + '"} ' + val);
    });
  });
  lines.push('');

  return lines.join('\n');
}

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

function loadOrCreateApiKey(keyPath) {
  try {
    return fs.readFileSync(keyPath, 'utf8').trim();
  } catch (e) {
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

module.exports = {
  formatPrometheusMetrics: formatPrometheusMetrics,
  formatProcessList: formatProcessList,
  parseRoute: parseRoute,
  loadOrCreateApiKey: loadOrCreateApiKey,
  checkAuth: checkAuth
};
