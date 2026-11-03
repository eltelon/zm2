/**
 * Copyright 2024 the ZM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var LOCK_SUFFIX = '.lock';
var TMP_SUFFIX = '.tmp-';
var DEFAULT_LOCK_TIMEOUT_MS = 2000;
var DEFAULT_LOCK_RETRY_MS = 10;
var SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function defaultState() {
  return { services: {}, next_id: 1 };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  var prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidId(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// Strict reads are used by update-node preflight and all state mutations.
function validateState(data) {
  if (!isPlainObject(data)) {
    throw new Error('Invalid state: root must be an object');
  }
  if (!isPlainObject(data.services)) {
    throw new Error('Invalid state: services must be an object mapping');
  }
  Object.keys(data.services).forEach(function(serviceName) {
    var metadata = data.services[serviceName];
    if (!isPlainObject(metadata)) {
      throw new Error('Invalid state: metadata for "' + serviceName + '" must be an object');
    }
    if (!Object.prototype.hasOwnProperty.call(metadata, 'pm_id') || !isValidId(metadata.pm_id)) {
      throw new Error('Invalid state: pm_id for "' + serviceName + '" must be a non-negative integer');
    }
  });
  if (!isValidId(data.next_id) || data.next_id < 1) {
    throw new Error('Invalid state: next_id must be a positive integer');
  }
}

function numericOption(value, fallback, minimum) {
  if (typeof value === 'number' && isFinite(value) && value >= minimum) {
    return value;
  }
  return fallback;
}

function invalidStateError(filePath, detail, cause) {
  var kind = cause ? 'corrupt' : 'invalid';
  var error = new Error(
    'StateStore: state file ' + filePath + ' is ' + kind + ' (' + detail + '). ' +
    'Refusing to modify it; repair or remove the file manually.'
  );
  if (cause) {
    error.cause = cause;
    if (cause.code) error.code = cause.code;
  }
  return error;
}

function normalizeLoadedState(parsed) {
  if (!isPlainObject(parsed)) return defaultState();
  if (!isPlainObject(parsed.services)) parsed.services = {};

  var keys = Object.keys(parsed.services);
  var maxPmId = -1;

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var entry = parsed.services[key];

    if (!isPlainObject(entry)) {
      delete parsed.services[key];
      continue;
    }

    if (entry.pm_id !== undefined) {
      if (typeof entry.pm_id !== 'number' || !isFinite(entry.pm_id)) continue;
      if (entry.pm_id > maxPmId) {
        maxPmId = entry.pm_id;
      }
    }
  }

  if (typeof parsed.next_id !== 'number' || !isFinite(parsed.next_id) || parsed.next_id < 1) {
    parsed.next_id = Math.max(1, Math.floor(maxPmId) + 1);
  } else if (Math.floor(parsed.next_id) !== parsed.next_id) {
    parsed.next_id = Math.ceil(parsed.next_id);
  } else if (parsed.next_id <= maxPmId) {
    // Never hand out an ID already present, even if a previous writer left
    // the counter behind. This does not discard any existing record.
    parsed.next_id = Math.floor(maxPmId) + 1;
  }

  return parsed;
}

function lockOwnerDescription(lockPath) {
  try {
    var raw = fs.readFileSync(lockPath, 'utf8').trim();
    if (!raw) return '';
    var owner = JSON.parse(raw);
    var details = [];
    if (owner && typeof owner.pid === 'number') {
      details.push('pid ' + owner.pid);
    }
    if (owner && typeof owner.created_at === 'number') {
      details.push('created ' + new Date(owner.created_at).toISOString());
    }
    return details.length ? ' (lock owner: ' + details.join(', ') + ')' : '';
  } catch (e) {
    return '';
  }
}

/**
 * StateStore - Manages ZM2 metadata that systemd doesn't track.
 * Persisted as JSON at ~/.zm2/state.json
 *
 * Mutations (register, unregister, clear) are serialized across processes
 * with an exclusive lock file and committed with an atomic rename. Reads
 * always refresh from the last committed file.
 *
 * @param {String} filePath - Path to state.json
 * @param {Object} [options] - Optional lock tuning
 * @param {Number} [options.lockTimeoutMs=2000] - Maximum time to wait for the lock
 * @param {Number} [options.lockRetryMs=10] - Delay between lock attempts
 */
