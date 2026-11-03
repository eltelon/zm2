'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var EXACT_VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
var NVM_SCRIPT = '. "$1"; shift; nvm "$@"';
var CHILD_ENV_TO_REMOVE = [
  'BASH_ENV',
  'ENV',
  'CDPATH',
  'SHELLOPTS',
  'BASHOPTS',
  'NODE_OPTIONS',
  'NODE_V8_COVERAGE'
];
var DEFAULT_TIMEOUT = 10 * 60 * 1000;
var DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;

/**
 * Resolve and verify an exact Node runtime through a single user's nvm.
 *
 * Constructor options:
 *   env       Environment used to select NVM_DIR or HOME/.nvm. It is copied
 *             for child processes, stripped of shell startup and Node
 *             injection variables, and never mutated. Defaults to process.env.
 *   fs        Node fs-compatible module. Must expose constants, existsSync,
 *             statSync, lstatSync, readFileSync, writeFileSync, chmodSync,
 *             unlinkSync and accessSync. Defaults to require('fs').
 *   run       Process runner: run(command, args, options) -> Promise or value
 *             of { code, stdout, stderr, errorMessage? }. A non-zero code
 *             rejects the call. Defaults to a bounded child_process.execFile
 *             runner.
 *   shell     Shell used to source nvm.sh. Defaults to /bin/bash.
 *   timeout   Child process timeout in milliseconds.
 *   maxBuffer Child process output limit in bytes.
 *
 * Methods:
 *   validateVersion(input) -> canonical version without a leading v
 *   prepare(version) -> Promise<{ version, executable, binDir }>
 */
function Nvm(options) {
  options = options || {};

  this.env = options.env || process.env;
  this.fs = options.fs || fs;
  this.run = options.run || defaultRun;
  this.shell = options.shell || '/bin/bash';
  this.timeout = options.timeout === undefined ? DEFAULT_TIMEOUT : options.timeout;
  this.maxBuffer = options.maxBuffer === undefined ? DEFAULT_MAX_BUFFER : options.maxBuffer;
}

function defaultRun(command, args, options) {
  return new Promise(function(resolve) {
    childProcess.execFile(command, args, options, function(error, stdout, stderr) {
      var code = 0;
      var errorMessage = null;

      if (error) {
        code = typeof error.code === 'number' ? error.code : 1;
        errorMessage = error.message || null;
      }

      resolve({
        code: code,
        stdout: stdout || '',
        stderr: stderr || '',
        errorMessage: errorMessage
      });
    });
  });
}

function accessMode(fsModule, name, fallback) {
  if (fsModule.constants && typeof fsModule.constants[name] === 'number') {
    return fsModule.constants[name];
  }
  return fallback;
}

function lstatIfExists(fsModule, target) {
  try {
    return fsModule.lstatSync(target);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return null;
    }
    throw err;
  }
}

Nvm.prototype.validateVersion = function(input) {
  if (typeof input !== 'string' || !EXACT_VERSION.test(input)) {
    throw new Error(
      'Invalid Node version ' + JSON.stringify(input) +
      ': expected an exact major.minor.patch version (for example 26.12.1)'
    );
  }

  return input.charAt(0) === 'v' ? input.slice(1) : input;
};

Nvm.prototype.prepare = async function(input) {
  var version = this.validateVersion(input);
  var nvmDir = this._resolveNvmDir();
  var nvmSh = path.join(nvmDir, 'nvm.sh');

  this._assertReadableFile(nvmSh, 'nvm.sh');

  var runtime = this._runtimePath(nvmDir, version);
  var executable;

  if (this._runtimeIsPresent(runtime)) {
    executable = await this._resolveExecutable(nvmDir, version);
  } else {
    await this._installRuntime(nvmDir, version);
    executable = await this._resolveExecutable(nvmDir, version);
  }

  await this._verifyExecutable(nvmDir, executable, version);

  return {
    version: version,
    executable: executable,
    binDir: path.dirname(executable)
  };
};

