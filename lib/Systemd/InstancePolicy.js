'use strict';

var fs = require('fs');
var path = require('path');

/** Accept legacy instance-count options, but create only one service per app. */
function normalize(conf, warn) {
  var count = conf.instances;
  if (count !== undefined && count !== 1 && count !== '1' && warn) {
    warn('instances=' + String(count) + ' is ignored; ZM2 runs a single instance per application.');
  }
  conf.instances = 1;
}

/** Reject legacy activation without losing the metadata needed for removal. */
function assertSingle(entry, options) {
  options = options || {};
  var name = entry.serviceName || '';
  var filesystem = options.fs || fs;
  var unitDir = options.unitDir || '/etc/systemd/system';
  var baseName = name.replace(/\.service$/, '');
  if (Number(entry.instances) > 1 || name.indexOf('@') !== -1 ||
      (baseName && filesystem.existsSync(path.join(unitDir, baseName + '@.service')))) {
    var error = new Error('Multi-instance activation is disabled for ' + name +
      '. Explicitly stop, delete and recreate the application as a single service (requires downtime).');
    error.code = 'ZM2_MULTI_INSTANCE_DISABLED';
    throw error;
  }
}

module.exports = { normalize: normalize, assertSingle: assertSingle };