function StateStore(filePath, options) {
  var opts = options || {};

  this.filePath = filePath;
  this.lockPath = filePath + LOCK_SUFFIX;
  this.lockTimeoutMs = numericOption(opts.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, 0);
  this.lockRetryMs = numericOption(opts.lockRetryMs, DEFAULT_LOCK_RETRY_MS, 1);
  this.data = null;
  this._baseRaw = null;
  this._baseExists = false;
  this._baseCorrupt = false;
}

/**
 * Read the state file.
 *
 * In strict mode any error or malformed structure is thrown. In legacy mode
 * errors fall back to a default state, preserving the historical load()
 * behavior used by read-only callers.
 *
 * @param {Boolean} strict
 * @returns {Object} { data, raw, exists, error }
 */
StateStore.prototype._readState = function(strict) {
  var raw = null;

  try {
    raw = fs.readFileSync(this.filePath, 'utf8');
  } catch (readError) {
    if (readError && readError.code === 'ENOENT') {
      return { data: defaultState(), raw: null, exists: false, error: null };
    }

    if (strict) {
      var stateError = new Error(
        'StateStore: cannot read state file ' + this.filePath + ': ' +
        readError.message + '. Refusing to modify it.'
      );
      stateError.cause = readError;
      if (readError.code) stateError.code = readError.code;
      throw stateError;
    }

    return { data: defaultState(), raw: null, exists: false, error: readError };
  }

  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseError) {
    if (strict) {
      throw invalidStateError(this.filePath, 'cannot parse JSON: ' + parseError.message, parseError);
    }
    return { data: defaultState(), raw: raw, exists: true, error: parseError };
  }

  if (strict) validateState(parsed);
  else parsed = normalizeLoadedState(parsed);
  return { data: parsed, raw: raw, exists: true, error: null };
};

/**
 * Load state from disk. Creates default state if file doesn't exist.
 * Corrupt or unreadable state is tolerated by default for compatibility.
 *
 * @param {Object} [options]
 * @param {Boolean} [options.strict=false] - Throw instead of falling back to defaults
 */
StateStore.prototype.load = function(options) {
  var strict = !!(options && options.strict);
  var result;
  try {
    result = this._readState(strict);
  } catch (error) {
    // Preserve strict-load error identity for callers such as update-node.
    throw error.cause || error;
  }

  this.data = result.data;
  this._baseRaw = result.raw;
  this._baseExists = result.exists;
  this._baseCorrupt = !!result.error;

  return this;
};

/**
 * Acquire the exclusive lock, waiting for at most lockTimeoutMs.
 * A live lock is never removed or taken over automatically.
 */
StateStore.prototype._acquireLock = function() {
  fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

  var startedAt = Date.now();

  while (true) {
    var fd = null;

    try {
      fd = fs.openSync(this.lockPath, 'wx', 0o600);
    } catch (lockError) {
      if (lockError.code !== 'EEXIST') {
        var createError = new Error(
          'StateStore: cannot create lock file ' + this.lockPath + ': ' + lockError.message
        );
        createError.cause = lockError;
        if (lockError.code) createError.code = lockError.code;
        throw createError;
      }
    }

    if (fd !== null) {
      try {
        fs.writeSync(fd, JSON.stringify({
          pid: process.pid,
          created_at: Date.now()
        }), 0, 'utf8');
        fs.closeSync(fd);
      } catch (writeError) {
        try { fs.closeSync(fd); } catch (closeError) { /* ignore */ }
        try { fs.unlinkSync(this.lockPath); } catch (unlinkError) { /* ignore */ }
        var initError = new Error(
          'StateStore: cannot initialize lock file ' + this.lockPath + ': ' + writeError.message
        );
        initError.cause = writeError;
        throw initError;
      }
      return;
    }

    var elapsed = Date.now() - startedAt;
    if (elapsed >= this.lockTimeoutMs) {
      throw new Error(
        'StateStore: timed out after ' + this.lockTimeoutMs + 'ms waiting for lock ' +
        this.lockPath + lockOwnerDescription(this.lockPath) + '. ' +
        'Another zm2 process may be updating state. If no zm2 process is running, ' +
        'inspect and remove the lock file, then retry.'
      );
    }

    Atomics.wait(SLEEP_BUFFER, 0, 0, Math.min(this.lockRetryMs, this.lockTimeoutMs - elapsed));
  }
};

/**
 * Release the lock acquired by this instance.
 */
