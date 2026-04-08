/**
 * Copyright 2024 the ZM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

'use strict';

var fs             = require('fs');
var path           = require('path');
var chalk          = require('ansis');
var execFileSync   = require('child_process').execFileSync;

var Common         = require('../Common.js');
var cst            = require('../../constants.js');
var Systemd        = require('../Systemd.js');
var UnitGenerator  = require('../Systemd/UnitGenerator.js');
var StateStore     = require('../Systemd/StateStore.js');

/**
 * Possible PM2 home locations to search for dump files.
 */
var PM2_HOMES = [
  process.env.PM2_HOME,
  path.join(process.env.HOME || '/root', '.pm2')
].filter(Boolean);

/**
 * Try to get PM2 process list from a running PM2 daemon via `pm2 jlist`.
 *
 * @returns {Array|null} Array of process objects, or null if PM2 is not running
 */
function getPm2RunningProcesses() {
  try {
    var output = execFileSync('pm2', ['jlist'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // pm2 jlist may output extra lines before the JSON
    var jsonStart = output.indexOf('[');
    if (jsonStart === -1) return null;
    var list = JSON.parse(output.substring(jsonStart));
    return list;
  } catch (e) {
    return null;
  }
}

/**
 * Try to read PM2 dump file from known locations.
 *
 * @returns {Object} { source: string, processes: Array }
 */
function readPm2DumpFile() {
  var dumpNames = ['dump.pm2', 'dump.pm2.bak'];

  for (var i = 0; i < PM2_HOMES.length; i++) {
    for (var j = 0; j < dumpNames.length; j++) {
      var dumpPath = path.join(PM2_HOMES[i], dumpNames[j]);
      try {
        if (fs.existsSync(dumpPath)) {
          var raw = fs.readFileSync(dumpPath, 'utf8');
          var data = JSON.parse(raw);
          if (Array.isArray(data) && data.length > 0) {
            return { source: dumpPath, processes: data };
          }
        }
      } catch (e) { /* continue */ }
    }
  }

  return null;
}

/**
 * Normalize a PM2 process entry (from jlist or dump file) into a config
 * that UnitGenerator can consume.
 *
 * @param {Object} proc - PM2 process object
 * @returns {Object} Normalized app config
 */
function normalizeConfig(proc) {
  // pm2 jlist wraps config in pm2_env, dump file stores it directly
  var env = proc.pm2_env || proc;

  var conf = {
    name: env.name,
    pm_exec_path: env.pm_exec_path || env.script,
    script: env.pm_exec_path || env.script,
    pm_cwd: env.pm_cwd || env.cwd || process.cwd(),
    cwd: env.pm_cwd || env.cwd || process.cwd(),
    exec_interpreter: env.exec_interpreter || 'node',
    node_args: env.node_args || [],
    args: env.args || [],
    instances: 1, // systemd doesn't use cluster, default to 1
    autorestart: env.autorestart !== false,
    restart_delay: env.restart_delay || null,
    max_restarts: env.max_restarts || null,
    min_uptime: env.min_uptime || null,
    kill_timeout: env.kill_timeout || null,
    kill_signal: env.kill_signal || null,
    max_memory_restart: env.max_memory_restart || null,
    stop_exit_codes: env.stop_exit_codes || null,
    listen_timeout: env.listen_timeout || null,
    cron_restart: env.cron_restart || null,
    namespace: env.namespace || 'default',
    env: {},
    user: env.user || env.uid || null,
    gid: env.gid || null,
    version: env.version || 'N/A',
    source_map_support: env.source_map_support
  };

  // Extract environment variables, excluding PM2 internals
  var srcEnv = env.env || {};
  Object.keys(srcEnv).forEach(function(key) {
    // Skip PM2/ZM2 internal env vars
    if (key.indexOf('pm_') === 0) return;
    if (key.indexOf('pm2_') === 0) return;
    if (key.indexOf('PM2_') === 0) return;
    if (key.indexOf('ZM2_') === 0) return;
    if (key === 'INSTANCE_NAME') return;
    if (key === 'unique_id') return;
    conf.env[key] = srcEnv[key];
  });

  // If original had cluster mode with multiple instances, note it
  if (env.exec_mode === 'cluster_mode' && env.instances && env.instances > 1) {
    conf.instances = parseInt(env.instances, 10);
  }

  // PM2 abuse: some apps store env vars (e.g. CUDA_VISIBLE_DEVICES=1) in
  // pm_err_log_path instead of the env object. Detect and extract them.
  var errLogPath = env.pm_err_log_path || env.error_file || '';
  if (/^[A-Z_][A-Z0-9_]*=/.test(errLogPath)) {
    errLogPath.split(/\s+/).forEach(function(token) {
      var eq = token.indexOf('=');
      if (eq > 0) {
        var k = token.substring(0, eq);
        var v = token.substring(eq + 1);
        if (/^[A-Z_][A-Z0-9_]*$/.test(k)) {
          conf.env[k] = v;
        }
      }
    });
  }

  return conf;
}

module.exports = function(CLI) {

  /**
   * Migrate processes from PM2 to ZM2 (systemd).
   *
   * Sources (tried in order):
   * 1. Running PM2 daemon (via `pm2 jlist`)
   * 2. PM2 dump file (~/.pm2/dump.pm2)
   *
   * @param {String} appName - App name to migrate, or 'all' for everything
   * @param {Object} opts - Commander options
   * @param {Function} cb
   */
  CLI.prototype.migrate = function(appName, opts, cb) {
    var that = this;

    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }

    if (!cb) {
      cb = function(err) {
        if (err) {
          Common.printError(cst.PREFIX_MSG_ERR + err.message);
          return that.exitCli(cst.ERROR_EXIT);
        }
        return that.exitCli(cst.SUCCESS_EXIT);
      };
    }

    if (!Systemd.isSystemd()) {
      return cb(new Error('ZM2 requires systemd. /run/systemd/system not found.'));
    }

    if (process.getuid && process.getuid() !== 0) {
      Common.printOut(cst.PREFIX_MSG + 'Migration requires root to create systemd units.');
      console.log('sudo zm2 migrate ' + (appName || 'all'));
      return cb(new Error('Requires root'));
    }

    // --- Collect PM2 processes ---
    Common.printOut(cst.PREFIX_MSG + 'Looking for PM2 processes to migrate...');

    var processes = null;
    var source = '';

    // Try running PM2 first
    var runningProcs = getPm2RunningProcesses();
    if (runningProcs && runningProcs.length > 0) {
      processes = runningProcs;
      source = 'running PM2 daemon';
    }

    // Fallback to dump file
    if (!processes) {
      var dumpResult = readPm2DumpFile();
      if (dumpResult) {
        processes = dumpResult.processes;
        source = dumpResult.source;
      }
    }

    if (!processes || processes.length === 0) {
      Common.printError(cst.PREFIX_MSG_ERR + 'No PM2 processes found.');
      Common.printOut(cst.PREFIX_MSG + 'Checked: running PM2 daemon, dump files in ' + PM2_HOMES.join(', '));
      return cb(new Error('No PM2 processes found'));
    }

    Common.printOut(cst.PREFIX_MSG + 'Found ' + processes.length + ' process(es) from ' + source);

    // --- Filter by app name ---
    if (appName && appName !== 'all') {
      processes = processes.filter(function(proc) {
        var env = proc.pm2_env || proc;
        return env.name === appName;
      });

      if (processes.length === 0) {
        return cb(new Error('No PM2 process found with name "' + appName + '"'));
      }
    }

    // Skip modules
    processes = processes.filter(function(proc) {
      var env = proc.pm2_env || proc;
      return !env.pmx_module;
    });

    var dryRun = opts && opts.dryRun;

    if (dryRun) {
      Common.printOut(cst.PREFIX_MSG + chalk.yellow('DRY RUN — no changes will be made'));
    }

    // --- Migrate each process ---
    var statePath = path.join(that._conf.PM2_ROOT_PATH, 'state.json');
    var store = new StateStore(statePath);
    store.load();

    var migrated = 0;
    var skipped = 0;
    var errors = 0;

    processes.forEach(function(proc) {
      var conf = normalizeConfig(proc);
      var svcName = UnitGenerator.serviceName(conf);

      // Check if already migrated
      if (store.get(svcName)) {
        Common.printOut(cst.PREFIX_MSG_WARNING + chalk.yellow(conf.name) + ' already exists as ' + svcName + ' — skipping');
        skipped++;
        return;
      }

      // Dry run: just show what would happen
      if (dryRun) {
        var instanceStr = conf.instances > 1 ? ' (' + conf.instances + ' instances)' : '';
        Common.printOut(cst.PREFIX_MSG + chalk.dim('[dry-run] ') + chalk.bold(conf.name) + ' → ' + svcName + instanceStr);
        Common.printOut(cst.PREFIX_MSG + chalk.dim('  script: ' + (conf.pm_exec_path || conf.script)));
        Common.printOut(cst.PREFIX_MSG + chalk.dim('  cwd: ' + (conf.pm_cwd || conf.cwd)));
        Common.printOut(cst.PREFIX_MSG + chalk.dim('  interpreter: ' + conf.exec_interpreter));
        migrated++;
        return;
      }

      try {
        // Generate and install unit file
        var unitContent;
        if (conf.instances > 1) {
          unitContent = UnitGenerator.generate(conf, { isTemplate: true });
          var templatePath = '/etc/systemd/system/' + svcName + '@.service';
          fs.writeFileSync(templatePath, unitContent, 'utf8');
        } else {
          unitContent = UnitGenerator.generate(conf);
          Systemd.installUnit(svcName, unitContent);
        }

        // Generate env file
        var envContent = UnitGenerator.generateEnvFile(conf);
        Systemd.writeEnvFile(svcName, envContent);

        // Handle cron restart
        if (conf.cron_restart) {
          var timerFiles = UnitGenerator.generateCronTimer(svcName, conf.cron_restart);
          Systemd.installTimer(svcName + '-cron', timerFiles.timer, timerFiles.service);
          try {
            Systemd._systemctl(['enable', '--now', svcName + '-cron.timer']);
          } catch (e) { /* non-fatal */ }
        }

        // Register in state store
        store.register(svcName, {
          name: conf.name,
          script: conf.pm_exec_path || conf.script,
          cwd: conf.pm_cwd || conf.cwd,
          namespace: conf.namespace || 'default',
          instances: conf.instances,
          exec_interpreter: conf.exec_interpreter || 'node',
          node_args: conf.node_args || [],
          args: conf.args || [],
          version: conf.version || 'N/A',
          migrated_from: 'pm2',
          migrated_at: Date.now()
        });

        // Stop the PM2 process first to free ports/resources
        try {
          execFileSync('pm2', ['stop', conf.name], {
            encoding: 'utf8',
            timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe']
          });
        } catch (e) {
          // Non-fatal: PM2 process may already be stopped or PM2 not running
        }

        // Start the service
        if (conf.instances > 1) {
          Systemd.daemonReload();
          for (var i = 0; i < conf.instances; i++) {
            Systemd.start(svcName + '@' + i);
          }
        } else {
          Systemd.start(svcName);
        }

        var instanceStr = conf.instances > 1 ? ' (' + conf.instances + ' instances)' : '';
        Common.printOut(cst.PREFIX_MSG + chalk.green('[v] ') + chalk.bold(conf.name) + ' → ' + svcName + instanceStr);
        migrated++;
      } catch (e) {
        Common.printError(cst.PREFIX_MSG_ERR + 'Failed to migrate ' + conf.name + ': ' + e.message);
        errors++;
      }
    });

    // --- Summary ---
    console.log('');
    Common.printOut(cst.PREFIX_MSG + '--- Migration Summary ---');
    if (dryRun) {
      Common.printOut(cst.PREFIX_MSG + chalk.yellow(migrated + ' would be migrated'));
      if (skipped > 0)
        Common.printOut(cst.PREFIX_MSG + chalk.yellow(skipped + ' would be skipped (already exist)'));
      console.log('');
      Common.printOut(cst.PREFIX_MSG + 'Run without --dry-run to apply: ' + chalk.bold('sudo zm2 migrate ' + (appName || 'all')));
    } else {
      Common.printOut(cst.PREFIX_MSG + chalk.green(migrated + ' migrated'));
      if (skipped > 0)
        Common.printOut(cst.PREFIX_MSG + chalk.yellow(skipped + ' skipped (already exist)'));
      if (errors > 0)
        Common.printOut(cst.PREFIX_MSG + chalk.red(errors + ' failed'));

      if (migrated > 0) {
        console.log('');
        Common.printOut(cst.PREFIX_MSG + 'Verify with: ' + chalk.bold('zm2 list'));
        Common.printOut(cst.PREFIX_MSG + 'Enable on boot: ' + chalk.bold('sudo zm2 startup'));
        console.log('');
        Common.printOut(cst.PREFIX_MSG + chalk.dim('To stop PM2 after migration:'));
        Common.printOut(cst.PREFIX_MSG + chalk.dim('  pm2 kill'));
        Common.printOut(cst.PREFIX_MSG + chalk.dim('  pm2 unstartup'));
      }
    }

    return cb(null);
  };
};
