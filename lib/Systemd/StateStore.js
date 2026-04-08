/**
 * Copyright 2024 the ZM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

'use strict';

var fs = require('fs');
var path = require('path');

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
 */
StateStore.prototype.load = function() {
  try {
    if (fs.existsSync(this.filePath)) {
      var raw = fs.readFileSync(this.filePath, 'utf8');
      this.data = JSON.parse(raw);
    } else {
      this.data = { services: {}, next_id: 1 };
    }
  } catch (e) {
    // Corrupted file — start fresh
    this.data = { services: {}, next_id: 1 };
  }

  // Ensure structure
  if (!this.data.services) this.data.services = {};
  // ID 0 is reserved for zm2-api; user apps start at 1
  if (typeof this.data.next_id !== 'number' || this.data.next_id < 1) this.data.next_id = 1;

  return this;
};

/**
 * Save current state to disk.
 */
StateStore.prototype.save = function() {
  var dir = path.dirname(this.filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
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
  this.data = { services: {}, next_id: 1 };
  this.save();
  return this;
};

module.exports = StateStore;
