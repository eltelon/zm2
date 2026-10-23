/**
 * Copyright 2024 the ZM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var DEFAULT_UNIT_DIR = '/etc/systemd/system';
var DEFAULT_ENV_DIR = '/etc/zm2/env';
var DEFAULT_PROCESS_TIMEOUT = 10 * 1000;
var DEFAULT_PROCESS_MAX_BUFFER = 1024 * 1024;
var EXACT_VERSION_PATTERN = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)';
var EXACT_VERSION_RE = new RegExp('^v?' + EXACT_VERSION_PATTERN + '$');
var NODE_VERSION_INTERPRETER_RE = new RegExp('^node@v?' + EXACT_VERSION_PATTERN + '$');

function defaultRun(command, args, options) {
  return new Promise(function(resolve) {
    childProcess.execFile(command, args, options, function(error, stdout, stderr) {
      var code = 0;

      if (error) {
        code = typeof error.code === 'number' ? error.code : 1;
      }

      resolve({
        code: code,
        stdout: stdout || '',
        stderr: stderr || '',
        error: error || null
      });
    });
  });
}

function accessMode(fsModule, name, fallback) {
  if (fsModule && fsModule.constants && typeof fsModule.constants[name] === 'number') {
    return fsModule.constants[name];
  }
  return fallback;
}

function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message.length > 0) {
    return error.message;
  }
  if (error === undefined || error === null) {
    return 'Unknown update-node error';
  }
  return String(error);
}

function clonePlain(value) {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function interpreterFor(entry) {
  var interpreter = entry && entry.exec_interpreter;
  if (interpreter === undefined || interpreter === null || interpreter === '') {
    return 'node';
  }
  return interpreter;
}

function isNodeExecutablePath(executable) {
  if (typeof executable !== 'string' || executable.length === 0) return false;
  var basename = path.basename(executable);
  return basename === 'node' || basename === 'nodejs';
}

function createReport(version) {
  return {
    requestedVersion: typeof version === 'string' ? version : String(version),
    runtime: null,
    globalError: null,
    results: [],
    totals: {
      updated: 0,
      skipped: 0,
      failed: 0,
      notUpdated: 0
    },
    exitCode: 0
  };
}

function createRow(entry, serviceName) {
  var name = entry && entry.name
    ? String(entry.name)
    : String(serviceName || '').replace(/^zm2-/, '');

  return {
    serviceName: serviceName || '',
    name: name,
    previousVersion: null,
    status: 'not_updated',
    stopped: false,
    startupVerified: false,
    reason: null,
    errors: [],
    rollbackErrors: []
  };
}

function finalizeReport(report) {
  var totals = {
    updated: 0,
    skipped: 0,
    failed: 0,
    notUpdated: 0
  };

  report.results.forEach(function(row) {
    switch (row.status) {
      case 'updated':
        totals.updated += 1;
        break;
      case 'skipped':
        totals.skipped += 1;
        break;
      case 'failed_unchanged':
      case 'failed_restored':
      case 'failed_restore':
      case 'failed_no_rollback':
        totals.failed += 1;
        break;
      case 'not_updated':
        totals.notUpdated += 1;
        break;
      default:
        totals.failed += 1;
        break;
    }
  });

  report.totals = totals;
  report.globalError = report.globalError ? String(report.globalError) : null;
  report.exitCode = report.globalError || totals.failed > 0 || totals.notUpdated > 0 ? 1 : 0;

  return report;
}

/**
 * NodeRuntimeUpdater - Coordinate a Node runtime update across registered ZM2
 * applications. The updater owns preflight, selection, sequencing and the
 * per-application transaction. It never regenerates systemd units from
 * StateStore metadata.
 *
 * Constructor options:
 *   stateStore       StateStore instance. Defaults to <pm2Home>/state.json.
 *   pm2Home          Resolved ZM2 home. Required under sudo when it cannot be
 *                    proven that the sudo origin is the effective user.
 *   pm2HomeExplicit  Optional provenance flag for pm2Home. When omitted, a
 *                    supplied pm2Home is treated as explicit for backwards
 *                    compatibility. API adapters must pass the real flag so a
 *                    guessed/default home is never mistaken for an explicit one.
 *   systemd          Systemd-compatible adapter.
 *   nvm              Nvm-compatible adapter.
 *   runtimeConfig    RuntimeConfig-compatible adapter.
 *   verifier         RuntimeVerifier-compatible adapter.
 *   rollback         Revert startup failures unless explicitly false (default true).
 *   fs               Filesystem module used by preflight.
 *   env              Environment used for nvm/home selection.
 *   platform         Process platform, defaults to process.platform.
 *   isSystemd        Boolean or function overriding systemd detection.
 *   unitDir          Managed systemd unit directory.
 *   envDir           Managed ZM2 environment directory.
 *   run              Process runner for "<old executable> --version".
 *   processTimeout   Old-version query timeout.
 *   processMaxBuffer Old-version query output limit.
 *   sudoUser         Override SUDO_USER for tests.
 *   effectiveUser    Override the effective user name for tests.
 *
 * run(version) always resolves with an UpdateNodeReport. Operational errors
 * become report rows or report.globalError.
 */
