/**
 * Copyright 2024 the ZM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var execFileSync = require('child_process').execFileSync;
var spawn = require('child_process').spawn;

var UNIT_DIR = '/etc/systemd/system';
var ENV_DIR = '/etc/zm2/env';

/**
 * Systemd - Low-level wrapper around systemctl and journalctl.
 * All methods are synchronous unless noted.
 */
var Systemd = {};

/**
 * Check if systemd is the init system.
 * @returns {Boolean}
 */
Systemd.isSystemd = function() {
  try {
    return fs.existsSync('/run/systemd/system');
  } catch (e) {
    return false;
  }
};

/**
 * Run systemctl with given arguments.
 * @param {Array} args
 * @returns {String} stdout
 */
Systemd._systemctl = function(args) {
  try {
    return execFileSync('systemctl', args, {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch (e) {
    if (e.stderr) {
      throw new Error('systemctl ' + args.join(' ') + ' failed: ' + e.stderr.trim());
    }
    throw e;
  }
};

/**
 * Run systemctl daemon-reload
 */
Systemd.daemonReload = function() {
  return Systemd._systemctl(['daemon-reload']);
};

/**
 * Install a systemd unit file and reload daemon.
 *
 * @param {String} name - Unit name without .service suffix
 * @param {String} content - Unit file content
 */
Systemd.installUnit = function(name, content) {
  var unitPath = path.join(UNIT_DIR, name + '.service');
  fs.writeFileSync(unitPath, content, 'utf8');
  Systemd.daemonReload();
};

/**
 * Install a systemd timer unit.
 *
 * @param {String} name - Timer name without suffix
 * @param {String} timerContent - Timer unit content
 * @param {String} serviceContent - Oneshot service content
 */
Systemd.installTimer = function(name, timerContent, serviceContent) {
  fs.writeFileSync(path.join(UNIT_DIR, name + '.timer'), timerContent, 'utf8');
  fs.writeFileSync(path.join(UNIT_DIR, name + '.service'), serviceContent, 'utf8');
  Systemd.daemonReload();
};

/**
 * Remove a unit file (stop + disable + delete + reload).
 *
 * @param {String} name - Unit name without .service suffix
 */
Systemd.removeUnit = function(name) {
  try { Systemd.stop(name); } catch (e) { /* may already be stopped */ }
  try { Systemd.disable(name); } catch (e) { /* may not be enabled */ }

  var unitPath = path.join(UNIT_DIR, name + '.service');
  if (fs.existsSync(unitPath)) {
    fs.unlinkSync(unitPath);
  }

  // Remove associated timer if exists
  var timerPath = path.join(UNIT_DIR, name + '-cron.timer');
  var timerSvcPath = path.join(UNIT_DIR, name + '-cron.service');
  if (fs.existsSync(timerPath)) {
    try { Systemd._systemctl(['stop', name + '-cron.timer']); } catch (e) {}
    try { Systemd._systemctl(['disable', name + '-cron.timer']); } catch (e) {}
    fs.unlinkSync(timerPath);
  }
  if (fs.existsSync(timerSvcPath)) {
    fs.unlinkSync(timerSvcPath);
  }

  // Remove env file
  var envPath = path.join(ENV_DIR, name + '.env');
  if (fs.existsSync(envPath)) {
    fs.unlinkSync(envPath);
  }

  Systemd.daemonReload();
};

/**
 * Remove template unit instances.
 *
 * @param {String} name - Base template name (e.g. "zm2-myapp")
 * @param {Number} instances - Number of instances to remove
 */
Systemd.removeTemplateUnit = function(name, instances) {
  for (var i = 0; i < instances; i++) {
    try { Systemd.stop(name + '@' + i); } catch (e) {}
    try { Systemd.disable(name + '@' + i); } catch (e) {}
  }

  var templatePath = path.join(UNIT_DIR, name + '@.service');
  if (fs.existsSync(templatePath)) {
    fs.unlinkSync(templatePath);
  }

  // Remove env file
  var envPath = path.join(ENV_DIR, name + '.env');
  if (fs.existsSync(envPath)) {
    fs.unlinkSync(envPath);
  }

  Systemd.daemonReload();
};

/**
 * Start a service.
 * @param {String} name - Unit name (without .service)
 */
Systemd.start = function(name) {
  return Systemd._systemctl(['start', name + '.service']);
};

/**
 * Stop a service.
 * @param {String} name
 */
Systemd.stop = function(name) {
  return Systemd._systemctl(['stop', name + '.service']);
};

/**
 * Restart a service.
 * @param {String} name
 */
Systemd.restart = function(name) {
  return Systemd._systemctl(['restart', name + '.service']);
};

/**
 * Reload or restart a service.
 * @param {String} name
 */
Systemd.reload = function(name) {
  return Systemd._systemctl(['reload-or-restart', name + '.service']);
};

/**
 * Enable a service (start on boot).
 * @param {String} name
 */
Systemd.enable = function(name) {
  return Systemd._systemctl(['enable', name + '.service']);
};

/**
 * Disable a service.
 * @param {String} name
 */
Systemd.disable = function(name) {
  return Systemd._systemctl(['disable', name + '.service']);
};

/**
 * Send a signal to the main process of a service.
 * @param {String} name
 * @param {String} signal - e.g. "SIGUSR1"
 */
Systemd.sendSignal = function(name, signal) {
  return Systemd._systemctl(['kill', '--signal=' + signal, name + '.service']);
};

/**
 * Get structured status of a service via `systemctl show`.
 *
 * @param {String} name - Unit name (without .service)
 * @returns {Object} Parsed properties
 */
Systemd.getStatus = function(name) {
  var props = [
    'ActiveState', 'SubState', 'MainPID', 'ExecMainStartTimestamp',
    'NRestarts', 'MemoryCurrent', 'CPUUsageNSec',
    'LoadState', 'Description', 'FragmentPath'
  ];

  var output = Systemd._systemctl([
    'show', name + '.service',
    '--property=' + props.join(',')
  ]);

  var result = {};
  output.split('\n').forEach(function(line) {
    var idx = line.indexOf('=');
    if (idx > -1) {
      var key = line.substring(0, idx);
      var val = line.substring(idx + 1);
      result[key] = val;
    }
  });

  // Parse numeric values
  if (result.MainPID) result.MainPID = parseInt(result.MainPID, 10) || 0;
  if (result.NRestarts) result.NRestarts = parseInt(result.NRestarts, 10) || 0;
  if (result.MemoryCurrent) {
    var mem = parseInt(result.MemoryCurrent, 10);
    result.MemoryCurrent = isNaN(mem) ? 0 : mem;
  }
  if (result.CPUUsageNSec) {
    result.CPUUsageNSec = parseInt(result.CPUUsageNSec, 10) || 0;
  }

  return result;
};

/**
 * List all ZM2-managed units.
 *
 * @returns {Array} Array of { name, activeState, subState }
 */
Systemd.listUnits = function() {
  var output;
  try {
    output = Systemd._systemctl([
      'list-units', 'zm2-*',
      '--type=service', '--all', '--no-legend', '--no-pager',
      '--plain'
    ]);
  } catch (e) {
    return [];
  }

  if (!output) return [];

  var units = [];
  output.split('\n').forEach(function(line) {
    line = line.trim();
    if (!line) return;
    // Format: UNIT LOAD ACTIVE SUB DESCRIPTION
    var parts = line.split(/\s+/);
    if (parts.length < 4) return;
    var unitName = parts[0].replace('.service', '');
    // Skip units whose file was deleted (systemd ghost entries)
    if (parts[1] === 'not-found') return;
    units.push({
      name: unitName,
      loadState: parts[1],
      activeState: parts[2],
      subState: parts[3]
    });
  });

  return units;
};

/**
 * Get logs from journalctl (synchronous, non-following).
 *
 * @param {String} name - Unit name
 * @param {Number} lines - Number of lines
 * @returns {String} Log output
 */
Systemd.getLogs = function(name, lines) {
  lines = lines || 50;
  try {
    return execFileSync('journalctl', [
      '-u', name + '.service',
      '-n', String(lines),
      '--no-pager',
      '-o', 'short-iso'
    ], { encoding: 'utf8', timeout: 10000 });
  } catch (e) {
    return '';
  }
};

/**
 * Stream logs from journalctl (returns a ChildProcess).
 *
 * @param {String|null} name - Unit name, or null for all zm2-* units
 * @param {Number} lines - Initial lines to show
 * @returns {ChildProcess}
 */
Systemd.streamLogs = function(name, lines) {
  lines = lines || 20;
  var args = ['-f', '-n', String(lines), '--no-pager', '-o', 'short-iso'];

  if (name) {
    args.push('-u', name + '.service');
  } else {
    args.push('-u', 'zm2-*');
  }

  return spawn('journalctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
};

/**
 * Write an environment file for a service.
 *
 * @param {String} name - Service name (e.g. "zm2-myapp")
 * @param {String} content - Env file content
 */
Systemd.writeEnvFile = function(name, content) {
  if (!fs.existsSync(ENV_DIR)) {
    fs.mkdirSync(ENV_DIR, { recursive: true });
  }
  fs.writeFileSync(path.join(ENV_DIR, name + '.env'), content, 'utf8');
};

/**
 * Check if a unit file exists.
 *
 * @param {String} name - Unit name without .service
 * @returns {Boolean}
 */
Systemd.unitExists = function(name) {
  return fs.existsSync(path.join(UNIT_DIR, name + '.service'));
};

module.exports = Systemd;
