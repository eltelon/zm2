/**
 * Copyright 2013-2022 the PM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

var debug  = require('debug')('zm2:conf');
var p      = require('path');
var util   = require('util');
var chalk  = require('ansis');

/**
 * Get PM2 path structure
 */
var path_structure = require('./paths.js')(process.env.OVER_HOME);

/**
 * Constants variables used by PM2
 */
var csts = {
  PREFIX_MSG              : chalk.green('[ZM2] '),
  PREFIX_MSG_INFO         : chalk.cyan('[ZM2][INFO] '),
  PREFIX_MSG_ERR          : chalk.red('[ZM2][ERROR] '),
  PREFIX_MSG_MOD          : chalk.bold.green('[ZM2][Module] '),
  PREFIX_MSG_MOD_ERR      : chalk.red('[ZM2][Module][ERROR] '),
  PREFIX_MSG_WARNING      : chalk.yellow('[ZM2][WARN] '),
  PREFIX_MSG_SUCCESS      : chalk.cyan('[ZM2] '),

  TEMPLATE_FOLDER         : p.join(__dirname, 'lib/templates'),

  APP_CONF_DEFAULT_FILE   : 'ecosystem.config.js',
  APP_CONF_TPL            : 'ecosystem.tpl',
  APP_CONF_TPL_SIMPLE     : 'ecosystem-simple.tpl',
  SAMPLE_CONF_FILE        : 'sample-conf.js',
  LOGROTATE_SCRIPT        : 'logrotate.d/zm2',

  SUCCESS_EXIT            : 0,
  ERROR_EXIT              : 1,
  CODE_UNCAUGHTEXCEPTION  : 1,

  IS_BUN                  : typeof Bun !== 'undefined',
  IS_WINDOWS              : (process.platform === 'win32' || process.platform === 'win64' || /^(msys|cygwin)$/.test(process.env.OSTYPE)),
  ONLINE_STATUS           : 'online',
  STOPPED_STATUS          : 'stopped',
  STOPPING_STATUS         : 'stopping',
  WAITING_RESTART         : 'waiting restart',
  LAUNCHING_STATUS        : 'launching',
  ERRORED_STATUS          : 'errored',
  ONE_LAUNCH_STATUS       : 'one-launch-status',

  SYSTEMD_MODE_ID         : 'systemd',
  SYSTEMD_UNIT_DIR        : '/etc/systemd/system',
  SYSTEMD_ENV_DIR         : '/etc/zm2/env',

  LOW_MEMORY_ENVIRONMENT  : process.env.ZM2_OPTIMIZE_MEMORY || process.env.PM2_OPTIMIZE_MEMORY || false,

  PM2_BANNER       : '../lib/motd',
  DEFAULT_MODULE_JSON     : 'package.json',

  MODULE_BASEFOLDER: 'module',
  MODULE_CONF_PREFIX: 'module-db-v2',
  MODULE_CONF_PREFIX_TAR: 'tar-modules',

  EXP_BACKOFF_RESET_TIMER : parseInt(process.env.EXP_BACKOFF_RESET_TIMER) || 30000,
  RELOAD_LOCK_TIMEOUT     : parseInt(process.env.ZM2_RELOAD_LOCK_TIMEOUT || process.env.PM2_RELOAD_LOCK_TIMEOUT) || 30000,
  GRACEFUL_TIMEOUT        : parseInt(process.env.ZM2_GRACEFUL_TIMEOUT || process.env.PM2_GRACEFUL_TIMEOUT) || 8000,
  GRACEFUL_LISTEN_TIMEOUT : parseInt(process.env.ZM2_GRACEFUL_LISTEN_TIMEOUT || process.env.PM2_GRACEFUL_LISTEN_TIMEOUT) || 3000,
  LOGS_BUFFER_SIZE        : 8,
  CONTEXT_ON_ERROR        : 2,
  AGGREGATION_DURATION    : process.env.ZM2_DEBUG || process.env.PM2_DEBUG || process.env.NODE_ENV === 'local_test' || process.env.NODE_ENV === 'development' ? 3000 : 5 * 60000,
  TRACE_FLUSH_INTERVAL    : process.env.ZM2_DEBUG || process.env.PM2_DEBUG || process.env.NODE_ENV === 'local_test' ? 1000 : 60000,

  // Concurrent actions when doing start/restart/reload
  CONCURRENT_ACTIONS      : (function() {
    var concurrent_actions = parseInt(process.env.ZM2_CONCURRENT_ACTIONS || process.env.PM2_CONCURRENT_ACTIONS) || 2;
    debug('Using %d parallelism (CONCURRENT_ACTIONS)', concurrent_actions);
    return concurrent_actions;
  })(),

  DEBUG                   : process.env.ZM2_DEBUG || process.env.PM2_DEBUG || false,
  WEB_IPADDR              : process.env.ZM2_API_IPADDR || process.env.PM2_API_IPADDR || '0.0.0.0',
  WEB_PORT                : parseInt(process.env.ZM2_API_PORT || process.env.PM2_API_PORT)  || 9615,
  WEB_STRIP_ENV_VARS      : process.env.ZM2_WEB_STRIP_ENV_VARS || process.env.PM2_WEB_STRIP_ENV_VARS || false,
  MODIFY_REQUIRE          : process.env.ZM2_MODIFY_REQUIRE || process.env.PM2_MODIFY_REQUIRE || false,

  WORKER_INTERVAL         : process.env.ZM2_WORKER_INTERVAL || process.env.PM2_WORKER_INTERVAL || 30000,
  KILL_TIMEOUT            : process.env.ZM2_KILL_TIMEOUT || process.env.PM2_KILL_TIMEOUT || 1600,
  KILL_SIGNAL             : process.env.ZM2_KILL_SIGNAL || process.env.PM2_KILL_SIGNAL || 'SIGINT',
  KILL_USE_MESSAGE        : process.env.ZM2_KILL_USE_MESSAGE || process.env.PM2_KILL_USE_MESSAGE || false,

  PM2_PROGRAMMATIC        : typeof(process.env.pm_id) !== 'undefined' || process.env.ZM2_PROGRAMMATIC || process.env.PM2_PROGRAMMATIC,
  PM2_LOG_DATE_FORMAT     : process.env.ZM2_LOG_DATE_FORMAT !== undefined ? process.env.ZM2_LOG_DATE_FORMAT : (process.env.PM2_LOG_DATE_FORMAT !== undefined ? process.env.PM2_LOG_DATE_FORMAT : 'YYYY-MM-DDTHH:mm:ss')

};

module.exports = Object.assign(csts, path_structure);
