/**
 * Copyright 2024 the ZM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

'use strict';

var debug          = require('debug')('zm2:client');
var Common         = require('./Common.js');
var fs             = require('fs');
var path           = require('path');
var pkg            = require('../package.json');
var pidusage       = require('pidusage');
var EventEmitter   = require('events').EventEmitter;

var Systemd        = require('./Systemd.js');
var UnitGenerator  = require('./Systemd/UnitGenerator.js');
var StateStore     = require('./Systemd/StateStore.js');

var cst            = require('../constants.js');

function noop() {}

/**
 * SystemdClient - Drop-in replacement for Client.js that manages
 * systemd services instead of communicating with a PM2 daemon.
 */
var SystemdClient = module.exports = function(opts) {
  if (!opts) opts = {};

  if (!opts.conf)
    this.conf = require('../constants.js');
  else
    this.conf = opts.conf;

  this.daemon_mode = true;
  this.pm2_home = this.conf.PM2_ROOT_PATH;

  // Initialize state store
  var statePath = path.join(this.pm2_home, 'state.json');
  this.stateStore = new StateStore(statePath);
  this.stateStore.load();

  // Ensure home directory exists
  this.initFileStructure(this.conf);

  debug('SystemdClient initialized, pm2_home=%s', this.pm2_home);
};

/**
 * Initialize file structure (ZM2 home dir).
 */
SystemdClient.prototype.initFileStructure = function(opts) {
  if (!fs.existsSync(opts.PM2_ROOT_PATH)) {
    try {
      fs.mkdirSync(opts.PM2_ROOT_PATH, { recursive: true });
    } catch (e) {
      console.error(e.stack || e);
    }
  }

  // Create module_conf.json (required by Configuration.js)
  if (!fs.existsSync(opts.PM2_MODULE_CONF_FILE)) {
    try {
      fs.writeFileSync(opts.PM2_MODULE_CONF_FILE, '{}');
    } catch (e) {
      console.error(e.stack || e);
    }
  }

  if (!(process.env.ZM2_PROGRAMMATIC || process.env.PM2_PROGRAMMATIC) &&
      !fs.existsSync(path.join(opts.PM2_HOME, 'touch'))) {
    try {
      var dt = fs.readFileSync(path.join(__dirname, opts.PM2_BANNER));
      console.log(dt.toString());
    } catch (e) {
      debug(e.stack || e);
    }
    try {
      fs.writeFileSync(path.join(opts.PM2_HOME, 'touch'), Date.now().toString());
    } catch(e) {
      debug(e.stack || e);
    }
  }
};

/**
 * Start the client. No daemon to launch — just verify systemd is available.
 */
SystemdClient.prototype.start = function(cb) {
  var self = this;

  if (!Systemd.isSystemd()) {
    return process.nextTick(function() {
      cb(new Error('ZM2 requires systemd. /run/systemd/system not found.'));
    });
  }

  // Must be async — CLI.js registers commander commands after calling connect(),
  // and expects the callback to fire after the event loop (not synchronously).
  process.nextTick(function() {
    cb(null, {
      daemon_mode: true,
      new_pm2_instance: false,
      rpc_socket_file: null,
      pub_socket_file: null,
      pm2_home: self.pm2_home
    });
  });
};

/**
 * Close the client. Cleanup streaming processes.
 */
SystemdClient.prototype.close = function(cb) {
  if (this._logStream) {
    this._logStream.kill();
    this._logStream = null;
  }
  if (cb) process.nextTick(cb);
};

/**
 * Map systemd ActiveState to ZM2 status string.
 */
function mapStatus(activeState, subState) {
  switch (activeState) {
    case 'active':
      return cst.ONLINE_STATUS;
    case 'inactive':
      return cst.STOPPED_STATUS;
    case 'failed':
      return cst.ERRORED_STATUS;
    case 'activating':
      return cst.LAUNCHING_STATUS;
    case 'deactivating':
      return cst.STOPPING_STATUS;
    default:
      return cst.STOPPED_STATUS;
  }
}

/**
 * Build a process info object matching the PM2 format from systemd status + state store.
 */
