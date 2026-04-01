/**
 * Copyright 2013-2022 the PM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */
var util   = require('util');
var chalk  = require('ansis');
var dayjs  = require('dayjs');
var path   = require('path');

var Systemd = require('../Systemd.js');
var StateStore = require('../Systemd/StateStore.js');
var cst = require('../../constants.js');

var Log = module.exports = {};

var DEFAULT_PADDING = '          ';

/**
 * Resolve an id (name, pm_id number, or 'all') to a systemd service name.
 * Returns null for 'all'.
 *
 * @param {String} id
 * @returns {String|null} service name or null for all
 */
function resolveServiceName(id) {
  if (id === 'all' || id === 'PM2') return null;

  // If it's a number, look up by pm_id
  if (!isNaN(parseInt(id, 10)) && String(parseInt(id, 10)) === String(id)) {
    var statePath = path.join(cst.PM2_ROOT_PATH, 'state.json');
    var store = new StateStore(statePath);
    store.load();
    var entry = store.getByPmId(id);
    if (entry) return entry.serviceName;
    // Fallback: try as name
    return 'zm2-' + id;
  }

  // It's a name — add zm2- prefix if not already there
  if (id.indexOf('zm2-') === 0) return id;
  return 'zm2-' + id;
}

/**
 * Tail logs from journalctl (synchronous).
 * @param {Object} apps_list - Array of { app_name, type } (ignored in systemd mode, kept for compat)
 * @param {Number} lines
 * @param {Boolean} raw
 * @param {Function} callback
 */
Log.tail = function(apps_list, lines, raw, callback) {
  if (lines === 0 || !apps_list || apps_list.length === 0)
    return callback && callback();

  // In systemd mode, resolve service names from the apps_list
  var seen = {};
  var services = [];

  apps_list.forEach(function(app) {
    // app.app_name may be "0|createarray" or just "createarray" or "PM2"
    var name = app.app_name || 'unknown';
    // Extract name after | if present (pm_id|name format)
    if (name.indexOf('|') > -1) {
      name = name.split('|')[1];
    }
    if (name === 'PM2') return; // Skip PM2 daemon logs
    var svcName = resolveServiceName(name);
    if (!svcName || seen[svcName]) return;
    seen[svcName] = true;
    services.push({ name: svcName, app_name: name });
  });

  if (services.length === 0) {
    // If no specific services, tail all zm2 services
    if (apps_list.some(function(a) { return a.type === 'PM2'; })) {
      // Only PM2 logs requested — nothing in systemd mode
      return callback && callback();
    }
    return callback && callback();
  }

  services.forEach(function(svc) {
    var output = Systemd.getLogs(svc.name, lines);
    if (!output || output.trim().length === 0) return;

    console.log(chalk.gray('%s last %d lines:'), svc.name, lines);
    var logLines = output.split('\n');
    logLines.forEach(function(line) {
      if (!line || line.length === 0) return;
      if (raw)
        return console.log(line);
      process.stdout.write(chalk.green(pad(DEFAULT_PADDING, svc.app_name) + ' | '));
      console.log(line);
    });
    if (logLines.length)
      process.stdout.write('\n');
  });

  callback && callback();
};

/**
 * Stream logs in realtime from journalctl.
 * @param {Object} Client - SystemdClient instance
 * @param {String} id - Process name, id, or 'all'
 * @param {Boolean} raw
 * @param {String} timestamp - Timestamp format string
 * @param {String} exclusive - 'out', 'err', or false
 * @param {RegExp|String} highlight - Pattern to highlight
 */
Log.stream = function(Client, id, raw, timestamp, exclusive, highlight) {
  var svcName = resolveServiceName(id);
  var proc = Systemd.streamLogs(svcName, 20);
  var min_padding = 3;
  var displayName = id === 'all' ? 'zm2' : id;

  proc.stdout.on('data', function(data) {
    var lines = data.toString().split('\n');
    lines.forEach(function(line) {
      if (!line || line.length === 0) return;

      if (raw)
        return process.stdout.write(line + '\n');

      if (timestamp)
        process.stdout.write(chalk.dim(chalk.gray(dayjs().format(timestamp) + ' ')));

      if (displayName.length > min_padding)
        min_padding = displayName.length + 1;

      process.stdout.write(chalk.green(pad(' '.repeat(min_padding), displayName) + ' | '));

      if (highlight)
        process.stdout.write(util.format(line).replace(highlight, chalk.bgBlackBright(highlight)) + '\n');
      else
        process.stdout.write(util.format(line) + '\n');
    });
  });

  proc.stderr.on('data', function(data) {
    var lines = data.toString().split('\n');
    lines.forEach(function(line) {
      if (!line || line.length === 0) return;
      process.stderr.write(chalk.red(line) + '\n');
    });
  });
};

/**
 * Dev stream — same as stream for systemd mode.
 */
Log.devStream = function(Client, id, raw, timestamp, exclusive) {
  Log.stream(Client, id, raw, timestamp, exclusive);
};

/**
 * JSON stream from journalctl.
 */
Log.jsonStream = function(Client, id) {
  var svcName = resolveServiceName(id);
  var proc = Systemd.streamLogs(svcName, 0);

  proc.stdout.on('data', function(data) {
    var lines = data.toString().split('\n');
    lines.forEach(function(line) {
      if (!line || line.length === 0) return;
      process.stdout.write(JSON.stringify({
        message: line,
        timestamp: dayjs(),
        type: 'out',
        app_name: id
      }));
      process.stdout.write('\n');
    });
  });
};

/**
 * Format stream (key=value) from journalctl.
 */
Log.formatStream = function(Client, id, raw, timestamp, exclusive, highlight) {
  var svcName = resolveServiceName(id);
  var proc = Systemd.streamLogs(svcName, 0);

  proc.stdout.on('data', function(data) {
    var lines = data.toString().split('\n');
    lines.forEach(function(line) {
      if (!line || line.length === 0) return;

      if (!raw) {
        if (timestamp)
          process.stdout.write('timestamp=' + dayjs().format(timestamp) + ' ');
        process.stdout.write('app=' + id + ' ');
        process.stdout.write('type=out ');
      }

      process.stdout.write('message=');
      if (highlight)
        process.stdout.write(util.format(line).replace(highlight, chalk.bgBlackBright(highlight)) + '\n');
      else
        process.stdout.write(util.format(line) + '\n');
    });
  });
};

function pad(pad, str, padLeft) {
  if (typeof str === 'undefined')
    return pad;
  if (padLeft) {
    return (pad + str).slice(-pad.length);
  } else {
    return (str + pad).substring(0, pad.length);
  }
}