StateStore.prototype._releaseLock = function() {
  try {
    fs.unlinkSync(this.lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    var releaseError = new Error(
      'StateStore: failed to release lock ' + this.lockPath + ': ' + error.message
    );
    releaseError.cause = error;
    if (error.code) releaseError.code = error.code;
    throw releaseError;
  }
};

/**
 * Run a synchronous operation while holding the lock. The lock is always
 * released, even when the operation throws.
 */
StateStore.prototype._withLock = function(operation) {
  this._acquireLock();

  var result;
  var operationError = null;

  try {
    result = operation();
  } catch (error) {
    operationError = error;
  }

  var releaseError = null;
  try {
    this._releaseLock();
  } catch (error) {
    releaseError = error;
  }

  if (operationError) {
    if (releaseError) operationError.lockReleaseError = releaseError;
    throw operationError;
  }
  if (releaseError) throw releaseError;

  return result;
};

/**
 * Write state atomically using a uniquely named, exclusively-created
 * temporary file in the same directory, followed by a rename. The previously
 * committed state survives any failure before the rename.
 *
 * @param {Object} data
 * @returns {String} serialized JSON that was committed
 */
StateStore.prototype._writeAtomic = function(data) {
  var directory = path.dirname(this.filePath);
  fs.mkdirSync(directory, { recursive: true });

  var existing = null;
  try {
    existing = fs.statSync(this.filePath);
  } catch (statError) {
    if (statError.code !== 'ENOENT') throw statError;
  }

  var json = JSON.stringify(data, null, 2);
  var temporaryPath = this.filePath + TMP_SUFFIX + process.pid + '-' +
    crypto.randomBytes(8).toString('hex');

  var fd = fs.openSync(temporaryPath, 'wx', 0o600);
  var error = null;
  var committed = false;

  try {
    fs.writeFileSync(fd, json, 'utf8');
    // Updating another user's runtime must not transfer ownership of their state.
    // New files stay private; existing permissions are preserved as in update-node.
    if (existing) {
      var created = fs.fstatSync(fd);
      if (created.uid !== existing.uid || created.gid !== existing.gid) {
        fs.fchownSync(fd, existing.uid, existing.gid);
      }
      fs.fchmodSync(fd, existing.mode & 0o7777);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporaryPath, this.filePath);
    committed = true;
  } catch (writeError) {
    error = writeError;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (closeError) { /* ignore */ }
    }
    if (!committed) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT' && error) {
          error.cleanupError = unlinkError;
        }
      }
    }
  }

  if (error) throw error;
  return json;
};

/**
 * Apply a mutation while holding the lock. The state is strictly reloaded
 * inside the lock, so concurrent clients cannot lose each other's commits.
 * Corrupt or unreadable state is rejected instead of overwritten.
 *
 * @param {Function} mutate - receives fresh state, returns the operation result
 * @returns {*} mutation result
 */
StateStore.prototype._mutate = function(mutate) {
  var self = this;

  return this._withLock(function() {
    var state = normalizeLoadedState(self._readState(true).data);
    var result = mutate(state);
    var json = self._writeAtomic(state);

    self.data = state;
    self._baseRaw = json;
    self._baseExists = true;
    self._baseCorrupt = false;

    return result;
  });
};

/**
 * Save the current in-memory state atomically.
 *
 * Mutations use _mutate() instead. This compatibility method refuses to
 * overwrite a file that changed since this instance loaded it; callers must
 * reload and reapply their changes.
 */
StateStore.prototype.save = function() {
  if (!this.data) {
    this.load();
  }

  var self = this;

  this._withLock(function() {
    if (self._baseCorrupt) {
      throw new Error(
        'StateStore: cannot save ' + self.filePath +
        ' because the last load failed. Repair the state file and reload before saving.'
      );
    }

    var current = self._readState(true);
    if (current.exists !== self._baseExists || current.raw !== self._baseRaw) {
      throw new Error(
        'StateStore: refusing to save stale state for ' + self.filePath +
        '; another process updated it since this instance loaded. Reload and reapply changes.'
      );
    }

    var json = self._writeAtomic(self.data);
    self._baseRaw = json;
    self._baseExists = true;
    self._baseCorrupt = false;
  });

  return this;
};

/**
 * Replace existing metadata exactly, including timestamps, for runtime updates
 * and rollback. Reload under the write lock so unrelated commits are retained.
 */