Nvm.prototype._resolveNvmDir = function() {
  if (this.env.NVM_DIR) {
    if (typeof this.env.NVM_DIR !== 'string') {
      throw new Error('NVM_DIR must be a string');
    }
    return path.resolve(this.env.NVM_DIR);
  }

  if (this.env.HOME) {
    if (typeof this.env.HOME !== 'string') {
      throw new Error('HOME must be a string');
    }
    return path.resolve(this.env.HOME, '.nvm');
  }

  throw new Error('Cannot locate nvm: set NVM_DIR or HOME');
};

Nvm.prototype._assertReadableFile = function(file, label) {
  var stat;

  try {
    stat = this.fs.statSync(file);
  } catch (err) {
    throw new Error(label + ' is missing or not readable at ' + file);
  }

  if (!stat.isFile()) {
    throw new Error(label + ' is not a regular file at ' + file);
  }

  try {
    this.fs.accessSync(file, accessMode(this.fs, 'R_OK', 4));
  } catch (err) {
    throw new Error(label + ' is not readable at ' + file);
  }
};

Nvm.prototype._runtimePath = function(nvmDir, version) {
  return path.join(nvmDir, 'versions', 'node', 'v' + version, 'bin', 'node');
};

Nvm.prototype._runtimeIsPresent = function(runtime) {
  if (!this.fs.existsSync(runtime)) {
    return false;
  }

  var stat = this.fs.statSync(runtime);

  if (!stat.isFile()) {
    throw new Error('Node runtime path is not a regular file: ' + runtime);
  }

  return true;
};

Nvm.prototype._resolveExecutable = async function(nvmDir, version) {
  var result = await this._runNvm(nvmDir, ['which', version]);
  var output = String(result.stdout || '').trim();

  if (!output) {
    throw new Error('nvm did not return an executable for Node ' + version);
  }

  if (!path.isAbsolute(output)) {
    throw new Error(
      'nvm returned a non-absolute executable path for Node ' + version + ': ' + output
    );
  }

  return path.normalize(output);
};

Nvm.prototype._installRuntime = async function(nvmDir, version) {
  var alias = this._snapshotDefaultAlias(nvmDir);

  this._assertAliasPreservable(alias);

  var installError = null;

  try {
    await this._runNvm(nvmDir, ['install', version]);
  } catch (err) {
    installError = err;
  }

  var restoreError = null;

  try {
    this._restoreDefaultAlias(alias);
  } catch (err) {
    restoreError = err;
  }

  if (installError && restoreError) {
    var combined = new Error(
      'nvm install failed for Node ' + version + ': ' + installError.message +
      '; additionally failed to restore the nvm default alias: ' + restoreError.message
    );
    combined.installError = installError;
    combined.restoreError = restoreError;
    throw combined;
  }

  if (installError) {
    throw installError;
  }

  if (restoreError) {
    throw new Error(
      'nvm install succeeded for Node ' + version +
      ' but the nvm default alias could not be restored: ' + restoreError.message
    );
  }
};

Nvm.prototype._snapshotDefaultAlias = function(nvmDir) {
  var aliasFile = path.join(nvmDir, 'alias', 'default');
  var aliasDir = path.dirname(aliasFile);

  var stat = lstatIfExists(this.fs, aliasFile);

  if (!stat) {
    return {
      path: aliasFile,
      dir: aliasDir,
      nvmDir: nvmDir,
      exists: false
    };
  }

  if (!stat.isFile()) {
    throw new Error(
      'Cannot preserve nvm default alias: not a regular file: ' + aliasFile
    );
  }

  return {
    path: aliasFile,
    dir: aliasDir,
    nvmDir: nvmDir,
    exists: true,
    content: this.fs.readFileSync(aliasFile),
    mode: stat.mode & 0o7777
  };
};