function buildProcessInfo(serviceName, status, storeEntry) {
  var name = storeEntry ? storeEntry.name : serviceName.replace(/^zm2-/, '');
  var pm_id = storeEntry ? storeEntry.pm_id : 0;

  return {
    pid: status.MainPID || 0,
    name: name,
    pm_id: pm_id,
    pm2_env: {
      name: name,
      namespace: (storeEntry && storeEntry.namespace) || 'default',
      status: mapStatus(status.ActiveState, status.SubState),
      pm_id: pm_id,
      pm_exec_path: (storeEntry && storeEntry.script) || '',
      pm_cwd: (storeEntry && storeEntry.cwd) || '',
      pm_uptime: parseTimestamp(status.ExecMainStartTimestamp),
      created_at: (storeEntry && storeEntry.created_at) || 0,
      restart_time: status.NRestarts || 0,
      unstable_restarts: 0,
      exec_mode: 'systemd',
      instances: (storeEntry && storeEntry.instances) || 1,
      node_args: (storeEntry && storeEntry.node_args) || [],
      args: (storeEntry && storeEntry.args) || [],
      exec_interpreter: (storeEntry && storeEntry.exec_interpreter) || 'node',
      version: (storeEntry && storeEntry.version) || 'N/A',
      node_version: process.version,
      unique_id: serviceName,
      axm_actions: [],
      axm_monitor: {},
      axm_options: {}
    },
    monit: {
      memory: status.MemoryCurrent || 0,
      cpu: 0
    }
  };
}

/**
 * Parse systemd timestamp to epoch ms.
 */