function NodeRuntimeUpdater(options) {
  options = options || {};

  this.fs = options.fs || fs;
  this.env = options.env || process.env;
  this.platform = options.platform || process.platform;
  this.stateStore = options.stateStore || null;
  this.systemd = options.systemd || null;
  this.nvm = options.nvm || null;
  this.runtimeConfig = options.runtimeConfig || null;
  this.verifier = options.verifier || null;
  this.rollbackEnabled = options.rollback !== false;
  this.runProcess = options.run || defaultRun;
  this.processTimeout = options.processTimeout === undefined
    ? DEFAULT_PROCESS_TIMEOUT
    : options.processTimeout;
  this.processMaxBuffer = options.processMaxBuffer === undefined
    ? DEFAULT_PROCESS_MAX_BUFFER
    : options.processMaxBuffer;
  this.explicitUnitDir = typeof options.unitDir === 'string' && options.unitDir;
  this.explicitEnvDir = typeof options.envDir === 'string' && options.envDir;
  this.unitDir = this.explicitUnitDir ? options.unitDir : DEFAULT_UNIT_DIR;
  this.envDir = this.explicitEnvDir ? options.envDir : DEFAULT_ENV_DIR;
  this.pm2HomeOption = typeof options.pm2Home === 'string' && options.pm2Home.length > 0
    ? options.pm2Home
    : null;
  this.pm2HomeExplicit = typeof options.pm2HomeExplicit === 'boolean'
    ? options.pm2HomeExplicit
    : this.pm2HomeOption !== null;
  this.sudoUserOption = options.sudoUser;
  this.effectiveUserOption = options.effectiveUser;
  this.isSystemdOption = options.isSystemd;
}

NodeRuntimeUpdater.prototype._getSystemd = function() {
  if (!this.systemd) {
    this.systemd = require('../Systemd');
  }
  return this.systemd;
};

NodeRuntimeUpdater.prototype._getNvm = function() {
  if (!this.nvm) {
    var Nvm = require('../tools/Nvm');
    this.nvm = new Nvm({ env: this.env });
  }
  return this.nvm;
};

NodeRuntimeUpdater.prototype._getRuntimeConfig = function() {
  if (!this.runtimeConfig) {
    var RuntimeConfig = require('./RuntimeConfig');
    this.runtimeConfig = new RuntimeConfig({
      systemd: this._getSystemd(),
      unitDir: this.unitDir,
      envDir: this.envDir,
      fs: this.fs
    });
  }
  return this.runtimeConfig;
};

NodeRuntimeUpdater.prototype._getVerifier = function() {
  if (!this.verifier) {
    var RuntimeVerifier = require('./RuntimeVerifier');
    this.verifier = new RuntimeVerifier({
      systemd: this._getSystemd(),
      fs: this.fs
    });
  }
  return this.verifier;
};

NodeRuntimeUpdater.prototype._getStateStore = function() {
  if (!this.stateStore) {
    var StateStore = require('./StateStore');
    this.stateStore = new StateStore(path.join(this._pm2Home(), 'state.json'));
  }
  return this.stateStore;
};

NodeRuntimeUpdater.prototype._pm2Home = function() {
  if (this.pm2HomeOption) return this.pm2HomeOption;
  if (typeof this.env.ZM2_HOME === 'string' && this.env.ZM2_HOME) return this.env.ZM2_HOME;
  if (typeof this.env.PM2_HOME === 'string' && this.env.PM2_HOME) return this.env.PM2_HOME;
  if (typeof this.env.HOME === 'string' && this.env.HOME) {
    return path.resolve(this.env.HOME, '.zm2');
  }

  try {
    return path.resolve(os.homedir(), '.zm2');
  } catch (error) {
    return path.resolve('/etc', '.zm2');
  }
};

