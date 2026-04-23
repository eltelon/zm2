/**
 * Copyright 2024 the ZM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

'use strict';

var path = require('path');
var which = require('../tools/which.js');

/**
 * Convert milliseconds to seconds, with a minimum of 1s
 */
function msToSec(ms) {
  if (!ms) return null;
  var sec = Math.max(1, Math.round(parseInt(ms, 10) / 1000));
  return sec;
}

/**
 * Parse a memory string like "200M", "1G", "500000" (bytes) into systemd format
 */
function parseMemory(value) {
  if (!value) return null;
  if (typeof value === 'number') {
    // bytes -> megabytes for systemd
    return Math.round(value / (1024 * 1024)) + 'M';
  }
  var str = String(value).trim().toUpperCase();
  // Already in a format systemd understands (e.g. "200M", "1G")
  if (/^\d+[KMGT]?$/.test(str)) {
    return str;
  }
  // Try parsing as bytes
  var bytes = parseInt(str, 10);
  if (!isNaN(bytes)) {
    return Math.round(bytes / (1024 * 1024)) + 'M';
  }
  return null;
}

/**
 * Build the ExecStart line from app config
 */
function buildExecStart(conf) {
  var parts = [];

  // Interpreter (default: node)
  var interpreter = conf.exec_interpreter || 'node';
  if (interpreter === 'none' || interpreter === '') {
    // Script is directly executable
    interpreter = null;
  }

  if (interpreter) {
    // systemd requires absolute paths in ExecStart
    if (interpreter.charAt(0) !== '/') {
      // Relative path (e.g. .venv/bin/python) — resolve against cwd
      if (interpreter.indexOf('/') !== -1) {
        var cwd = conf.pm_cwd || conf.cwd || process.cwd();
        interpreter = path.resolve(cwd, interpreter);
      } else {
        // Plain binary name — look up in PATH
        var resolved = which(interpreter);
        if (resolved) {
          interpreter = resolved;
        }
      }
    }
    parts.push(interpreter);
  }

  // Node args (e.g. --max-old-space-size=4096)
  if (conf.node_args && conf.node_args.length) {
    var nodeArgs = Array.isArray(conf.node_args) ? conf.node_args : [conf.node_args];
    parts = parts.concat(nodeArgs);
  }

  // Script path
  var scriptPath = conf.pm_exec_path || conf.script;
  parts.push(scriptPath);

  // App args
  if (conf.args) {
    var appArgs = Array.isArray(conf.args) ? conf.args : String(conf.args).split(' ');
    appArgs = appArgs.filter(function(a) { return a; });

    // Special case: bash/sh -c "<command>" — the argument after -c must be a
    // single quoted token so systemd passes it correctly to the shell.
    var isBashC = (scriptPath === '/usr/bin/bash' || scriptPath === '/bin/bash' ||
                   scriptPath === '/usr/bin/sh'   || scriptPath === '/bin/sh') &&
                  appArgs.length >= 2 && appArgs[0] === '-c';
    if (isBashC) {
      // Join everything after -c into one double-quoted string
      var cmd = appArgs.slice(1).join(' ').replace(/"/g, '\\"');
      parts.push('-c');
      parts.push('"' + cmd + '"');
    } else {
      parts = parts.concat(appArgs);
    }
  }

  return parts.join(' ');
}

/**
 * Generate the service name from app config
 */
function serviceName(conf) {
  var name = conf.name || path.basename(conf.pm_exec_path || conf.script, '.js');
  // Sanitize for systemd: only alphanumeric, dash, underscore
  name = name.replace(/[^a-zA-Z0-9_-]/g, '-');
  return 'zm2-' + name;
}

/**
 * Generate a systemd unit file string from an app config object (pm2_env format)
 *
 * @param {Object} conf - App configuration (pm2_env style)
 * @param {Object} opts - Options { instanceId: number|null }
 * @returns {String} systemd unit file content
 */
function generate(conf, opts) {
  opts = opts || {};
  var isTemplate = opts.isTemplate || false;

  var lines = [];

  // [Unit]
  lines.push('[Unit]');
  lines.push('Description=ZM2: ' + (conf.name || 'app'));
  lines.push('After=network.target');
  lines.push('');

  // [Service]
  lines.push('[Service]');
  lines.push('Type=simple');

  // Working directory
  var cwd = conf.pm_cwd || conf.cwd || process.cwd();
  lines.push('WorkingDirectory=' + cwd);

  // User/Group
  if (conf.user || conf.uid) {
    lines.push('User=' + (conf.user || conf.uid));
  }
  if (conf.gid) {
    lines.push('Group=' + conf.gid);
  }

  // ExecStart
  lines.push('ExecStart=' + buildExecStart(conf));

  // Restart policy
  if (conf.autorestart === false) {
    lines.push('Restart=no');
  } else {
    lines.push('Restart=on-failure');
  }

  // Restart delay
  var restartSec = msToSec(conf.restart_delay);
  if (restartSec) {
    lines.push('RestartSec=' + restartSec);
  }

  // Start limit (max restarts within min_uptime window)
  if (conf.max_restarts) {
    lines.push('StartLimitBurst=' + parseInt(conf.max_restarts, 10));
  }
  var minUptimeSec = msToSec(conf.min_uptime);
  if (minUptimeSec) {
    lines.push('StartLimitIntervalSec=' + minUptimeSec);
  }

  // Kill timeout
  var killTimeoutSec = msToSec(conf.kill_timeout);
  if (killTimeoutSec) {
    lines.push('TimeoutStopSec=' + killTimeoutSec);
  }

  // Start timeout
  var listenTimeoutSec = msToSec(conf.listen_timeout);
  if (listenTimeoutSec) {
    lines.push('TimeoutStartSec=' + listenTimeoutSec);
  }

  // Kill signal
  if (conf.kill_signal) {
    lines.push('KillSignal=' + conf.kill_signal);
  }

  // Memory limit
  var memLimit = parseMemory(conf.max_memory_restart);
  if (memLimit) {
    lines.push('MemoryMax=' + memLimit);
  }

  // Success exit status (stop_exit_codes)
  if (conf.stop_exit_codes && Array.isArray(conf.stop_exit_codes) && conf.stop_exit_codes.length) {
    lines.push('SuccessExitStatus=' + conf.stop_exit_codes.join(' '));
  }

  // Environment file
  var svcName = serviceName(conf);
  lines.push('EnvironmentFile=-/etc/zm2/env/' + svcName + '.env');

  // For template units, inject the instance variable
  if (isTemplate) {
    var instanceVar = conf.instance_var || 'NODE_APP_INSTANCE';
    lines.push('Environment=' + instanceVar + '=%i');
  }

  // Resource limits
  lines.push('LimitNOFILE=65536');

  lines.push('');

  // [Install]
  lines.push('[Install]');
  lines.push('WantedBy=multi-user.target');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate an environment file content from conf.env
 *
 * @param {Object} conf - App configuration
 * @returns {String} env file content (KEY=VALUE per line)
 */
function generateEnvFile(conf) {
  var env = conf.env || {};
  var lines = [];

  // Add standard env vars
  if (conf.port) {
    env.PORT = conf.port;
  }
  if (conf.source_map_support !== false) {
    env.NODE_OPTIONS = (env.NODE_OPTIONS || '') + ' --enable-source-maps';
    env.NODE_OPTIONS = env.NODE_OPTIONS.trim();
  }

  Object.keys(env).forEach(function(key) {
    // Skip internal pm2 vars and non-scalar values
    if (key.indexOf('pm_') === 0 || key === 'pm2_env' || key === 'current_conf') return;
    var val = env[key];
    if (val === undefined || val === null) return;
    if (typeof val === 'object') return;
    // Quote values that contain spaces or special characters
    val = String(val);
    if (/[\s"'\\$`]/.test(val)) {
      val = '"' + val.replace(/["\\$`]/g, '\\$&') + '"';
    }
    lines.push(key + '=' + val);
  });

  return lines.join('\n') + '\n';
}

/**
 * Generate a systemd timer unit for cron restart
 *
 * @param {String} svcName - Service name (e.g. zm2-myapp)
 * @param {String} cronExpr - Cron expression (e.g. "0 0 * * *")
 * @returns {Object} { timer: string, service: string } unit file contents
 */
function generateCronTimer(svcName, cronExpr) {
  var calendar = cronToCalendar(cronExpr);

  var timer = [
    '[Unit]',
    'Description=ZM2 cron restart for ' + svcName,
    '',
    '[Timer]',
    'OnCalendar=' + calendar,
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    ''
  ].join('\n');

  var service = [
    '[Unit]',
    'Description=ZM2 cron restart trigger for ' + svcName,
    '',
    '[Service]',
    'Type=oneshot',
    'ExecStart=/usr/bin/systemctl restart ' + svcName + '.service',
    ''
  ].join('\n');

  return { timer: timer, service: service };
}

/**
 * Convert a cron expression to systemd OnCalendar format.
 * Supports standard 5-field cron: min hour dom month dow
 *
 * @param {String} cron - Cron expression
 * @returns {String} systemd calendar expression
 */
function cronToCalendar(cron) {
  var parts = cron.trim().split(/\s+/);
  if (parts.length < 5) {
    // Fallback: pass through (systemd may accept some cron-like syntax)
    return cron;
  }

  var min = parts[0];
  var hour = parts[1];
  var dom = parts[2];
  var month = parts[3];
  var dow = parts[4];

  // Map cron day-of-week (0=Sun) to systemd (Sun,Mon,...)
  var dowMap = { '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat', '7': 'Sun' };

  var calDow = '*';
  if (dow !== '*') {
    calDow = dow.split(',').map(function(d) {
      return dowMap[d] || d;
    }).join(',');
  }

  // systemd calendar format: DayOfWeek Year-Month-Day Hour:Minute:Second
  var calDate = '*-' + month + '-' + dom;
  var calTime = hour + ':' + min + ':00';

  var result = '';
  if (calDow !== '*') {
    result = calDow + ' ' + calDate + ' ' + calTime;
  } else {
    result = calDate + ' ' + calTime;
  }

  return result;
}

module.exports = {
  generate: generate,
  generateEnvFile: generateEnvFile,
  generateCronTimer: generateCronTimer,
  serviceName: serviceName,
  cronToCalendar: cronToCalendar,
  buildExecStart: buildExecStart,
  parseMemory: parseMemory
};
