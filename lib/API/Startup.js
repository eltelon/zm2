/**
 * Copyright 2013-2022 the PM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

'use strict';

var chalk  = require('ansis');
var Common = require('../Common.js');
var cst    = require('../../constants.js');
var Systemd = require('../Systemd.js');
var StateStore = require('../Systemd/StateStore.js');
var path = require('path');

module.exports = function(CLI) {

  /**
   * Enable all zm2-managed services to start on boot.
   *
   * @param {String} platform - Ignored (always systemd)
   * @param {Object} opts - Commander options
   * @param {Function} cb
   */
  CLI.prototype.startup = function(platform, opts, cb) {
    var that = this;

    if (!cb) {
      cb = function(err) {
        if (err) return that.exitCli(cst.ERROR_EXIT);
        return that.exitCli(cst.SUCCESS_EXIT);
      };
    }

    if (!Systemd.isSystemd()) {
      Common.printError(cst.PREFIX_MSG_ERR + 'ZM2 requires systemd. /run/systemd/system not found.');
      return cb(new Error('systemd not found'));
    }

    if (process.getuid && process.getuid() !== 0) {
      Common.printOut(cst.PREFIX_MSG + 'To enable startup, run with root:');
      console.log('sudo zm2 startup');
      return cb(new Error('Requires root'));
    }

    var statePath = path.join(that._conf.PM2_ROOT_PATH, 'state.json');
    var store = new StateStore(statePath);
    store.load();

    var entries = store.getAll();
    if (entries.length === 0) {
      Common.printOut(cst.PREFIX_MSG + 'No services to enable. Start some apps first.');
      return cb(null);
    }

    var enabled = 0;
    entries.forEach(function(entry) {
      try {
        if (entry.instances > 1) {
          for (var i = 0; i < entry.instances; i++) {
            Systemd.enable(entry.serviceName + '@' + i);
          }
        } else {
          Systemd.enable(entry.serviceName);
        }
        Common.printOut(cst.PREFIX_MSG + chalk.green('[v] ') + entry.serviceName + ' enabled');
        enabled++;
      } catch (e) {
        Common.printError(cst.PREFIX_MSG_ERR + 'Failed to enable ' + entry.serviceName + ': ' + e.message);
      }
    });

    Common.printOut(cst.PREFIX_MSG + enabled + ' service(s) enabled for boot');
    return cb(null);
  };

  /**
   * Disable all zm2-managed services from starting on boot.
   *
   * @param {String} platform - Ignored (always systemd)
   * @param {Object} opts - Commander options
   * @param {Function} cb
   */
  CLI.prototype.uninstallStartup = function(platform, opts, cb) {
    var that = this;

    if (!cb) {
      cb = function(err) {
        if (err) return that.exitCli(cst.ERROR_EXIT);
        return that.exitCli(cst.SUCCESS_EXIT);
      };
    }

    if (!Systemd.isSystemd()) {
      Common.printError(cst.PREFIX_MSG_ERR + 'ZM2 requires systemd.');
      return cb(new Error('systemd not found'));
    }

    if (process.getuid && process.getuid() !== 0) {
      Common.printOut(cst.PREFIX_MSG + 'To disable startup, run with root:');
      console.log('sudo zm2 unstartup');
      return cb(new Error('Requires root'));
    }

    var statePath = path.join(that._conf.PM2_ROOT_PATH, 'state.json');
    var store = new StateStore(statePath);
    store.load();

    var entries = store.getAll();
    if (entries.length === 0) {
      Common.printOut(cst.PREFIX_MSG + 'No services to disable.');
      return cb(null);
    }

    var disabled = 0;
    entries.forEach(function(entry) {
      try {
        if (entry.instances > 1) {
          for (var i = 0; i < entry.instances; i++) {
            Systemd.disable(entry.serviceName + '@' + i);
          }
        } else {
          Systemd.disable(entry.serviceName);
        }
        Common.printOut(cst.PREFIX_MSG + chalk.green('[v] ') + entry.serviceName + ' disabled');
        disabled++;
      } catch (e) {
        Common.printError(cst.PREFIX_MSG_ERR + 'Failed to disable ' + entry.serviceName + ': ' + e.message);
      }
    });

    Common.printOut(cst.PREFIX_MSG + disabled + ' service(s) disabled');
    return cb(null);
  };
};