NodeRuntimeUpdater.prototype._effectiveUser = function() {
  if (this.effectiveUserOption !== undefined) return this.effectiveUserOption;

  try {
    return os.userInfo().username;
  } catch (error) {
    return null;
  }
};

NodeRuntimeUpdater.prototype._assertSudoContext = function() {
  var sudoUser = this.sudoUserOption !== undefined
    ? this.sudoUserOption
    : this.env.SUDO_USER;

  if (!sudoUser) return;

  var effectiveUser = this._effectiveUser();
  if (effectiveUser && String(sudoUser) === String(effectiveUser)) return;

  var explicitEnvHome =
    (typeof this.env.ZM2_HOME === 'string' && this.env.ZM2_HOME.length > 0) ||
    (typeof this.env.PM2_HOME === 'string' && this.env.PM2_HOME.length > 0);
  var missing = [];

  if (!this.env.NVM_DIR) missing.push('NVM_DIR');
  if (!this.pm2HomeExplicit && !explicitEnvHome) {
    missing.push('ZM2_HOME or PM2_HOME (or an explicitly selected pm2Home)');
  }

  if (missing.length > 0) {
    throw new Error(
      'Refusing to guess a user home under sudo: set ' + missing.join(' and ') +
      ' explicitly before updating Node runtimes'
    );
  }
};

NodeRuntimeUpdater.prototype._isSystemd = function() {
  if (this.isSystemdOption !== undefined) {
    if (typeof this.isSystemdOption === 'function') {
      return !!this.isSystemdOption();
    }
    return !!this.isSystemdOption;
  }

  var systemd = this._getSystemd();
  if (systemd && typeof systemd.isSystemd === 'function') {
    try {
      return !!systemd.isSystemd();
    } catch (error) {
      return false;
    }
  }

  return true;
};

NodeRuntimeUpdater.prototype._resolveNvmDir = function() {
  var nvmDir = this.env.NVM_DIR;

  if (nvmDir !== undefined && nvmDir !== null && nvmDir !== '') {
    if (typeof nvmDir !== 'string') {
      throw new Error('NVM_DIR must be a string');
    }
    return path.resolve(nvmDir);
  }

  var home = this.env.HOME;
  if (home !== undefined && home !== null && home !== '') {
    if (typeof home !== 'string') {
      throw new Error('HOME must be a string');
    }
    return path.resolve(home, '.nvm');
  }

  throw new Error('Cannot locate nvm: set NVM_DIR or HOME');
};

NodeRuntimeUpdater.prototype._assertDirectoryAccess = function(dir, label, nvmDirectory) {
  var stat;

  try {
    stat = this.fs.statSync(dir);
  } catch (error) {
    throw new Error(label + ' is missing or not accessible: ' + dir);
  }

  if (!stat || typeof stat.isDirectory !== 'function' || !stat.isDirectory()) {
    throw new Error(label + ' is not a directory: ' + dir);
  }

  var mode = accessMode(this.fs, 'W_OK', 2);
  if (nvmDirectory) {
    mode |= accessMode(this.fs, 'R_OK', 4);
  }

  try {
    this.fs.accessSync(dir, mode);
  } catch (error) {
    throw new Error(label + ' is not writable: ' + dir);
  }
};

NodeRuntimeUpdater.prototype._assertNvmAccess = function() {
  var nvmDir = this._resolveNvmDir();
  this._assertDirectoryAccess(nvmDir, 'nvm directory', true);

  var nvmSh = path.join(nvmDir, 'nvm.sh');
  var stat;

  try {
    stat = this.fs.statSync(nvmSh);
  } catch (error) {
    throw new Error('nvm.sh is missing or not readable: ' + nvmSh);
  }

  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
    throw new Error('nvm.sh is not a regular file: ' + nvmSh);
  }

  try {
    this.fs.accessSync(nvmSh, accessMode(this.fs, 'R_OK', 4));
  } catch (error) {
    throw new Error('nvm.sh is not readable: ' + nvmSh);
  }
};

NodeRuntimeUpdater.prototype._stateFilePath = function() {
  var store = this._getStateStore();

  if (store && typeof store.filePath === 'string' && store.filePath) {
    return store.filePath;
  }

  return path.join(this._pm2Home(), 'state.json');
};

NodeRuntimeUpdater.prototype._managedDirs = function() {
  var unitDir = this.unitDir;
  var envDir = this.envDir;

  if (!this.explicitUnitDir && this.runtimeConfig &&
      typeof this.runtimeConfig.unitDir === 'string' && this.runtimeConfig.unitDir) {
    unitDir = this.runtimeConfig.unitDir;
  }
  if (!this.explicitEnvDir && this.runtimeConfig &&
      typeof this.runtimeConfig.envDir === 'string' && this.runtimeConfig.envDir) {
    envDir = this.runtimeConfig.envDir;
  }

  return { unitDir: unitDir, envDir: envDir };
};