Nvm.prototype._assertAliasPreservable = function(alias) {
  var stat = lstatIfExists(this.fs, alias.dir);

  if (!stat) {
    try {
      this.fs.accessSync(alias.nvmDir, accessMode(this.fs, 'W_OK', 2));
    } catch (err) {
      throw new Error(
        'Cannot guarantee nvm default alias preservation: nvm directory is not writable: ' +
        alias.nvmDir
      );
    }
    return;
  }

  if (!stat.isDirectory()) {
    throw new Error(
      'Cannot guarantee nvm default alias preservation: alias path is not a directory: ' +
      alias.dir
    );
  }

  try {
    this.fs.accessSync(alias.dir, accessMode(this.fs, 'W_OK', 2));
  } catch (err) {
    throw new Error(
      'Cannot guarantee nvm default alias preservation: alias directory is not writable: ' +
      alias.dir
    );
  }

  if (alias.exists) {
    try {
      this.fs.accessSync(
        alias.path,
        accessMode(this.fs, 'W_OK', 2) | accessMode(this.fs, 'R_OK', 4)
      );
    } catch (err) {
      throw new Error(
        'Cannot guarantee nvm default alias preservation: existing alias is not readable and writable: ' +
        alias.path
      );
    }
  }
};

Nvm.prototype._restoreDefaultAlias = function(alias) {
  if (!alias.exists) {
    if (lstatIfExists(this.fs, alias.path)) {
      this.fs.unlinkSync(alias.path);
    }
    return;
  }

  this.fs.writeFileSync(alias.path, alias.content);
  this.fs.chmodSync(alias.path, alias.mode);
};

Nvm.prototype._runNvm = function(nvmDir, nvmArgs) {
  var nvmSh = path.join(nvmDir, 'nvm.sh');
  var args = [
    '--noprofile',
    '--norc',
    '-c',
    NVM_SCRIPT,
    'zm2-nvm',
    nvmSh
  ].concat(nvmArgs);

  return this._runProcess(this.shell, args, this._processOptions(nvmDir));
};

Nvm.prototype._processOptions = function(nvmDir) {
  var env = Object.assign({}, this.env);

  CHILD_ENV_TO_REMOVE.forEach(function(key) {
    delete env[key];
  });

  if (nvmDir) {
    env.NVM_DIR = nvmDir;
  }

  return {
    env: env,
    timeout: this.timeout,
    maxBuffer: this.maxBuffer,
    encoding: 'utf8',
    shell: false
  };
};

Nvm.prototype._runProcess = async function(command, args, options) {
  var result = await this.run(command, args, options);

  if (!result || typeof result !== 'object') {
    throw new Error('Process runner returned an invalid result for ' + command);
  }

  var code = result.code;

  if (code === undefined) {
    code = result.status;
  }
  if (code === undefined) {
    code = 0;
  }

  if (code !== 0) {
    var message = 'Command failed with code ' + code + ': ' + command + ' ' +
      args.map(function(arg) {
        return JSON.stringify(arg);
      }).join(' ');

    if (result.errorMessage) {
      message += '\n' + String(result.errorMessage).trim();
    } else if (result.stderr) {
      message += '\n' + String(result.stderr).trim();
    }

    var error = new Error(message);
    error.code = code;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }

  return result;
};

Nvm.prototype._verifyExecutable = async function(nvmDir, executable, version) {
  if (!path.isAbsolute(executable)) {
    throw new Error('Node executable path is not absolute: ' + executable);
  }

  var stat;

  try {
    stat = this.fs.statSync(executable);
  } catch (err) {
    throw new Error('Node executable does not exist: ' + executable);
  }

  if (!stat.isFile()) {
    throw new Error('Node executable is not a regular file: ' + executable);
  }

  try {
    this.fs.accessSync(executable, accessMode(this.fs, 'X_OK', 1));
  } catch (err) {
    throw new Error('Node executable is not executable: ' + executable);
  }

  var result = await this._runProcess(
    executable,
    ['--version'],
    this._processOptions(nvmDir)
  );
  var actual = String(result.stdout || '').trim();
  var expected = 'v' + version;

  if (actual !== expected) {
    throw new Error(
      'Node version mismatch for ' + executable + ': expected ' +
      expected + ', got ' + JSON.stringify(actual)
    );
  }
};

module.exports = Nvm;
