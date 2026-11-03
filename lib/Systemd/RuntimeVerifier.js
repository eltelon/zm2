/**
 * Copyright 2024 the ZM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

'use strict';

var WINDOW_MS = 5000;
var INTERVAL_MS = 500;

function defaultDelay(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

function verificationError(serviceName, message) {
  var error = new Error('Runtime verification failed for ' + serviceName + ': ' + message);
  error.serviceName = serviceName;
  return error;
}

function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function displayValue(value) {
  return String(value);
}

/**
 * RuntimeVerifier - Observe a restarted systemd service for a short startup
 * window. This is a startup sanity check, not a functional health check.
 *
 * @param {Object} options
 * @param {Object} options.systemd - Provides getStatus(name) and getProcessExecutable(pid)
 * @param {Object} options.fs - Filesystem module used when no realpath resolver is given
 * @param {Function} options.realpath - Synchronous path canonicalizer
 * @param {Function} options.delay - Async delay function receiving milliseconds
 */
function RuntimeVerifier(options) {
  options = options || {};

  var fs = options.fs || require('fs');

  this.systemd = options.systemd || require('../Systemd');
  this.realpath = options.realpath || function(target) {
    return fs.realpathSync(target);
  };
  this.delay = options.delay || defaultDelay;
}

RuntimeVerifier.prototype._readStatus = async function(serviceName) {
  try {
    return await this.systemd.getStatus(serviceName);
  } catch (error) {
    throw verificationError(serviceName,
      'unable to query systemd status: ' + errorMessage(error));
  }
};

RuntimeVerifier.prototype._validateStatus = function(serviceName, status) {
  if (!status || typeof status !== 'object') {
    throw verificationError(serviceName, 'systemd status is missing or invalid');
  }

  if (status.ActiveState !== 'active' || status.SubState !== 'running') {
    throw verificationError(serviceName,
      'expected active/running but found ' +
      displayValue(status.ActiveState) + '/' + displayValue(status.SubState));
  }

  if (!Number.isInteger(status.MainPID) || status.MainPID <= 0) {
    throw verificationError(serviceName,
      'MainPID must be a positive integer, got ' + displayValue(status.MainPID));
  }

  if (!Number.isInteger(status.NRestarts) || status.NRestarts < 0) {
    throw verificationError(serviceName,
      'NRestarts must be a non-negative integer, got ' + displayValue(status.NRestarts));
  }
};

RuntimeVerifier.prototype._readExecutable = async function(serviceName, pid) {
  var executable;

  try {
    executable = await this.systemd.getProcessExecutable(pid);
  } catch (error) {
    throw verificationError(serviceName,
      'unable to read executable for PID ' + pid + ': ' + errorMessage(error));
  }

  if (typeof executable !== 'string' || executable.length === 0) {
    throw verificationError(serviceName,
      'process executable for PID ' + pid + ' is not a valid path');
  }

  return executable;
};

/**
 * Verify that a restarted service stays active/running with a stable PID,
 * unchanged NRestarts counter and the expected executable.
 *
 * The first status read is the post-restart baseline. Samples are taken at
 * time 0 and every 500 ms through 5000 ms inclusive.
 *
 * @param {String} serviceName - systemd unit name without .service
 * @param {String} expectedExecutable - Path to the expected Node executable
 * @returns {Promise<void>}
 */
RuntimeVerifier.prototype.verify = async function(serviceName, expectedExecutable) {
  if (typeof serviceName !== 'string' || serviceName.trim().length === 0) {
    throw new Error('Runtime verification failed: service name must be a non-empty string');
  }

  if (typeof expectedExecutable !== 'string' || expectedExecutable.trim().length === 0) {
    throw verificationError(serviceName,
      'expected executable must be a non-empty string');
  }

  var canonicalExpected;

  try {
    canonicalExpected = this.realpath(expectedExecutable);
  } catch (error) {
    throw verificationError(serviceName,
      'unable to resolve expected executable "' + expectedExecutable + '": ' +
      errorMessage(error));
  }

  if (typeof canonicalExpected !== 'string' || canonicalExpected.length === 0) {
    throw verificationError(serviceName,
      'expected executable resolution returned an invalid path');
  }

  var baseline = null;
  var elapsed = 0;

  while (true) {
    var status = await this._readStatus(serviceName);
    this._validateStatus(serviceName, status);

    if (baseline === null) {
      baseline = {
        pid: status.MainPID,
        restarts: status.NRestarts
      };
    } else {
      if (status.MainPID !== baseline.pid) {
        throw verificationError(serviceName,
          'MainPID changed from ' + baseline.pid + ' to ' + status.MainPID +
          ' during startup verification');
      }

      if (status.NRestarts !== baseline.restarts) {
        throw verificationError(serviceName,
          'NRestarts changed from ' + baseline.restarts + ' to ' + status.NRestarts +
          ' during startup verification');
      }
    }

    var executable = await this._readExecutable(serviceName, status.MainPID);

    if (executable !== canonicalExpected) {
      throw verificationError(serviceName,
        'expected executable ' + canonicalExpected + ' but PID ' + status.MainPID +
        ' runs ' + executable);
    }

    if (elapsed >= WINDOW_MS) {
      return;
    }

    await this.delay(INTERVAL_MS);
    elapsed += INTERVAL_MS;
  }
};

module.exports = RuntimeVerifier;