NodeRuntimeUpdater.prototype._preflightResources = function() {
  var dirs = this._managedDirs();

  this._assertDirectoryAccess(
    path.dirname(this._stateFilePath()),
    'StateStore directory',
    false
  );
  this._assertDirectoryAccess(dirs.unitDir, 'systemd unit directory', false);
  this._assertDirectoryAccess(dirs.envDir, 'ZM2 environment directory', false);
  this._assertNvmAccess();
};

NodeRuntimeUpdater.prototype._classify = function(entry) {
  if (Number(entry.pm_id) === 0 &&
      typeof entry.script === 'string' &&
      path.basename(entry.script) === 'HttpApiServer.js') {
    return {
      eligible: false,
      reason: 'internal ZM2 HTTP API service'
    };
  }

  var interpreter = interpreterFor(entry);

  if (typeof interpreter !== 'string') {
    return {
      eligible: false,
      reason: 'interpreter is not Node: ' + String(interpreter)
    };
  }

  if (interpreter === 'none') {
    return {
      eligible: false,
      reason: 'interpreter is not Node (none)'
    };
  }

  if (interpreter === 'node') {
    return { eligible: true };
  }

  if (interpreter.indexOf('node@') === 0) {
    return { eligible: true };
  }

  if (interpreter.indexOf('/') !== -1 && isNodeExecutablePath(interpreter)) {
    return { eligible: true };
  }

  return {
    eligible: false,
    reason: 'interpreter is not Node: ' + interpreter
  };
};

NodeRuntimeUpdater.prototype._assertMetadataMatches = function(entry, previousExecutable) {
  var interpreter = interpreterFor(entry);
  if (typeof interpreter !== 'string' || interpreter.indexOf('/') === -1) {
    return;
  }

  var expected;

  if (path.isAbsolute(interpreter)) {
    expected = path.normalize(interpreter);
  } else {
    var cwd = entry.pm_cwd || entry.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error(
        'Cannot verify relative interpreter "' + interpreter + '" without a cwd'
      );
    }
    expected = path.resolve(cwd, interpreter);
  }

  if (expected !== path.normalize(previousExecutable)) {
    throw new Error(
      'Metadata interpreter ' + interpreter +
      ' does not match unit ExecStart ' + previousExecutable
    );
  }
};

NodeRuntimeUpdater.prototype._assertVersionMatches = function(entry, previousVersion) {
  var interpreter = interpreterFor(entry);
  if (typeof interpreter !== 'string' || previousVersion === null) return;

  var match = NODE_VERSION_INTERPRETER_RE.exec(interpreter);
  if (!match) return;

  var expectedVersion = match[1] + '.' + match[2] + '.' + match[3];
  if (expectedVersion !== previousVersion) {
    throw new Error(
      'Metadata interpreter ' + interpreter +
      ' does not match the configured executable version ' + previousVersion
    );
  }
};

NodeRuntimeUpdater.prototype._readInstances = async function(entry) {
  var raw = entry.instances;
  var count = raw === undefined || raw === null ? 1 : Number(raw);

  if (!Number.isInteger(count) || count < 1) {
    throw new Error('Invalid instance count: ' + String(raw));
  }

  var instances = [];
  var systemd = this._getSystemd();

  for (var index = 0; index < count; index += 1) {
    var instanceName = count > 1
      ? entry.serviceName + '@' + index
      : entry.serviceName;
    var status;

    try {
      status = await systemd.getStatus(instanceName);
    } catch (error) {
      throw new Error(
        'instance ' + instanceName + ': unable to query systemd status: ' +
        errorMessage(error)
      );
    }

    if (!status || typeof status !== 'object') {
      throw new Error('instance ' + instanceName + ': systemd status is missing');
    }

    var active;

    if (status.ActiveState === 'active' && status.SubState === 'running') {
      active = true;
    } else if (status.ActiveState === 'inactive' && status.SubState === 'dead') {
      active = false;
    } else {
      throw new Error(
        'instance ' + instanceName + ' is in a transitional or failed state (' +
        String(status.ActiveState) + '/' + String(status.SubState) + ')'
      );
    }

    instances.push({
      name: instanceName,
      active: active,
      status: status
    });
  }

  return instances;
};

