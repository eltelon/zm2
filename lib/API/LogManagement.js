var chalk  = require('ansis');
var util   = require('util');
var fs     = require('fs');
var exec   = require('child_process').exec;
var path   = require('path');

var Log    = require('./Log');
var cst    = require('../../constants.js');
var Common = require('../Common.js');

/**
 * Select journal services using monitor metadata, without custom log file paths.
 */
function selectLogApps(list, id) {
  var regex = typeof id === 'string' && id[0] === '/' && id[id.length - 1] === '/'
    ? new RegExp(id.slice(1, -1)) : null;
  var seen = Object.create(null);
  var apps = [];

  list.forEach(function(proc) {
    var env = proc.pm2_env;
    if (!env || !env.name) return;
    if (id !== 'all' && env.name != id && env.pm_id != id &&
        env.namespace != id && !(regex && regex.test(env.name))) return;
    if (seen[env.name]) return;
    seen[env.name] = true;
    apps.push({ app_name: env.name, type: 'out' });
  });

  return apps;
}

module.exports = function(CLI) {

  /**
   * Description
   * @method flush
   * @return
   */
  CLI.prototype.flush = function(api, cb) {
    var that = this;

    if (!api) {
      Common.printOut(cst.PREFIX_MSG + 'Flushing ' + cst.PM2_LOG_FILE_PATH);
      fs.closeSync(fs.openSync(cst.PM2_LOG_FILE_PATH, 'w'));
    }

    that.Client.executeRemote('getMonitorData', {}, function(err, list) {
      if (err) {
        Common.printError(err);
        return cb ? cb(Common.retErr(err)) : that.exitCli(cst.ERROR_EXIT);
      }
      list.forEach(function(l) {
        if (typeof api == 'undefined') {
          Common.printOut(cst.PREFIX_MSG + 'Flushing:');
          Common.printOut(cst.PREFIX_MSG + l.pm2_env.pm_out_log_path);
          Common.printOut(cst.PREFIX_MSG + l.pm2_env.pm_err_log_path);

          if (l.pm2_env.pm_log_path) {
            Common.printOut(cst.PREFIX_MSG + l.pm2_env.pm_log_path);
            fs.closeSync(fs.openSync(l.pm2_env.pm_log_path, 'w'));
          }
          fs.closeSync(fs.openSync(l.pm2_env.pm_out_log_path, 'w'));
          fs.closeSync(fs.openSync(l.pm2_env.pm_err_log_path, 'w'));
        }
        else if (l.pm2_env.pm_id == api || l.pm2_env.name === api) {
          Common.printOut(cst.PREFIX_MSG + 'Flushing:');

          if (l.pm2_env.pm_log_path && fs.existsSync(l.pm2_env.pm_log_path)) {
            Common.printOut(cst.PREFIX_MSG + l.pm2_env.pm_log_path);
            fs.closeSync(fs.openSync(l.pm2_env.pm_log_path, 'w'));
          }

          if (l.pm2_env.pm_out_log_path && fs.existsSync(l.pm2_env.pm_out_log_path)) {
            Common.printOut(cst.PREFIX_MSG + l.pm2_env.pm_out_log_path);
            fs.closeSync(fs.openSync(l.pm2_env.pm_out_log_path, 'w'));
          }

          if (l.pm2_env.pm_err_log_path && fs.existsSync(l.pm2_env.pm_err_log_path)) {
            Common.printOut(cst.PREFIX_MSG + l.pm2_env.pm_err_log_path);
            fs.closeSync(fs.openSync(l.pm2_env.pm_err_log_path, 'w'));
          }
        }
      });

      Common.printOut(cst.PREFIX_MSG + 'Logs flushed');
      return cb ? cb(null, list) : that.exitCli(cst.SUCCESS_EXIT);
    });
  };

  CLI.prototype.logrotate = function(opts, cb) {
    var that = this;

    if (process.getuid() != 0) {
      return exec('whoami', function(err, stdout, stderr) {
        Common.printError(cst.PREFIX_MSG + 'You have to run this command as root. Execute the following command:');
        Common.printError(cst.PREFIX_MSG + chalk.gray('      sudo env PATH=$PATH:' + path.dirname(process.execPath) + ' zm2 logrotate -u ' + stdout.trim()));

        cb ? cb(Common.retErr('You have to run this with elevated rights')) : that.exitCli(cst.ERROR_EXIT);
      });
    }

    if (!fs.existsSync('/etc/logrotate.d')) {
      Common.printError(cst.PREFIX_MSG + '/etc/logrotate.d does not exist we can not copy the default configuration.');
      return cb ? cb(Common.retErr('/etc/logrotate.d does not exist')) : that.exitCli(cst.ERROR_EXIT);
    }

    var templatePath = path.join(cst.TEMPLATE_FOLDER, cst.LOGROTATE_SCRIPT);
    Common.printOut(cst.PREFIX_MSG + 'Getting logrorate template ' + templatePath);
    var script = fs.readFileSync(templatePath, {encoding: 'utf8'});

    var user = opts.user || 'root';

    script = script.replace(/%HOME_PATH%/g, cst.PM2_ROOT_PATH)
      .replace(/%USER%/g, user);

    try {
      fs.writeFileSync('/etc/logrotate.d/zm2-'+user, script);
    } catch (e) {
      console.error(e.stack || e);
    }

    Common.printOut(cst.PREFIX_MSG + 'Logrotate configuration added to /etc/logrotate.d/zm2-' + user);
    return cb ? cb(null, {success:true}) : that.exitCli(cst.SUCCESS_EXIT);
  };

  /**
   * Description
   * @method reloadLogs
   * @return
   */
  CLI.prototype.reloadLogs = function(cb) {
    var that = this;

    Common.printOut('Reloading all logs...');
    that.Client.executeRemote('reloadLogs', {}, function(err, logs) {
      if (err) {
        Common.printError(err);
        return cb ? cb(Common.retErr(err)) : that.exitCli(cst.ERROR_EXIT);
      }
      Common.printOut('All logs reloaded');
      return cb ? cb(null, logs) : that.exitCli(cst.SUCCESS_EXIT);
    });
  };

  /**
   * Show recent journal entries and follow new entries in a single request.
   * @param {String} id - Name, process id, namespace, regex, or 'all'
   * @param {Number} lines - Initial entries (default 20, zero for live-only)
   * @param {Boolean} raw
   */
  CLI.prototype.streamLogs = function(id, lines, raw, timestamp, exclusive, highlight) {
    var that = this;
    id = id || 'all';
    lines = lines !== undefined ? Math.abs(lines) : 20;

    that.Client.executeRemote('getMonitorData', {}, function(err, list) {
      if (err) {
        Common.printError(err);
        return that.exitCli(cst.ERROR_EXIT);
      }

      if (lines > 0)
        Common.printOut(chalk.bold.gray(util.format('[TAILING] Tailing last %d lines for [%s] process%s (change the value with --lines option)', lines, id, id === 'all' ? 'es' : '')));

      // journalctl supplies both history and live output, without replaying a tail.
      if (id === 'all')
        return Log.stream(that.Client, id, raw, timestamp, exclusive, highlight, lines);

      var apps = selectLogApps(list, id);
      if (apps.length === 0)
        return Log.stream(that.Client, id, raw, timestamp, exclusive, highlight, lines);

      apps.forEach(function(app) {
        Log.stream(that.Client, app.app_name, raw, timestamp, exclusive, highlight, lines);
      });
    });
  };

  /**
   * Print recent journal entries without following.
   * @param {String} id - Name, process id, namespace, regex, or 'all'
   * @param {Number} lines - Entries per service (default 20)
   * @param {Boolean} raw
   */
  CLI.prototype.printLogs = function(id, lines, raw, timestamp, exclusive) {
    var that = this;
    id = id || 'all';
    lines = lines !== undefined ? Math.abs(lines) : 20;

    that.Client.executeRemote('getMonitorData', {}, function(err, list) {
      if (err) {
        Common.printError(err);
        return that.exitCli(cst.ERROR_EXIT);
      }

      if (lines === 0)
        return that.exitCli(cst.SUCCESS_EXIT);

      Common.printOut(chalk.bold.gray(util.format('[TAILING] Tailing last %d lines for [%s] process%s (change the value with --lines option)', lines, id, id === 'all' ? 'es' : '')));

      Log.tail(selectLogApps(list, id), lines, raw, function() {
        that.exitCli(cst.SUCCESS_EXIT);
      });
    });
  };
};