StateStore.prototype.replace = function(serviceName, metadata) {
  this._mutate(function(state) {
    if (!Object.prototype.hasOwnProperty.call(state.services, serviceName)) {
      throw new Error('Cannot replace missing service: ' + serviceName);
    }
    if (!isPlainObject(metadata)) throw new TypeError('Service metadata must be an object');
    if (Object.keys(state.services).some(function(name) {
      return name !== serviceName && state.services[name].pm_id === metadata.pm_id;
    })) {
      throw new Error('StateStore: pm_id ' + metadata.pm_id + ' is already assigned to another service');
    }
    state.services[serviceName] = JSON.parse(JSON.stringify(metadata));
    validateState(state);
  });
  return this;
};

/**
 * Register a new service. Returns the assigned pm_id.
 *
 * @param {String} serviceName - Systemd unit name (e.g. "zm2-myapp")
 * @param {Object} metadata - { name, script, namespace, instances, ... }
 * @returns {Number} pm_id
 */
StateStore.prototype.register = function(serviceName, metadata) {
  var input = metadata || {};

  return this._mutate(function(state) {
    var services = state.services;

    if (services[serviceName]) {
      var existing = services[serviceName];
      var existingPmId = existing.pm_id;

      Object.keys(input).forEach(function(key) {
        if (key === 'pm_id') return;
        existing[key] = input[key];
      });

      // Updating metadata never changes the assigned ID, including pm_id 0.
      existing.pm_id = existingPmId;
      existing.updated_at = Date.now();

      return existing.pm_id;
    }

    // Allow caller to pin a specific pm_id (e.g. zm2-api reserves 0)
    var pmId = (typeof input.pm_id === 'number') ? input.pm_id : state.next_id++;
    if (Object.keys(services).some(function(name) { return services[name].pm_id === pmId; })) {
      throw new Error('StateStore: pm_id ' + pmId + ' is already assigned to another service');
    }

    services[serviceName] = Object.assign({}, input, {
      pm_id: pmId,
      created_at: Date.now(),
      updated_at: Date.now()
    });

    return pmId;
  });
};

/**
 * Unregister a service.
 *
 * @param {String} serviceName
 */
StateStore.prototype.unregister = function(serviceName) {
  this._mutate(function(state) {
    delete state.services[serviceName];
  });

  return this;
};

/**
 * Get service metadata by systemd unit name.
 *
 * @param {String} serviceName
 * @returns {Object|null}
 */
StateStore.prototype.get = function(serviceName) {
  this.load();
  return this.data.services[serviceName] || null;
};

/**
 * Find service by app name (not the full systemd unit name).
 *
 * @param {String} name - App name (e.g. "myapp")
 * @returns {Object|null} { serviceName, ...metadata }
 */
StateStore.prototype.getByName = function(name) {
  this.load();

  var services = this.data.services;
  var keys = Object.keys(services);
  for (var i = 0; i < keys.length; i++) {
    if (services[keys[i]].name === name) {
      return Object.assign({ serviceName: keys[i] }, services[keys[i]]);
    }
  }
  return null;
};

/**
 * Find service by pm_id.
 *
 * @param {Number} pmId
 * @returns {Object|null} { serviceName, ...metadata }
 */
StateStore.prototype.getByPmId = function(pmId) {
  this.load();

  var services = this.data.services;
  var keys = Object.keys(services);
  pmId = parseInt(pmId, 10);
  for (var i = 0; i < keys.length; i++) {
    if (services[keys[i]].pm_id === pmId) {
      return Object.assign({ serviceName: keys[i] }, services[keys[i]]);
    }
  }
  return null;
};

/**
 * Get all registered services.
 *
 * @returns {Array} Array of { serviceName, pm_id, name, ... }
 */
StateStore.prototype.getAll = function() {
  this.load();

  var services = this.data.services;
  return Object.keys(services).map(function(key) {
    return Object.assign({ serviceName: key }, services[key]);
  });
};

/**
 * Get the count of registered services.
 *
 * @returns {Number}
 */
StateStore.prototype.count = function() {
  this.load();
  return Object.keys(this.data.services).length;
};

/**
 * Clear all state.
 */
StateStore.prototype.clear = function() {
  this._mutate(function(state) {
    state.services = {};
    state.next_id = 1;
  });

  return this;
};

module.exports = StateStore;