NodeRuntimeUpdater.prototype._assertPreviousExecutable = function(executable) {
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new Error('Previous Node executable is missing');
  }
  if (!path.isAbsolute(executable)) {
    throw new Error('Previous Node executable must be an absolute path: ' + executable);
  }

  var stat;

  try {
    stat = this.fs.statSync(executable);
  } catch (error) {
    throw new Error('Previous Node executable is missing: ' + executable);
  }

  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
    throw new Error('Previous Node executable is not a regular file: ' + executable);
  }

  try {
    this.fs.accessSync(executable, accessMode(this.fs, 'X_OK', 1));
  } catch (error) {
    throw new Error('Previous Node executable is not executable: ' + executable);
  }
};

NodeRuntimeUpdater.prototype._readPreviousVersion = async function(executable) {
  this._assertPreviousExecutable(executable);

  var result;

  try {
    result = await this.runProcess(executable, ['--version'], {
      encoding: 'utf8',
      timeout: this.processTimeout,
      maxBuffer: this.processMaxBuffer,
      shell: false
    });
  } catch (error) {
    return null;
  }

  if (!result || typeof result !== 'object') return null;

  var code = result.code;
  if (code === undefined) code = result.status;
  if (code === undefined) code = result.error ? 1 : 0;
  if (code !== 0 && code !== '0') return null;

  var stdout = result.stdout === undefined || result.stdout === null
    ? ''
    : String(result.stdout);
  var firstLine = stdout.trim().split(/\r?\n/)[0];
  var match = EXACT_VERSION_RE.exec(firstLine);

  return match ? match[1] + '.' + match[2] + '.' + match[3] : null;
};

NodeRuntimeUpdater.prototype._inspectEntry = async function(entry, row) {
  try {
    var snapshot = await this._getRuntimeConfig().inspect(entry);

    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('Runtime configuration snapshot is invalid');
    }

    var previousExecutable = snapshot.previousExecutable;
    if (typeof previousExecutable !== 'string' || previousExecutable.length === 0) {
      throw new Error('Runtime configuration snapshot has no previous executable');
    }
    if (!path.isAbsolute(previousExecutable)) {
      throw new Error('Unit ExecStart executable is not absolute: ' + previousExecutable);
    }
    if (!isNodeExecutablePath(previousExecutable)) {
      throw new Error(
        'Unit ExecStart executable is not a Node executable: ' + previousExecutable
      );
    }

    this._assertMetadataMatches(entry, previousExecutable);

    var instances = await this._readInstances(entry);
    row.stopped = instances.every(function(instance) {
      return !instance.active;
    });

    var previousVersion = await this._readPreviousVersion(previousExecutable);
    row.previousVersion = previousVersion;
    this._assertVersionMatches(entry, previousVersion);

    return {
      entry: entry,
      row: row,
      snapshot: snapshot,
      instances: instances,
      previousVersion: previousVersion
    };
  } catch (error) {
    this._failRow(row, 'failed_unchanged', error);
    return null;
  }
};

NodeRuntimeUpdater.prototype._failRow = function(row, status, error) {
  var message = errorMessage(error);

  row.status = status;
  row.reason = message;
  row.errors.push(message);
  row.startupVerified = false;
};

NodeRuntimeUpdater.prototype._markNotUpdated = function(prepared, reason) {
  prepared.forEach(function(context) {
    context.row.status = 'not_updated';
    context.row.reason = reason;
    context.row.startupVerified = false;
  });
};

NodeRuntimeUpdater.prototype._validateRuntime = function(runtime, requestedVersion) {
  if (!runtime || typeof runtime !== 'object') {
    throw new Error('nvm returned an invalid runtime');
  }
  if (typeof runtime.version !== 'string' ||
      typeof runtime.executable !== 'string' ||
      typeof runtime.binDir !== 'string') {
    throw new Error('nvm returned an incomplete runtime');
  }
  if (runtime.version !== requestedVersion) {
    throw new Error(
      'nvm prepared Node ' + runtime.version +
      ' instead of the requested version ' + requestedVersion
    );
  }
  if (!path.isAbsolute(runtime.executable)) {
    throw new Error('Prepared Node executable must be absolute: ' + runtime.executable);
  }
  if (!path.isAbsolute(runtime.binDir)) {
    throw new Error('Prepared Node binDir must be absolute: ' + runtime.binDir);
  }

  return runtime;
};

NodeRuntimeUpdater.prototype._metadataIsCurrent = function(entry, runtime) {
  return entry.exec_interpreter === runtime.executable;
};