function parseTimestamp(ts) {
  if (!ts) return 0;
  var d = new Date(ts);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * Get monitor data for all zm2 services.
 * Returns array in PM2 format.
 */
SystemdClient.prototype._getMonitorData = function(cb) {
  var self = this;

  try {
    var units = Systemd.listUnits();
  } catch (e) {
    return cb(e);
  }

  // Also include services from state store that might not be listed
  var storeEntries = self.stateStore.getAll();
  var allServices = {};

  // From systemd
  units.forEach(function(u) {
    allServices[u.name] = { unit: u };
  });

  // From store (may include stopped services not listed by systemd)
  storeEntries.forEach(function(entry) {
    if (!allServices[entry.serviceName]) {
      allServices[entry.serviceName] = { unit: null };
    }
    allServices[entry.serviceName].store = entry;
  });

  var serviceNames = Object.keys(allServices);
  var results = [];
  var pids = [];
  var pidToIndex = {};

  serviceNames.forEach(function(svcName, idx) {
    var info = allServices[svcName];
    var status;

    try {
      status = Systemd.getStatus(svcName);
    } catch (e) {
      status = {
        ActiveState: 'inactive',
        SubState: 'dead',
        MainPID: 0,
        NRestarts: 0,
        MemoryCurrent: 0,
        CPUUsageNSec: 0,
        ExecMainStartTimestamp: ''
      };
    }

    var proc = buildProcessInfo(svcName, status, info.store);
    results.push(proc);

    if (status.MainPID && status.MainPID > 0) {
      pids.push(status.MainPID);
      pidToIndex[status.MainPID] = idx;
    }
  });

  // Enrich with CPU data from pidusage
  if (pids.length === 0) {
    return cb(null, results);
  }

  pidusage(pids, function(err, stats) {
    if (!err && stats) {
      Object.keys(stats).forEach(function(pid) {
        var idx = pidToIndex[parseInt(pid, 10)];
        if (idx !== undefined && stats[pid]) {
          results[idx].monit.cpu = Math.round(stats[pid].cpu * 100) / 100;
          if (stats[pid].memory) {
            results[idx].monit.memory = stats[pid].memory;
          }
        }
      });
    }
    return cb(null, results);
  });
};

/**
 * Execute a remote method — dispatch table replacing RPC calls to daemon.
 */
SystemdClient.prototype.executeRemote = function(method, app_conf, fn) {
  var self = this;

  debug('SystemdClient.executeRemote: %s', method);

  switch (method) {
    case 'prepare':
      return self._prepare(app_conf, fn);
    case 'getMonitorData':
      return self._getMonitorData(fn);
    case 'stopProcessId':
      return self._stopProcess(app_conf, fn);
    case 'restartProcessId':
      return self._restartProcess(app_conf, fn);
    case 'deleteProcessId':
      return self._deleteProcess(app_conf, fn);
    case 'reloadProcessId':
    case 'softReloadProcessId':
      return self._reloadProcess(app_conf, fn);
    case 'startProcessId':
      return self._startProcess(app_conf, fn);
    case 'ping':
      return fn(null, { msg: 'pong' });
    case 'getVersion':
      return fn(null, pkg.version);
    case 'killMe':
      return self._killAll(fn);
    case 'notifyByProcessId':
      // No-op in systemd mode
      return fn(null);
    case 'resetMetaProcessId':
      // NRestarts is managed by systemd, we can't reset it
      return fn(null);
    case 'sendSignalToProcessId':
      return self._sendSignal(app_conf, fn);
    case 'reloadLogs':
      // journald handles log rotation
      return fn(null);
    case 'getReport':
      return fn(null, self._getReport());
    case 'dumpProcessList':
      // State is already persistent
      return fn(null);
    default:
      return fn(new Error('Method ' + method + ' not supported in systemd mode'));
  }
};

/**
 * Prepare and start a new systemd service from app config.
 */
SystemdClient.prototype._prepare = function(conf, cb) {
  var self = this;

  try {
    var svcName = UnitGenerator.serviceName(conf);
    var instances = parseInt(conf.instances, 10) || 1;

    // Generate env file
    var envContent = UnitGenerator.generateEnvFile(conf);
    Systemd.writeEnvFile(svcName, envContent);

    if (instances > 1) {
      // Template unit for multi-instance
      var unitContent = UnitGenerator.generate(conf, { isTemplate: true });
      var templatePath = '/etc/systemd/system/' + svcName + '@.service';
      fs.writeFileSync(templatePath, unitContent, 'utf8');
      Systemd.daemonReload();

      for (var i = 0; i < instances; i++) {
        Systemd.start(svcName + '@' + i);
      }
    } else {
      // Single unit
      var unitContent = UnitGenerator.generate(conf);
      Systemd.installUnit(svcName, unitContent);
      Systemd.start(svcName);
    }

    // Handle cron restart
    if (conf.cron_restart) {
      var timerFiles = UnitGenerator.generateCronTimer(svcName, conf.cron_restart);
      Systemd.installTimer(svcName + '-cron', timerFiles.timer, timerFiles.service);
      Systemd._systemctl(['enable', '--now', svcName + '-cron.timer']);
    }

    // Register in state store
    var pm_id = self.stateStore.register(svcName, {
      name: conf.name || path.basename(conf.pm_exec_path || conf.script, '.js'),
      script: conf.pm_exec_path || conf.script || '',
      cwd: conf.pm_cwd || conf.cwd || process.cwd(),
      namespace: conf.namespace || 'default',
      instances: instances,
      exec_interpreter: conf.exec_interpreter || 'node',
      node_args: conf.node_args || [],
      args: conf.args || [],
      version: conf.version || 'N/A'
    });

    // Return process info in expected format
    var status = Systemd.getStatus(instances > 1 ? svcName + '@0' : svcName);
    var storeEntry = self.stateStore.get(svcName);
    var proc = buildProcessInfo(svcName, status, storeEntry);

    return cb(null, [proc]);
  } catch (e) {
    return cb(e);
  }
};

/**
 * Resolve a process id to a StateStore entry.
 * Tries pm_id first, then name, then scans systemd units as fallback.
 */
SystemdClient.prototype._resolveEntry = function(id) {
  // Try by pm_id in StateStore
  var entry = this.stateStore.getByPmId(id);
  if (entry) return entry;

  // Try by name in StateStore
  entry = this.stateStore.getByName(String(id));
  if (entry) return entry;

  // Fallback: check if a zm2-<id> unit exists directly in systemd
  var svcName = 'zm2-' + id;
  if (Systemd.unitExists(svcName)) {
    return {
      serviceName: svcName,
      name: String(id),
      pm_id: parseInt(id, 10) || 0,
      instances: 1
    };
  }

  // Last resort: scan all zm2 units and match by pm_id from _getMonitorData cache
  // This handles the case where state.json was deleted but units still exist
  try {
    var units = Systemd.listUnits();
    for (var i = 0; i < units.length; i++) {
      var unitName = units[i].name;
      // Match by index position (pm_id assigned by order)
      if (i === parseInt(id, 10)) {
        return {
          serviceName: unitName,
          name: unitName.replace(/^zm2-/, ''),
          pm_id: i,
          instances: 1
        };
      }
    }
  } catch (e) { /* ignore */ }

  return null;
};

/**
 * Stop a process by ID.
 */
SystemdClient.prototype._stopProcess = function(opts, cb) {
  try {
    var id = typeof opts === 'object' ? opts.id : opts;
    var entry = this._resolveEntry(id);
    if (!entry) return cb(new Error('Process ' + id + ' not found'));

    if (entry.instances > 1) {
      for (var i = 0; i < entry.instances; i++) {
        try { Systemd.stop(entry.serviceName + '@' + i); } catch (e) {}
      }
    } else {
      Systemd.stop(entry.serviceName);
    }

    return cb(null, { pm_id: id, status: 'stopped' });
  } catch (e) {
    return cb(e);
  }
};

/**
 * Start a stopped process by ID.
 */
SystemdClient.prototype._startProcess = function(opts, cb) {
  try {
    var id = typeof opts === 'object' ? opts.id : opts;
    var entry = this._resolveEntry(id);
    if (!entry) return cb(new Error('Process ' + id + ' not found'));

    if (entry.instances > 1) {
      for (var i = 0; i < entry.instances; i++) {
        Systemd.start(entry.serviceName + '@' + i);
      }
    } else {
      Systemd.start(entry.serviceName);
    }

    return cb(null, { pm_id: id, status: 'online' });
  } catch (e) {
    return cb(e);
  }
};

/**
 * Restart a process by ID.
 */
SystemdClient.prototype._restartProcess = function(opts, cb) {
  try {
    var id = typeof opts === 'object' ? opts.id : opts;
    var env = (typeof opts === 'object' && opts.env) ? opts.env : null;
    var entry = this._resolveEntry(id);
    if (!entry) return cb(new Error('Process ' + id + ' not found'));

    // If environment update is provided, rewrite env file
    if (env) {
      var envContent = UnitGenerator.generateEnvFile({ env: env });
      Systemd.writeEnvFile(entry.serviceName, envContent);
    }

    if (entry.instances > 1) {
      for (var i = 0; i < entry.instances; i++) {
        Systemd.restart(entry.serviceName + '@' + i);
      }
    } else {
      Systemd.restart(entry.serviceName);
    }

    // Return updated info
    var status = Systemd.getStatus(
      entry.instances > 1 ? entry.serviceName + '@0' : entry.serviceName
    );
    var proc = buildProcessInfo(entry.serviceName, status, entry);
    return cb(null, proc);
  } catch (e) {
    return cb(e);
  }
};

/**
 * Reload a process (reload-or-restart).
 */
SystemdClient.prototype._reloadProcess = function(opts, cb) {
  try {
    var id = typeof opts === 'object' ? opts.id : opts;
    var entry = this._resolveEntry(id);
    if (!entry) return cb(new Error('Process ' + id + ' not found'));

    if (entry.instances > 1) {
      // Rolling reload: one at a time
      for (var i = 0; i < entry.instances; i++) {
        Systemd.reload(entry.serviceName + '@' + i);
      }
    } else {
      Systemd.reload(entry.serviceName);
    }

    var status = Systemd.getStatus(
      entry.instances > 1 ? entry.serviceName + '@0' : entry.serviceName
    );
    var proc = buildProcessInfo(entry.serviceName, status, entry);
    return cb(null, proc);
  } catch (e) {
    return cb(e);
  }
};

/**
 * Delete a process (stop + remove unit + unregister).
 */
SystemdClient.prototype._deleteProcess = function(opts, cb) {
  try {
    var id = typeof opts === 'object' ? opts.id : opts;
    var entry = this._resolveEntry(id);
    if (!entry) return cb(new Error('Process ' + id + ' not found'));

    if (entry.instances > 1) {
      Systemd.removeTemplateUnit(entry.serviceName, entry.instances);
    } else {
      Systemd.removeUnit(entry.serviceName);
    }

    this.stateStore.unregister(entry.serviceName);
    return cb(null, { pm_id: id, status: 'deleted' });
  } catch (e) {
    return cb(e);
  }
};

/**
 * Send a signal to a process.
 */
SystemdClient.prototype._sendSignal = function(opts, cb) {
  try {
    var entry = this._resolveEntry(opts.id || opts.process_id);
    if (!entry) return cb(new Error('Process not found'));
    Systemd.sendSignal(entry.serviceName, opts.signal || 'SIGTERM');
    return cb(null);
  } catch (e) {
    return cb(e);
  }
};

/**
 * Kill all zm2 services.
 */
SystemdClient.prototype._killAll = function(cb) {
  try {
    var entries = this.stateStore.getAll();
    entries.forEach(function(entry) {
      try {
        if (entry.instances > 1) {
          for (var i = 0; i < entry.instances; i++) {
            try { Systemd.stop(entry.serviceName + '@' + i); } catch (e) {}
          }
        } else {
          Systemd.stop(entry.serviceName);
        }
      } catch (e) { /* ignore */ }
    });
    return cb(null);
  } catch (e) {
    return cb(e);
  }
};

/**
 * Get a system report.
 */
SystemdClient.prototype._getReport = function() {
  return {
    zm2_version: pkg.version,
    node_version: process.version,
    platform: process.platform,
    mode: 'systemd'
  };
};

/**
 * Notify God — no-op in systemd mode.
 */
SystemdClient.prototype.notifyGod = function(action_name, id, cb) {
  debug('notifyGod (no-op): %s %s', action_name, id);
  if (cb) cb();
};

/**
 * Kill daemon — in systemd mode, stop all services.
 */
SystemdClient.prototype.killDaemon = function(fn) {
  this._killAll(function(err) {
    if (fn) fn(null, { success: true });
  });
};

/**
 * Ping daemon — always alive in systemd mode.
 */
SystemdClient.prototype.pingDaemon = function(cb) {
  return cb(true);
};

/**
 * Launch event bus — tails journalctl for all zm2 units.
 */
SystemdClient.prototype.launchBus = function(cb) {
  var bus = new EventEmitter();
  var proc = Systemd.streamLogs(null, 0);

  proc.stdout.on('data', function(data) {
    var lines = data.toString().split('\n');
    lines.forEach(function(line) {
      if (!line.trim()) return;
      bus.emit('log:out', {
        data: line,
        process: { name: 'zm2', pm_id: 0 },
        at: Date.now()
      });
    });
  });

  proc.stderr.on('data', function(data) {
    bus.emit('log:err', {
      data: data.toString(),
      process: { name: 'zm2', pm_id: 0 },
      at: Date.now()
    });
  });

  proc.on('close', function() {
    bus.emit('close');
  });

  this._logStream = proc;
  bus.close = function() {
    proc.kill();
  };

  return cb(null, bus);
};

/**
 * Disconnect RPC — no-op.
 */
SystemdClient.prototype.disconnectRPC = function(cb) {
  if (cb) process.nextTick(cb);
};

/**
 * Disconnect bus — kill log streaming.
 */
SystemdClient.prototype.disconnectBus = function(cb) {
  if (this._logStream) {
    this._logStream.kill();
    this._logStream = null;
  }
  if (cb) process.nextTick(cb);
};

// --- Query methods that match Client.js interface ---

SystemdClient.prototype.getAllProcess = function(cb) {
  this._getMonitorData(cb);
};

SystemdClient.prototype.getAllProcessId = function(cb) {
  this._getMonitorData(function(err, procs) {
    if (err) return cb(err);
    return cb(null, procs.map(function(p) { return p.pm_id; }));
  });
};

SystemdClient.prototype.getAllProcessIdWithoutModules = function(cb) {
  // No modules in systemd mode — same as getAllProcessId
  this.getAllProcessId(cb);
};

SystemdClient.prototype.getProcessIdByName = function(name, force_all, cb) {
  if (typeof cb === 'undefined') {
    cb = force_all;
    force_all = false;
  }

  if (typeof name === 'number') name = name.toString();

  this._getMonitorData(function(err, list) {
    if (err) return cb(err);

    var found_proc = [];
    var full_details = {};

    list.forEach(function(proc) {
      if (proc.pm2_env.name === name || proc.pm2_env.pm_exec_path === path.resolve(name)) {
        found_proc.push(proc.pm_id);
        full_details[proc.pm_id] = proc;
      }
    });

    return cb(null, found_proc, full_details);
  });
};

SystemdClient.prototype.getProcessIdsByNamespace = function(namespace, force_all, cb) {
  if (typeof cb === 'undefined') {
    cb = force_all;
    force_all = false;
  }

  this._getMonitorData(function(err, list) {
    if (err) return cb(err);

    var found_proc = [];
    var full_details = {};

    list.forEach(function(proc) {
      if (proc.pm2_env.namespace === namespace) {
        found_proc.push(proc.pm_id);
        full_details[proc.pm_id] = proc;
      }
    });

    return cb(null, found_proc, full_details);
  });
};

SystemdClient.prototype.getProcessByName = function(name, cb) {
  this._getMonitorData(function(err, list) {
    if (err) return cb(err);

    var found = list.filter(function(proc) {
      return proc.pm2_env.name === name || proc.pm2_env.pm_exec_path === path.resolve(name);
    });

    return cb(null, found);
  });
};

SystemdClient.prototype.getProcessByNameOrId = function(nameOrId, cb) {
  this._getMonitorData(function(err, list) {
    if (err) return cb(err);

    var found = list.filter(function(proc) {
      return proc.pm2_env.name === nameOrId ||
        proc.pm2_env.pm_exec_path === path.resolve(nameOrId) ||
        proc.pid === parseInt(nameOrId) ||
        proc.pm2_env.pm_id === parseInt(nameOrId);
    });

    return cb(null, found);
  });
};

// Watch methods — no-op in systemd mode
SystemdClient.prototype.toggleWatch = function(method, env, fn) { if (fn) fn(); };
SystemdClient.prototype.startWatch = function(method, env, fn) { if (fn) fn(); };
SystemdClient.prototype.stopWatch = function(method, env, fn) { if (fn) fn(); };
