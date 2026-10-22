'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var EventEmitter = require('events').EventEmitter;
var fs = require('fs');
var os = require('os');
var path = require('path');
var cst = require('../../constants');
var Common = require('../../lib/Common');

describe('Systemd log line counts', function() {
  var Systemd;
  var Log;
  var api;
  var calls;
  var processes;
  var original;
  var home;

  beforeEach(function() {
    original = {
      spawn: childProcess.spawn,
      execFileSync: childProcess.execFileSync,
      printOut: Common.printOut,
      printError: Common.printError,
      home: cst.PM2_ROOT_PATH
    };
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'zm2-log-lines-'));
    cst.PM2_ROOT_PATH = home;
    calls = { stream: [], print: [], exit: [] };
    processes = [
      { pm2_env: { name: 'app', pm_id: 7, namespace: 'production' } },
      { pm2_env: { name: 'worker', pm_id: 8, namespace: 'production' } },
      { pm2_env: { name: 'other', pm_id: 9, namespace: 'staging' } }
    ];
    childProcess.spawn = function(command, args) {
      assert.strictEqual(command, 'journalctl');
      var proc = { stdout: new EventEmitter(), stderr: new EventEmitter() };
      calls.stream.push({ args: args, proc: proc });
      return proc;
    };
    childProcess.execFileSync = function(command, args) {
      assert.strictEqual(command, 'journalctl');
      calls.print.push(args);
      return '';
    };
    Common.printOut = Common.printError = function() {};

    ['../../lib/Systemd', '../../lib/API/Log', '../../lib/API/LogManagement'].forEach(function(file) {
      delete require.cache[require.resolve(file)];
    });
    Systemd = require('../../lib/Systemd');
    Log = require('../../lib/API/Log');
    function API() {}
    require('../../lib/API/LogManagement')(API);
    api = new API();
    api.Client = {
      executeRemote: function(method, data, callback) {
        assert.strictEqual(method, 'getMonitorData');
        callback(null, processes);
      }
    };
    api.exitCli = function(code) { calls.exit.push(code); };
  });

  afterEach(function() {
    childProcess.spawn = original.spawn;
    childProcess.execFileSync = original.execFileSync;
    Common.printOut = original.printOut;
    Common.printError = original.printError;
    cst.PM2_ROOT_PATH = original.home;
    ['../../lib/Systemd', '../../lib/API/Log', '../../lib/API/LogManagement'].forEach(function(file) {
      delete require.cache[require.resolve(file)];
    });
    fs.rmSync(home, { recursive: true, force: true });
  });

  function argument(args, flag) {
    return args[args.indexOf(flag) + 1];
  }

  [0, 100].forEach(function(lines) {
    it('passes ' + lines + ' to journalctl follow mode', function() {
      Systemd.streamLogs('zm2-app', lines);
      assert.strictEqual(argument(calls.stream[0].args, '-n'), String(lines));
      assert.strictEqual(argument(calls.stream[0].args, '-u'), 'zm2-app.service');
      assert.ok(calls.stream[0].args.includes('-f'));
    });

    it('passes ' + lines + ' to journalctl non-follow mode', function() {
      Systemd.getLogs('zm2-app', lines);
      assert.strictEqual(argument(calls.print[0], '-n'), String(lines));
      assert.ok(!calls.print[0].includes('-f'));
    });

    it('passes ' + lines + ' through the standard log formatter', function() {
      Log.stream(api.Client, 'app', true, false, false, false, lines);
      assert.strictEqual(argument(calls.stream[0].args, '-n'), String(lines));
    });

    ['jsonStream', 'formatStream'].forEach(function(method) {
      it('passes ' + lines + ' through ' + method, function() {
        if (method === 'jsonStream')
          Log.jsonStream(api.Client, 'app', lines);
        else
          Log.formatStream(api.Client, 'app', false, false, false, false, lines);
        assert.strictEqual(argument(calls.stream[0].args, '-n'), String(lines));
      });
    });
  });

  it('preserves low-level default counts when omitted', function() {
    Systemd.streamLogs('zm2-app');
    Systemd.getLogs('zm2-app');
    assert.strictEqual(argument(calls.stream[0].args, '-n'), '20');
    assert.strictEqual(argument(calls.print[0], '-n'), '50');
  });

  it('keeps JSON and formatted programmatic streams live-only by default', function() {
    Log.jsonStream(api.Client, 'app');
    Log.formatStream(api.Client, 'app');
    calls.stream.forEach(function(call) {
      assert.strictEqual(argument(call.args, '-n'), '0');
    });
  });

  it('streams the requested history without relying on custom log paths', function() {
    api.streamLogs('app', 100, true, false, false);
    assert.strictEqual(calls.stream.length, 1);
    assert.strictEqual(argument(calls.stream[0].args, '-n'), '100');
    assert.strictEqual(argument(calls.stream[0].args, '-u'), 'zm2-app.service');
    assert.strictEqual(calls.print.length, 0);
  });

  it('does not replay history separately when legacy log paths exist', function() {
    processes[0].pm2_env.pm_out_log_path = '/old/app-out.log';
    processes[0].pm2_env.pm_err_log_path = '/old/app-error.log';
    api.streamLogs('app', 100, true, false, false);
    assert.strictEqual(calls.print.length, 0);
    assert.strictEqual(calls.stream.length, 1);
    assert.strictEqual(argument(calls.stream[0].args, '-n'), '100');
  });

  it('streams only new entries when zero is requested', function() {
    api.streamLogs('app', 0, true, false, false);
    assert.strictEqual(argument(calls.stream[0].args, '-n'), '0');
    assert.strictEqual(calls.print.length, 0);
  });

  it('preserves the programmatic stream default', function() {
    api.streamLogs('app');
    assert.strictEqual(argument(calls.stream[0].args, '-n'), '20');
  });

  it('selects a service by numeric process id', function() {
    api.streamLogs('7', 100, true, false, false);
    assert.strictEqual(argument(calls.stream[0].args, '-u'), 'zm2-app.service');
    assert.strictEqual(argument(calls.stream[0].args, '-n'), '100');
  });

  it('streams all services with a single history request', function() {
    api.streamLogs('all', 100, true, false, false);
    assert.strictEqual(calls.stream.length, 1);
    assert.strictEqual(argument(calls.stream[0].args, '-u'), 'zm2-*');
    assert.strictEqual(argument(calls.stream[0].args, '-n'), '100');
  });

  ['production', '/app|worker/'].forEach(function(selector) {
    it('streams selected services for ' + selector, function() {
      api.streamLogs(selector, 100, true, false, false);
      assert.deepStrictEqual(calls.stream.map(function(call) {
        assert.strictEqual(argument(call.args, '-n'), '100');
        return argument(call.args, '-u');
      }), ['zm2-app.service', 'zm2-worker.service']);
    });

    it('prints selected services for ' + selector + ' without log paths', function() {
      api.printLogs(selector, 100, true, false, false);
      assert.deepStrictEqual(calls.print.map(function(args) {
        assert.strictEqual(argument(args, '-n'), '100');
        return argument(args, '-u');
      }), ['zm2-app.service', 'zm2-worker.service']);
      assert.strictEqual(calls.stream.length, 0);
      assert.deepStrictEqual(calls.exit, [cst.SUCCESS_EXIT]);
    });
  });

  ['app', '7', 'all'].forEach(function(selector) {
    it('prints the requested history for ' + selector + ' then exits', function() {
      api.printLogs(selector, 100, true, false, false);
      assert.strictEqual(calls.print.length, selector === 'all' ? 3 : 1);
      assert.strictEqual(argument(calls.print[0], '-u'), 'zm2-app.service');
      calls.print.forEach(function(args) {
        assert.strictEqual(argument(args, '-n'), '100');
      });
      assert.strictEqual(calls.stream.length, 0);
      assert.deepStrictEqual(calls.exit, [cst.SUCCESS_EXIT]);
    });
  });

  it('prints nothing and exits for non-streaming zero lines', function() {
    api.printLogs('app', 0, true, false, false);
    assert.strictEqual(calls.print.length, 0);
    assert.strictEqual(calls.stream.length, 0);
    assert.deepStrictEqual(calls.exit, [cst.SUCCESS_EXIT]);
  });

  [[], ['--json'], ['--format'], ['--nostream']].forEach(function(options) {
    [undefined, 0, 100].forEach(function(lines) {
      it('wires CLI line count ' + lines + ' ' + options.join(' ') + ' to journald', function() {
        var args = ['logs', 'app'];
        if (lines !== undefined)
          args = args.concat(['--lines', String(lines)]);
        args = args.concat(options);
        var script = [
          "var events = require('events');",
          "var cp = require('child_process');",
          "cp.spawn = function(command, args) {",
          "  console.log('JOURNAL:' + JSON.stringify({ follow: true, args: args }));",
          "  return { stdout: new events.EventEmitter(), stderr: new events.EventEmitter() };",
          "};",
          "cp.execFileSync = function(command, args) {",
          "  console.log('JOURNAL:' + JSON.stringify({ follow: false, args: args }));",
          "  return '';",
          "};",
          "require('./lib/Systemd').isSystemd = function() { return true; };",
          "require('./lib/SystemdClient').prototype._getMonitorData = function(cb) {",
          "  cb(null, [{ pm2_env: { name: 'app', pm_id: 7, namespace: 'default' } }]);",
          "};",
          "process.argv = ['node', 'bin/zm2'].concat(" + JSON.stringify(args) + ");",
          "require('./lib/binaries/CLI');"
        ].join('\n');
        var result = childProcess.spawnSync(process.execPath, ['-e', script], {
          cwd: path.join(__dirname, '../..'),
          env: Object.assign({}, process.env, { ZM2_HOME: home, PM2_HOME: home }),
          encoding: 'utf8',
          timeout: 10000
        });
        assert.strictEqual(result.status, 0, result.stderr || String(result.error));
        var requests = result.stdout.split('\n').filter(function(line) {
          return line.indexOf('JOURNAL:') === 0;
        }).map(function(line) { return JSON.parse(line.slice('JOURNAL:'.length)); });
        if (options.includes('--nostream') && lines === 0)
          return assert.strictEqual(requests.length, 0);
        assert.strictEqual(requests.length, 1, result.stdout);
        assert.strictEqual(requests[0].follow, !options.includes('--nostream'));
        assert.strictEqual(argument(requests[0].args, '-n'), String(lines !== undefined ? lines : 15));
        assert.strictEqual(argument(requests[0].args, '-u'), 'zm2-app.service');
      });
    });
  });

  it('does not start a journal request after a monitor error', function() {
    api.Client.executeRemote = function(method, data, callback) {
      callback(new Error('monitor unavailable'));
    };
    api.streamLogs('app', 100, true, false, false);
    assert.strictEqual(calls.stream.length, 0);
    assert.deepStrictEqual(calls.exit, [cst.ERROR_EXIT]);
  });
});