NodeRuntimeUpdater.prototype._rememberRollback = function(context, configurationChanged) {
  var store = this._getStateStore();
  var metadata = store.get(context.entry.serviceName);

  if (!metadata || typeof metadata !== 'object') {
    throw new Error('Cannot snapshot metadata for ' + context.entry.serviceName);
  }

  return {
    serviceName: context.entry.serviceName,
    metadata: clonePlain(metadata),
    snapshot: context.snapshot,
    instances: context.instances.map(function(instance) {
      return {
        name: instance.name,
        active: instance.active,
        status: instance.status
      };
    }),
    previousVersion: context.previousVersion,
    previousExecutable: context.snapshot.previousExecutable,
    configurationChanged: configurationChanged
  };
};

NodeRuntimeUpdater.prototype._persistInterpreter = function(context, runtime) {
  var store = this._getStateStore();
  var current = store.get(context.entry.serviceName);

  if (!current || typeof current !== 'object') {
    throw new Error('Cannot read metadata for ' + context.entry.serviceName);
  }

  var metadata = clonePlain(current);
  metadata.exec_interpreter = runtime.executable;
  metadata.updated_at = Date.now();

  store.replace(context.entry.serviceName, metadata);
};

NodeRuntimeUpdater.prototype._restoreMetadata = function(rollback) {
  this._getStateStore().replace(rollback.serviceName, clonePlain(rollback.metadata));
};

NodeRuntimeUpdater.prototype._isStartLimitFailure = function(error, status) {
  if (/start request repeated too quickly|start[- ]limit/i.test(errorMessage(error))) {
    return true;
  }
  if (!status || typeof status !== 'object') return false;

  return status.ActiveState === 'failed' ||
    status.SubState === 'failed' ||
    status.SubState === 'auto-restart';
};

NodeRuntimeUpdater.prototype._restartForRecovery = async function(serviceName) {
  var systemd = this._getSystemd();

  try {
    await systemd.restart(serviceName);
    return;
  } catch (error) {
    var status = null;

    try {
      status = await systemd.getStatus(serviceName);
    } catch (statusError) {
      status = null;
    }

    if (!this._isStartLimitFailure(error, status)) throw error;

    await systemd.resetFailed(serviceName);
    await systemd.restart(serviceName);
  }
};

NodeRuntimeUpdater.prototype._verifyInactiveInstance = async function(instance) {
  var systemd = this._getSystemd();
  var status = await systemd.getStatus(instance.name);

  if (!status || typeof status !== 'object') {
    throw new Error('systemd status is missing');
  }

  if (status.ActiveState === 'active' || status.SubState === 'running') {
    await systemd.stop(instance.name);
    status = await systemd.getStatus(instance.name);
    if (!status || typeof status !== 'object') {
      throw new Error('systemd status is missing');
    }
  }

  if (status.ActiveState !== 'inactive' || status.SubState !== 'dead') {
    throw new Error(
      'expected inactive/dead but found ' +
      String(status.ActiveState) + '/' + String(status.SubState)
    );
  }
  if (status.MainPID !== undefined && Number(status.MainPID) !== 0) {
    throw new Error('expected MainPID 0 but found ' + String(status.MainPID));
  }
};

NodeRuntimeUpdater.prototype._recoverInstances = async function(rollback) {
  var verifier = this._getVerifier();
  var errors = [];
  var verifiedActive = 0;

  for (var index = 0; index < rollback.instances.length; index += 1) {
    var instance = rollback.instances[index];

    if (instance.active) {
      try {
        await this._restartForRecovery(instance.name);
        await verifier.verify(instance.name, rollback.previousExecutable);
        verifiedActive += 1;
      } catch (error) {
        errors.push(
          'recover instance ' + instance.name + ': ' + errorMessage(error)
        );
      }
      continue;
    }

    try {
      await this._verifyInactiveInstance(instance);
    } catch (error) {
      errors.push(
        'verify inactive instance ' + instance.name + ': ' + errorMessage(error)
      );
    }
  }

  return { errors: errors, verifiedActive: verifiedActive };
};

