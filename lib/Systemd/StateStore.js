/**
 * Copyright 2024 the ZM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

function defaultState() {
  return { services: {}, next_id: 1 };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  var prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidId(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * StateStore - Manages ZM2 metadata that systemd doesn't track.
 * Persisted as JSON at ~/.zm2/state.json
 *
 * @param {String} filePath - Path to state.json
 */
function StateStore(filePath) {
  this.filePath = filePath;
  this.data = null;
}

/**
 * Load state from disk. Creates default state if file doesn't exist.
 *
 * By default corrupt or unreadable state is tolerated and replaced with an
 * empty state. With { strict: true }, corrupt JSON, read errors and invalid
 * structures are thrown instead.
 *
 * @param {Object} [options]
 * @param {Boolean} [options.strict=false]
 */
StateStore.prototype.load = function(options) {
  var strict = !!(options && options.strict);
  var parsed;

  try {
    var raw = fs.readFileSync(this.filePath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      this.data = defaultState();
      return this;
    }
    if (strict) throw e;
    // Corrupted or unreadable file — start fresh
    this.data = defaultState();
    return this;
  }

  if (strict) {
    validateState(parsed);
    this.data = parsed;
    return this;
  }

  // Ensure structure
  if (!isPlainObject(parsed)) parsed = defaultState();
  this.data = parsed;
  if (!isPlainObject(this.data.services)) this.data.services = {};
  // ID 0 is reserved for zm2-api; user apps start at 1
  if (typeof this.data.next_id !== 'number' || this.data.next_id < 1) this.data.next_id = 1;

  return this;
};

/**
 * Write state to disk atomically through an exclusive temporary file in the
 * same directory. Existing mode/ownership are preserved and the temporary
 * file is removed if any step fails.
 *
 * @param {Object} data
 */
StateStore.prototype._writeData = function(data) {
  var dir = path.dirname(this.filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  var existing = null;
  try {
    existing = fs.statSync(this.filePath);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }

  var mode = existing ? (existing.mode & 0o7777) : 0o666;
  var tempPath = path.join(
    dir,
    '.' + path.basename(this.filePath) + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
  );
  var fd = null;

  try {
    fd = fs.openSync(tempPath, 'wx', mode);
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');

    if (existing) {
      var created = fs.fstatSync(fd);
      if (created.uid !== existing.uid || created.gid !== existing.gid) {
        fs.fchownSync(fd, existing.uid, existing.gid);
      }
      fs.fchmodSync(fd, mode);
    }

    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, this.filePath);
  } catch (e) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (closeError) { /* ignore */ }
    }
    try { fs.unlinkSync(tempPath); } catch (unlinkError) { /* ignore */ }
    throw e;
  }
};

/**
 * Save current state to disk.
 */
StateStore.prototype.save = function() {
  this._writeData(this.data);
  return this;
};

/**
 * Replace an existing service entry completely. The supplied metadata is
 * stored as-is (including pm_id and timestamps) so callers can restore an
 * exact snapshot without merging stale fields.
 *
 * @param {String} serviceName - Systemd unit name (e.g. "zm2-myapp")
 * @param {Object} metadata - Complete replacement metadata
 * @returns {StateStore} this
 */
StateStore.prototype.replace = function(serviceName, metadata) {
  if (!this.data) this.load();

  if (!Object.prototype.hasOwnProperty.call(this.data.services, serviceName)) {
    throw new Error('Cannot replace missing service: ' + serviceName);
  }
  if (!isPlainObject(metadata)) {
    throw new TypeError('Service metadata must be an object');
  }

  var nextData = cloneJson(this.data);
  nextData.services[serviceName] = cloneJson(metadata);

  this._writeData(nextData);
  this.data = nextData;
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
  if (!this.data) this.load();

  // If already registered, update metadata but keep pm_id
  if (this.data.services[serviceName]) {
    var existing = this.data.services[serviceName];
    Object.assign(existing, metadata);
    existing.updated_at = Date.now();
    this.save();
    return existing.pm_id;
  }

  // Allow caller to pin a specific pm_id (e.g. zm2-api reserves 0)
  var pm_id = (typeof metadata.pm_id === 'number') ? metadata.pm_id : this.data.next_id++;
  this.data.services[serviceName] = Object.assign({}, metadata, {
    pm_id: pm_id,
    created_at: Date.now(),
    updated_at: Date.now()
  });

  this.save();
  return pm_id;
};

/**
 * Unregister a service.
 *
 * @param {String} serviceName
 */
StateStore.prototype.unregister = function(serviceName) {
  if (!this.data) this.load();
  delete this.data.services[serviceName];
  this.save();
  return this;
};

/**
 * Get service metadata by systemd unit name.
 *
 * @param {String} serviceName
 * @returns {Object|null}
 */
StateStore.prototype.get = function(serviceName) {
  if (!this.data) this.load();
  return this.data.services[serviceName] || null;
};

/**
 * Find service by app name (not the full systemd unit name).
 *
 * @param {String} name - App name (e.g. "myapp")
 * @returns {Object|null} { serviceName, ...metadata }
 */
StateStore.prototype.getByName = function(name) {
  if (!this.data) this.load();
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
  if (!this.data) this.load();
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
  if (!this.data) this.load();
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
  if (!this.data) this.load();
  return Object.keys(this.data.services).length;
};

/**
 * Clear all state.
 */
StateStore.prototype.clear = function() {
  this.data = defaultState();
  this.save();
  return this;
};

module.exports = StateStore;
