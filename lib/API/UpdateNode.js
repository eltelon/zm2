/**
 * Copyright 2024 the ZM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

'use strict';

var Table = require('cli-tableau');

var Common = require('../Common.js');
var cst = require('../../constants.js');

var WARNING_LINES = [
  'Updating Node.js restarts running applications one by one; expect downtime.',
  'Native addons built for the previous Node.js ABI may need an explicit npm rebuild; this is not automatic and zm2 update-node does not rebuild them.',
  'The startup check only verifies that each service remains active with the expected executable; it is not an HTTP or functional health check.'
];

var STATUS_LABELS = {
  updated: 'updated',
  skipped: 'skipped',
  failed_unchanged: 'failed, unchanged',
  failed_restored: 'failed, restored',
  failed_restore: 'failed, restore failed',
  not_updated: 'not updated'
};

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function errorText(error) {
  if (!error) return 'Unknown update-node error';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

function sanitize(value) {
  return text(value)
    .replace(/\u0000/g, '')
    .replace(/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/gi, '$1=[REDACTED]')
    .replace(/((?:--|-)(?:password|passwd|token|secret|api-key|apikey)(?:=|\s+))("[^"]*"|'[^']*'|[^\s]+)/gi, '$1[REDACTED]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/=-]+/gi, '$1 [REDACTED]');
}

function fallbackReport(version, error) {
  return {
    requestedVersion: text(version),
    runtime: null,
    globalError: sanitize(errorText(error)),
    results: [],
    totals: { updated: 0, skipped: 0, failed: 0, notUpdated: 0 },
    exitCode: 1
  };
}

function serviceLabel(row) {
  var service = text(row.serviceName);
  if (row.name && row.name !== row.serviceName)
    service += ' (' + text(row.name) + ')';
  return service;
}

var SAFE_UNIT = /^[A-Za-z0-9:_.@-]+$/;

function shellQuote(value) {
  return "'" + text(value).replace(/'/g, "'\\''") + "'";
}

function cleanServiceName(serviceName) {
  return text(serviceName).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

function serviceUnit(serviceName) {
  var service = cleanServiceName(serviceName) || 'zm2-<service>';
  if (!/\.service$/.test(service)) service += '.service';
  return service;
}

function serviceBase(serviceName) {
  var service = cleanServiceName(serviceName);
  if (/\.service$/.test(service)) service = service.slice(0, -'.service'.length);
  var at = service.indexOf('@');
  if (at !== -1) service = service.slice(0, at);
  return service || 'zm2-<service>';
}

function journalUnit(unit) {
  return SAFE_UNIT.test(unit) ? unit : shellQuote(unit);
}

function journalCommand(serviceName) {
  var unit = serviceUnit(serviceName);
  var templateUnit = serviceBase(serviceName) + '@*.service';
  return 'journalctl -u ' + journalUnit(unit) + ' -u ' + journalUnit(templateUnit);
}

function requestedVersionFor(row, report) {
  if (row.status === 'skipped' && row.previousVersion === null) return '';
  return text(report.requestedVersion);
}

function previousVersionFor(row) {
  if (row.previousVersion) return text(row.previousVersion);
  if (row.status === 'skipped') return '';
  return 'unknown';
}

function resultLabel(row) {
  var label = STATUS_LABELS[row.status] || text(row.status) || 'unknown';
  var reason = row.reason ? sanitize(row.reason) : '';

  if (row.status === 'updated') {
    if (row.stopped)
      label += '; remains stopped; startup not verified';
    else if (!row.startupVerified)
      label += '; startup not verified';
  }
  else if (row.status === 'failed_restored') {
    label += ' to ' + (row.previousVersion ? text(row.previousVersion) : 'previous runtime');
  }

  if (reason) label += ': ' + reason;
  return label;
}

function printWarning() {
  Common.printOut(cst.PREFIX_MSG_WARNING + WARNING_LINES.join('\n'));
}

function printDetails(report) {
  (report.results || []).forEach(function(row) {
    if (row.status === 'updated' || row.status === 'skipped') return;

    Common.printError(cst.PREFIX_MSG_ERR + 'Service ' + serviceLabel(row) + ': ' + sanitize(row.reason || row.status));
    (row.errors || []).forEach(function(message) {
      Common.printError('  error: ' + sanitize(message));
    });
    (row.rollbackErrors || []).forEach(function(message) {
      Common.printError('  rollback error: ' + sanitize(message));
    });
    Common.printOut('  journal: ' + journalCommand(row.serviceName));
  });
}

function printReport(report) {
  var requested = text(report.requestedVersion);

  Common.printOut(cst.PREFIX_MSG + 'Requested Node.js version: ' + (requested || '(none)'));

  if (report.runtime) {
    Common.printOut(cst.PREFIX_MSG + 'Prepared Node.js runtime: ' + text(report.runtime.version) +
      ' (' + text(report.runtime.executable) + ')');
  }
  else if (!report.globalError) {
    Common.printOut(cst.PREFIX_MSG + 'Node.js runtime: not prepared');
  }

  if (report.globalError)
    Common.printError(cst.PREFIX_MSG_ERR + sanitize(report.globalError));

  var table = new Table({
    head: ['Service', 'Previous', 'Requested', 'Result'],
    style: { head: ['cyan', 'bold'], compact: true }
  });

  (report.results || []).forEach(function(row) {
    table.push([
      serviceLabel(row),
      previousVersionFor(row),
      requestedVersionFor(row, report),
      resultLabel(row)
    ]);
  });

  Common.printOut(table.toString());
  printDetails(report);

  var totals = report.totals || {};
  Common.printOut(cst.PREFIX_MSG + 'Totals: updated=' + (totals.updated || 0) +
    ', skipped=' + (totals.skipped || 0) +
    ', failed=' + (totals.failed || 0) +
    ', notUpdated=' + (totals.notUpdated || 0));
}

function complete(that, report, callback) {
  if (typeof callback === 'function') {
    var error = null;
    if (report.exitCode !== 0) {
      error = new Error(report.globalError || 'Node.js runtime update failed');
      error.report = report;
    }
    callback(error, report);
    return;
  }

  printReport(report);
  that.exitCli(report.exitCode === 0 ? cst.SUCCESS_EXIT : cst.ERROR_EXIT);
}

module.exports = function(API) {
  /**
   * Update the Node.js runtime of registered ZM2 applications.
   *
   * With a callback this method never prints or exits: it calls the callback
   * exactly once with (error|null, report). Without a callback it prints the
   * CLI warning and final report, then exits through exitCli exactly once.
   *
   * @param {String} version exact major.minor.patch version, optionally v-prefixed
   * @param {Function} [callback] callback(error|null, report)
   */
  API.prototype.updateNode = function(version, callback) {
    var that = this;
    var hasCallback = typeof callback === 'function';

    if (!hasCallback) printWarning();

    var updater;
    try {
      // Defer operational dependencies until a command actually runs.
      var NodeRuntimeUpdater = require('../Systemd/NodeRuntimeUpdater');
      updater = new NodeRuntimeUpdater({
        stateStore: that.Client.stateStore,
        pm2Home: that.pm2_home,
        pm2HomeExplicit: that._pm2HomeExplicit === true
      });
    } catch (e) {
      return complete(that, fallbackReport(version, e), callback);
    }

    var result;
    try {
      result = updater.run(version);
    } catch (e) {
      return complete(that, fallbackReport(version, e), callback);
    }

    Promise.resolve(result).then(function(report) {
      complete(that, report, callback);
    }, function(e) {
      complete(that, fallbackReport(version, e), callback);
    });
  };
};