NodeRuntimeUpdater.prototype._rollback = async function(rollback, row, originalError) {
  var message = errorMessage(originalError);
  var errors = [];
  var configurationRestored = true;
  var verifiedActive = 0;
  var originallyActive = rollback.instances.filter(function(instance) {
    return instance.active;
  }).length;

  row.status = 'failed_restore';
  row.reason = message;
  row.errors.push(message);
  row.startupVerified = false;

  if (rollback.configurationChanged) {
    try {
      this._getRuntimeConfig().restore(rollback.snapshot);
    } catch (error) {
      errors.push('restore configuration: ' + errorMessage(error));
      configurationRestored = false;
    }

    if (configurationRestored) {
      try {
        await this._getSystemd().daemonReload();
      } catch (error) {
        errors.push('reload restored configuration: ' + errorMessage(error));
        configurationRestored = false;
      }
    }

    if (!configurationRestored) {
      errors.push(
        'unable to safely recover instances: restored configuration is not active'
      );
    }
  }

  try {
    this._restoreMetadata(rollback);
  } catch (error) {
    errors.push('restore metadata: ' + errorMessage(error));
  }

  if (rollback.configurationChanged && configurationRestored) {
    try {
      var recovery = await this._recoverInstances(rollback);
      errors = errors.concat(recovery.errors);
      verifiedActive = recovery.verifiedActive;
    } catch (error) {
      errors.push('unable to recover instances: ' + errorMessage(error));
    }
  }

  row.rollbackErrors = errors;

  if (errors.length === 0) {
    row.status = 'failed_restored';
    row.startupVerified = originallyActive > 0 && verifiedActive === originallyActive;
  }
};

NodeRuntimeUpdater.prototype._reasonForInstances = function(instances, extra) {
  var stopped = instances.filter(function(instance) {
    return !instance.active;
  }).map(function(instance) {
    return instance.name;
  });
  var parts = [];

  if (extra) parts.push(extra);

  if (stopped.length > 0) {
    if (stopped.length === instances.length) {
      parts.push('service is stopped; startup was not verified');
    } else {
      parts.push(
        'stopped instances were not started or verified: ' + stopped.join(', ')
      );
    }
  }

  return parts.length > 0 ? parts.join('; ') : null;
};

NodeRuntimeUpdater.prototype._updateMetadata = async function(context, runtime) {
  var row = context.row;
  var rollback;

  try {
    rollback = this._rememberRollback(context, false);
  } catch (error) {
    this._failRow(row, 'failed_unchanged', error);
    return;
  }

  try {
    this._persistInterpreter(context, runtime);
  } catch (error) {
    await this._rollback(rollback, row, error);
    return;
  }

  row.status = 'updated';
  row.startupVerified = false;
  row.reason = this._reasonForInstances(
    context.instances,
    'runtime already configured; metadata updated'
  );
};

NodeRuntimeUpdater.prototype._restartAndVerify = async function(instanceName, executable) {
  try {
    await this._getSystemd().restart(instanceName);
  } catch (error) {
    throw new Error(
      'instance ' + instanceName + ': restart failed: ' + errorMessage(error)
    );
  }

  try {
    await this._getVerifier().verify(instanceName, executable);
  } catch (error) {
    throw new Error(
      'instance ' + instanceName + ': startup verification failed: ' + errorMessage(error)
    );
  }
};

NodeRuntimeUpdater.prototype._updateConfiguration = async function(context, runtime, plan) {
  var row = context.row;
  var systemd = this._getSystemd();
  var rollback;
  var startupErrors = [];
  var active = context.instances.filter(function(instance) {
    return instance.active;
  });

  try {
    rollback = this._rememberRollback(context, true);
  } catch (error) {
    this._failRow(row, 'failed_unchanged', error);
    return;
  }

  try {
    await this._getRuntimeConfig().apply(context.snapshot, plan);
    await systemd.daemonReload();

    // Without startup rollback, commit metadata before attempting any restart.
    // Configuration/reload/persistence errors still follow the safe recovery path.
    if (!this.rollbackEnabled) this._persistInterpreter(context, runtime);

    for (var instanceIndex = 0; instanceIndex < active.length; instanceIndex += 1) {
      try {
        await this._restartAndVerify(active[instanceIndex].name, runtime.executable);
      } catch (error) {
        if (this.rollbackEnabled) throw error;
        startupErrors.push(errorMessage(error));
      }
    }

    if (this.rollbackEnabled) this._persistInterpreter(context, runtime);
  } catch (error) {
    await this._rollback(rollback, row, error);
    return;
  }

  if (startupErrors.length > 0) {
    row.status = 'failed_no_rollback';
    row.errors = startupErrors;
    row.startupVerified = false;
    row.reason = this._reasonForInstances(context.instances, startupErrors.join('; '));
    return;
  }

  row.status = 'updated';
  row.stopped = active.length === 0;
  row.startupVerified = active.length > 0;
  row.reason = this._reasonForInstances(context.instances, null);
};

NodeRuntimeUpdater.prototype._updatePrepared = async function(context, runtime) {
  var row = context.row;
  var runtimeConfig = this._getRuntimeConfig();
  var plan;

  try {
    plan = await runtimeConfig.plan(context.snapshot, runtime);
    if (!plan || typeof plan !== 'object') {
      throw new Error('Runtime configuration plan is invalid');
    }
  } catch (error) {
    this._failRow(row, 'failed_unchanged', error);
    return;
  }

  if (!plan.changed) {
    if (this._metadataIsCurrent(context.entry, runtime)) {
      row.status = 'skipped';
      row.reason = this._reasonForInstances(
        context.instances,
        'runtime already configured'
      );
      row.startupVerified = false;
      return;
    }

    await this._updateMetadata(context, runtime);
    return;
  }

  await this._updateConfiguration(context, runtime, plan);
};

NodeRuntimeUpdater.prototype._execute = async function(version, report) {
  var nvm = this._getNvm();
  var normalizedVersion;

  try {
    normalizedVersion = nvm.validateVersion(version);
  } catch (error) {
    report.globalError = errorMessage(error);
    return;
  }

  if (typeof normalizedVersion !== 'string' || normalizedVersion.length === 0) {
    report.globalError = 'Invalid Node version';
    return;
  }

  report.requestedVersion = normalizedVersion;

  if (this.platform !== 'linux') {
    report.globalError = 'Node runtime updates require Linux';
    return;
  }

  if (!this._isSystemd()) {
    report.globalError = 'Node runtime updates require systemd';
    return;
  }

  try {
    this._assertSudoContext();
  } catch (error) {
    report.globalError = errorMessage(error);
    return;
  }

  var store = this._getStateStore();

  try {
    store.load({ strict: true });
  } catch (error) {
    report.globalError = 'Cannot read ZM2 state: ' + errorMessage(error);
    return;
  }

  var entries;

  try {
    entries = store.getAll();
  } catch (error) {
    report.globalError = 'Cannot enumerate ZM2 state: ' + errorMessage(error);
    return;
  }

  if (!Array.isArray(entries)) {
    report.globalError = 'Cannot enumerate ZM2 state: services list is invalid';
    return;
  }

  var prepared = [];

  for (var index = 0; index < entries.length; index += 1) {
    var entry = entries[index];
    var serviceName = entry && typeof entry.serviceName === 'string'
      ? entry.serviceName
      : '';
    var row = createRow(entry, serviceName);
    report.results.push(row);

    if (!entry || typeof entry !== 'object' || !serviceName) {
      this._failRow(row, 'failed_unchanged', new Error('Invalid StateStore entry'));
      continue;
    }

    var selection = this._classify(entry);

    if (!selection.eligible) {
      row.status = 'skipped';
      row.reason = selection.reason;
      continue;
    }

    var context = await this._inspectEntry(entry, row);
    if (context) prepared.push(context);
  }

  if (prepared.length === 0) return;

  try {
    this._preflightResources();
  } catch (error) {
    var preflightMessage = errorMessage(error);
    report.globalError = preflightMessage;
    this._markNotUpdated(prepared, preflightMessage);
    return;
  }

  var runtime;

  try {
    runtime = await nvm.prepare(normalizedVersion);
    runtime = this._validateRuntime(runtime, normalizedVersion);
  } catch (error) {
    var prepareMessage = 'Cannot prepare Node runtime: ' + errorMessage(error);
    report.globalError = prepareMessage;
    this._markNotUpdated(prepared, prepareMessage);
    return;
  }

  report.runtime = {
    version: runtime.version,
    executable: runtime.executable,
    binDir: runtime.binDir
  };

  for (var preparedIndex = 0; preparedIndex < prepared.length; preparedIndex += 1) {
    await this._updatePrepared(prepared[preparedIndex], runtime);
  }
};

/**
 * Validate, inspect and update all eligible registered applications.
 *
 * @param {String} version Exact major.minor.patch version, optionally v-prefixed
 * @returns {Promise<Object>} UpdateNodeReport
 */
NodeRuntimeUpdater.prototype.run = function(version) {
  var self = this;
  var report = createReport(version);

  return Promise.resolve()
    .then(function() {
      return self._execute(version, report);
    })
    .catch(function(error) {
      if (!report.globalError) {
        report.globalError = errorMessage(error);
      }
    })
    .then(function() {
      return finalizeReport(report);
    });
};

module.exports = NodeRuntimeUpdater;
