'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var Module = require('module');
var os = require('os');
var path = require('path');
var util = require('util');

var cst = require('../../constants');
var Common = require('../../lib/Common');

var ROOT = path.join(__dirname, '../..');

function plain(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}

function makeRow(overrides) {
  return Object.assign({
    serviceName: 'zm2-app',
    name: 'app',
    previousVersion: '24.8.0',
    status: 'updated',
    stopped: false,
    startupVerified: true,
    reason: null,
    errors: [],
    rollbackErrors: []
  }, overrides || {});
}

function makeReport(overrides) {
  return Object.assign({
    requestedVersion: '26.12.1',
    runtime: {
      version: '26.12.1',
      executable: '/home/deploy/.nvm/versions/node/v26.12.1/bin/node',
      binDir: '/home/deploy/.nvm/versions/node/v26.12.1/bin'
    },
    globalError: null,
    results: [],
    totals: { updated: 0, skipped: 0, failed: 0, notUpdated: 0 },
    exitCode: 0
  }, overrides || {});
}

function flush() {
  return new Promise(function(resolve) {
    setImmediate(resolve);
  });
}

describe('update-node API extension', function() {
  var UpdateNode;
  var API;
  var api;
  var calls;
  var original;
  var updaterClass;

  before(function() {
    UpdateNode = require('../../lib/API/UpdateNode');
  });

  beforeEach(function() {
    original = {
      load: Module._load,
      printOut: Common.printOut,
      printError: Common.printError,
      log: console.log,
      error: console.error
    };

    calls = {
      output: [],
      print: [],
      exit: [],
      exitOutput: null,
      callbacks: [],
      runVersions: [],
      warningAtRun: null
    };
    updaterClass = null;

    Module._load = function(request, parent, isMain) {
      if (updaterClass && /NodeRuntimeUpdater(?:\.js)?$/.test(request))
        return updaterClass;
      return original.load.apply(this, arguments);
    };

    Common.printOut = function() {
      var line = util.format.apply(util, arguments);
      calls.output.push(line);
      calls.print.push({ level: 'out', line: line });
    };
    Common.printError = function() {
      var line = util.format.apply(util, arguments);
      calls.output.push(line);
      calls.print.push({ level: 'error', line: line });
    };
    console.log = function() {
      var line = util.format.apply(util, arguments);
      calls.output.push(line);
      calls.print.push({ level: 'console', line: line });
    };
    console.error = console.log;

    API = function() {};
    UpdateNode(API);
    api = new API();
    api.Client = { stateStore: { marker: 'store' } };
    api.pm2_home = '/tmp/zm2-update-node-home';
    api._pm2HomeExplicit = false;
    api.exitCli = function(code) {
      calls.exit.push(code);
      calls.exitOutput = calls.output.slice();
    };
  });

  afterEach(function() {
    Module._load = original.load;
    Common.printOut = original.printOut;
    Common.printError = original.printError;
    console.log = original.log;
    console.error = original.error;
  });

  function installUpdater(handler) {
    function FakeUpdater(options) {
      this.options = options;
      FakeUpdater.options.push(options);
    }
    FakeUpdater.options = [];
    FakeUpdater.prototype.run = function(version) {
      calls.runVersions.push(version);
      calls.warningAtRun = calls.output.join('\n');
      return handler(version);
    };
    updaterClass = FakeUpdater;
    return FakeUpdater;
  }

  function invokeWithCallback(version) {
    return new Promise(function(resolve) {
      api.updateNode(version, function(err, report) {
        calls.callbacks.push({ err: err, report: report });
        resolve();
      });
    });
  }

  it('passes the client state store, ZM2 home and home provenance to the updater', function() {
    var report = makeReport();
    var FakeUpdater = installUpdater(function() {
      return Promise.resolve(report);
    });

    return invokeWithCallback('26.12.1').then(flush).then(function() {
      assert.strictEqual(FakeUpdater.options.length, 1);
      assert.strictEqual(FakeUpdater.options[0].stateStore, api.Client.stateStore);
      assert.strictEqual(FakeUpdater.options[0].pm2Home, api.pm2_home);
      assert.strictEqual(FakeUpdater.options[0].pm2HomeExplicit, false);
      assert.strictEqual(FakeUpdater.options[0].rollback, true);
      assert.deepStrictEqual(calls.runVersions, ['26.12.1']);
    });
  });

  it('accepts rollback options without breaking callback mode', function() {
    var report = makeReport({
      results: [makeRow({ status: 'failed_no_rollback', startupVerified: false, errors: ['restart failed'] })],
      totals: { updated: 0, skipped: 0, failed: 1, notUpdated: 0 },
      exitCode: 1
    });
    var FakeUpdater = installUpdater(function() { return Promise.resolve(report); });
    api.updateNode('26.12.1', { rollback: false }, function(err, result) {
      calls.callbacks.push({ err: err, report: result });
    });
    return flush().then(function() {
      assert.strictEqual(FakeUpdater.options[0].rollback, false);
      assert.strictEqual(calls.callbacks.length, 1);
      assert.ok(calls.callbacks[0].err instanceof Error);
      assert.strictEqual(calls.callbacks[0].report, report);
      assert.deepStrictEqual(calls.print, []);
      assert.deepStrictEqual(calls.exit, []);
    });
  });

  it('warns and reports retained configuration without claiming a successful startup', function() {
    var report = makeReport({
      results: [makeRow({
        status: 'failed_no_rollback', startupVerified: false,
        reason: 'instance zm2-app: startup verification failed: MainPID changed',
        errors: ['MainPID changed']
      })],
      totals: { updated: 0, skipped: 0, failed: 1, notUpdated: 0 },
      exitCode: 1
    });
    installUpdater(function() { return Promise.resolve(report); });
    api.updateNode('26.12.1', { rollback: false });
    return flush().then(function() {
      assert.match(calls.warningAtRun, /rollback.*disabled/i);
      var output = plain(calls.output.join('\n'));
      assert.match(output, /configuration updated; startup failed; no rollback/);
      assert.match(output, /MainPID changed/);
      assert.doesNotMatch(output, /restored to/);
      assert.match(output, /failed=1/);
      assert.deepStrictEqual(calls.exit, [cst.ERROR_EXIT]);
    });
  });

  it('forwards explicit home provenance to the updater', function() {
    var report = makeReport();
    var FakeUpdater = installUpdater(function() {
      return Promise.resolve(report);
    });
    api._pm2HomeExplicit = true;

    return invokeWithCallback('26.12.1').then(flush).then(function() {
      assert.strictEqual(FakeUpdater.options.length, 1);
      assert.strictEqual(FakeUpdater.options[0].pm2HomeExplicit, true);
    });
  });

  it('lets the real sudo guard refuse a guessed API home before StateStore load', function() {
    var RealUpdater = require('../../lib/Systemd/NodeRuntimeUpdater');
    var captured = null;
    var loadCalls = 0;
    var stateStore = {
      filePath: '/root/.zm2/state.json',
      load: function() {
        loadCalls += 1;
        return this;
      },
      getAll: function() { return []; },
      register: function() {}
    };
    var nvm = {
      validateVersion: function(version) { return version; },
      prepare: function() { throw new Error('nvm.prepare must not run'); }
    };
    var systemd = {
      isSystemd: function() { return true; }
    };

    updaterClass = function(options) {
      captured = options;
      var real = new RealUpdater({
        stateStore: options.stateStore,
        pm2Home: options.pm2Home,
        pm2HomeExplicit: options.pm2HomeExplicit,
        platform: 'linux',
        isSystemd: true,
        env: {
          NVM_DIR: '/home/deploy/.nvm',
          HOME: '/home/deploy',
          SUDO_USER: 'deploy'
        },
        effectiveUser: 'root',
        nvm: nvm,
        systemd: systemd
      });
      this.run = function(version) {
        return real.run(version);
      };
    };

    api.Client = { stateStore: stateStore };
    api.pm2_home = '/root/.zm2';
    api._pm2HomeExplicit = false;

    return invokeWithCallback('20.11.1').then(flush).then(function() {
      assert.ok(captured);
      assert.strictEqual(captured.pm2Home, '/root/.zm2');
      assert.strictEqual(captured.pm2HomeExplicit, false);
      assert.strictEqual(loadCalls, 0);
      assert.strictEqual(calls.callbacks.length, 1);
      assert.ok(calls.callbacks[0].err instanceof Error);
      assert.match(calls.callbacks[0].report.globalError, /sudo|ZM2_HOME|pm2Home/i);
      assert.strictEqual(calls.callbacks[0].report.exitCode, 1);
    });
  });

  it('passes a successful report to the callback once without output or exit', function() {
    var report = makeReport({
      results: [makeRow({ serviceName: 'zm2-web', name: 'web' })],
      totals: { updated: 1, skipped: 0, failed: 0, notUpdated: 0 }
    });
    installUpdater(function() {
      return Promise.resolve(report);
    });

    return invokeWithCallback('26.12.1').then(flush).then(function() {
      assert.strictEqual(calls.callbacks.length, 1);
      assert.strictEqual(calls.callbacks[0].err, null);
      assert.strictEqual(calls.callbacks[0].report, report);
      assert.deepStrictEqual(calls.exit, []);
      assert.deepStrictEqual(calls.print, []);
    });
  });

  it('returns an error callback with the complete global failure report', function() {
    var report = makeReport({
      runtime: null,
      globalError: 'StateStore is corrupt: /tmp/home/state.json',
      results: [makeRow({
        serviceName: 'zm2-app',
        name: 'app',
        previousVersion: null,
        status: 'not_updated',
        stopped: false,
        startupVerified: false,
        reason: 'global runtime preparation failed'
      })],
      totals: { updated: 0, skipped: 0, failed: 0, notUpdated: 1 },
      exitCode: 1
    });
    installUpdater(function() {
      return Promise.resolve(report);
    });

    return invokeWithCallback('26.12.1').then(flush).then(function() {
      assert.strictEqual(calls.callbacks.length, 1);
      assert.ok(calls.callbacks[0].err instanceof Error);
      assert.strictEqual(calls.callbacks[0].err.message, report.globalError);
      assert.strictEqual(calls.callbacks[0].report, report);
      assert.deepStrictEqual(calls.exit, []);
      assert.deepStrictEqual(calls.print, []);
    });
  });

  it('returns an error callback for a partial application failure', function() {
    var report = makeReport({
      results: [
        makeRow({ serviceName: 'zm2-web', name: 'web' }),
        makeRow({
          serviceName: 'zm2-worker',
          name: 'worker',
          status: 'failed_unchanged',
          startupVerified: false,
          reason: 'systemctl restart failed',
          errors: ['restart failed: /etc/systemd/system/zm2-worker.service']
        })
      ],
      totals: { updated: 1, skipped: 0, failed: 1, notUpdated: 0 },
      exitCode: 1
    });
    installUpdater(function() {
      return Promise.resolve(report);
    });

    return invokeWithCallback('26.12.1').then(flush).then(function() {
      assert.strictEqual(calls.callbacks.length, 1);
      assert.ok(calls.callbacks[0].err instanceof Error);
      assert.strictEqual(calls.callbacks[0].report, report);
      assert.deepStrictEqual(calls.exit, []);
      assert.deepStrictEqual(calls.print, []);
    });
  });

  it('returns an error callback when rollback failed, even if another app updated', function() {
    var report = makeReport({
      results: [
        makeRow({ serviceName: 'zm2-web', name: 'web' }),
        makeRow({
          serviceName: 'zm2-worker',
          name: 'worker',
          previousVersion: null,
          status: 'failed_restore',
          startupVerified: false,
          reason: 'restore incomplete',
          errors: ['restart failed'],
          rollbackErrors: ['file restore failed: /etc/systemd/system/zm2-worker.service']
        })
      ],
      totals: { updated: 1, skipped: 0, failed: 1, notUpdated: 0 },
      exitCode: 1
    });
    installUpdater(function() {
      return Promise.resolve(report);
    });

    return invokeWithCallback('26.12.1').then(flush).then(function() {
      assert.strictEqual(calls.callbacks.length, 1);
      assert.ok(calls.callbacks[0].err instanceof Error);
      assert.strictEqual(calls.callbacks[0].report, report);
      assert.deepStrictEqual(calls.callbacks[0].report.results[1].errors, ['restart failed']);
      assert.deepStrictEqual(calls.callbacks[0].report.results[1].rollbackErrors,
        ['file restore failed: /etc/systemd/system/zm2-worker.service']);
      assert.deepStrictEqual(calls.exit, []);
      assert.deepStrictEqual(calls.print, []);
    });
  });

  it('converts an unexpected rejected updater promise into a global error report', function() {
    installUpdater(function() {
      return Promise.reject(new Error('updater exploded at /etc/systemd/system/zm2-app.service'));
    });

    return invokeWithCallback('26.12.1').then(flush).then(function() {
      assert.strictEqual(calls.callbacks.length, 1);
      assert.ok(calls.callbacks[0].err instanceof Error);
      var report = calls.callbacks[0].report;
      assert.strictEqual(report.requestedVersion, '26.12.1');
      assert.strictEqual(report.runtime, null);
      assert.ok(report.globalError.indexOf('updater exploded') !== -1);
      assert.ok(report.globalError.indexOf('/etc/systemd/system/zm2-app.service') !== -1);
      assert.deepStrictEqual(report.results, []);
      assert.deepStrictEqual(report.totals, { updated: 0, skipped: 0, failed: 0, notUpdated: 0 });
      assert.strictEqual(report.exitCode, 1);
      assert.deepStrictEqual(calls.exit, []);
      assert.deepStrictEqual(calls.print, []);
    });
  });

  it('prints a fallback global error and exits 1 when the updater rejects without a callback', function() {
    installUpdater(function() {
      return Promise.reject(new Error('unexpected failure at /etc/systemd/system/zm2-app.service'));
    });

    api.updateNode('26.12.1');

    return flush().then(function() {
      var text = plain(calls.output.join('\n'));
      assert.deepStrictEqual(calls.exit, [cst.ERROR_EXIT]);
      assert.ok(text.indexOf('unexpected failure') !== -1);
      assert.ok(text.indexOf('/etc/systemd/system/zm2-app.service') !== -1);
      assert.strictEqual((text.match(/Totals:/g) || []).length, 1);
      assert.ok(/Totals:.*notUpdated=0/.test(text));
    });
  });

  it('prints the warning before running and one final report before exiting 0', function() {
    var report = makeReport({
      results: [makeRow({ serviceName: 'zm2-web', name: 'web' })],
      totals: { updated: 1, skipped: 0, failed: 0, notUpdated: 0 }
    });
    installUpdater(function() {
      return Promise.resolve(report);
    });

    api.updateNode('26.12.1');

    return flush().then(function() {
      var warning = plain(calls.warningAtRun);
      var text = plain(calls.output.join('\n'));
      assert.ok(/native addons/i.test(warning));
      assert.ok(/npm rebuild/i.test(warning));
      assert.ok(/not automatic/i.test(warning));
      assert.ok(/downtime/i.test(warning));
      assert.ok(/health check/i.test(warning));
      assert.ok(/startup/i.test(warning));
      assert.deepStrictEqual(calls.exit, [cst.SUCCESS_EXIT]);
      assert.strictEqual(calls.exitOutput.length, calls.output.length);
      assert.ok(text.indexOf('26.12.1') !== -1);
      assert.ok(text.indexOf('zm2-web') !== -1);
      assert.ok(/updated/i.test(text));
      assert.strictEqual((text.match(/Totals:/g) || []).length, 1);
      assert.ok(/Totals:.*updated=1/.test(text));
      assert.ok(/Totals:.*skipped=0/.test(text));
      assert.ok(/Totals:.*failed=0/.test(text));
      assert.ok(/Totals:.*notUpdated=0/.test(text));
    });
  });

  it('prints actionable failures, rollback errors and journal commands before exiting 1', function() {
    var report = makeReport({
      results: [
        makeRow({
          serviceName: 'zm2-broken',
          name: 'broken',
          status: 'failed_unchanged',
          startupVerified: false,
          reason: 'systemctl restart failed',
          errors: ['restart failed: /etc/systemd/system/zm2-broken.service PASSWORD=hunter2']
        }),
        makeRow({
          serviceName: 'zm2-restorefail',
          name: 'restorefail',
          previousVersion: null,
          status: 'failed_restore',
          startupVerified: false,
          reason: 'rollback could not restore unit',
          errors: ['write failed at /etc/zm2/env/zm2-restorefail.env'],
          rollbackErrors: ['restore failed at /etc/systemd/system/zm2-restorefail.service']
        })
      ],
      totals: { updated: 0, skipped: 0, failed: 2, notUpdated: 0 },
      exitCode: 1
    });
    installUpdater(function() {
      return Promise.resolve(report);
    });

    api.updateNode('26.12.1');

    return flush().then(function() {
      var text = plain(calls.output.join('\n'));
      assert.deepStrictEqual(calls.exit, [cst.ERROR_EXIT]);
      assert.ok(text.indexOf('systemctl restart failed') !== -1);
      assert.ok(text.indexOf('rollback could not restore unit') !== -1);
      assert.ok(text.indexOf('/etc/systemd/system/zm2-broken.service') !== -1);
      assert.ok(text.indexOf('/etc/zm2/env/zm2-restorefail.env') !== -1);
      assert.ok(text.indexOf('/etc/systemd/system/zm2-restorefail.service') !== -1);
      assert.ok(text.indexOf('rollback error') !== -1);
      assert.ok(text.indexOf('journalctl -u zm2-broken.service') !== -1);
      assert.ok(text.indexOf('journalctl -u zm2-restorefail.service') !== -1);
      assert.ok(text.indexOf('hunter2') === -1);
      assert.ok(text.indexOf('PASSWORD=[REDACTED]') !== -1);
      assert.strictEqual((text.match(/Totals:/g) || []).length, 1);
    });
  });

  it('emits journal commands covering both the normal unit and quoted template instances', function() {
    var report = makeReport({
      results: [
        makeRow({
          serviceName: 'zm2-worker',
          name: 'worker',
          status: 'failed_unchanged',
          startupVerified: false,
          reason: 'instance zm2-worker@1.service failed to restart',
          errors: ['restart failed for zm2-worker@1.service']
        })
      ],
      totals: { updated: 0, skipped: 0, failed: 1, notUpdated: 0 },
      exitCode: 1
    });
    installUpdater(function() {
      return Promise.resolve(report);
    });

    api.updateNode('26.12.1');

    return flush().then(function() {
      var text = plain(calls.output.join('\n'));
      assert.deepStrictEqual(calls.exit, [cst.ERROR_EXIT]);
      assert.ok(text.indexOf('zm2-worker@1.service') !== -1);
      assert.ok(text.indexOf("journalctl -u zm2-worker.service -u 'zm2-worker@*.service'") !== -1);
      assert.ok(text.indexOf('journalctl -u zm2-worker.service -u zm2-worker@*.service') === -1);
    });
  });

  it('quotes untrusted service names in journal commands', function() {
    var report = makeReport({
      results: [
        makeRow({
          serviceName: 'zm2 bad; echo pwn',
          name: 'bad-metadata',
          status: 'failed_unchanged',
          startupVerified: false,
          reason: 'invalid unit metadata'
        })
      ],
      totals: { updated: 0, skipped: 0, failed: 1, notUpdated: 0 },
      exitCode: 1
    });
    installUpdater(function() {
      return Promise.resolve(report);
    });

    api.updateNode('26.12.1');

    return flush().then(function() {
      var text = plain(calls.output.join('\n'));
      assert.ok(text.indexOf("journalctl -u 'zm2 bad; echo pwn.service' -u 'zm2 bad; echo pwn@*.service'") !== -1);
    });
  });

  it('renders every status, stopped and mixed templates, versions and totals', function() {
    var report = makeReport({
      results: [
        makeRow({ serviceName: 'zm2-web', name: 'web' }),
        makeRow({
          serviceName: 'zm2-scheduler',
          name: 'scheduler',
          stopped: true,
          startupVerified: false
        }),
        makeRow({
          serviceName: 'zm2-python',
          name: 'python',
          previousVersion: null,
          status: 'skipped',
          startupVerified: false,
          reason: 'interpreter is not Node'
        }),
        makeRow({
          serviceName: 'zm2-already',
          name: 'already',
          previousVersion: '26.12.1',
          status: 'skipped',
          reason: 'runtime already configured'
        }),
        makeRow({
          serviceName: 'zm2-unchanged',
          name: 'unchanged',
          status: 'failed_unchanged',
          startupVerified: false,
          reason: 'unit not writable',
          errors: ['permission denied: /etc/systemd/system/zm2-unchanged.service']
        }),
        makeRow({
          serviceName: 'zm2-restored',
          name: 'restored',
          status: 'failed_restored',
          startupVerified: false,
          reason: 'startup verification failed',
          errors: ['verification failed']
        }),
        makeRow({
          serviceName: 'zm2-restorefailed',
          name: 'restorefailed',
          previousVersion: null,
          status: 'failed_restore',
          startupVerified: false,
          reason: 'restore incomplete',
          errors: ['restart failed'],
          rollbackErrors: ['file restore failed: /etc/systemd/system/zm2-restorefailed.service']
        }),
        makeRow({
          serviceName: 'zm2-pending',
          name: 'pending',
          status: 'not_updated',
          startupVerified: false,
          reason: 'nvm preparation failed'
        }),
        makeRow({
          serviceName: 'zm2-worker',
          name: 'worker',
          status: 'updated',
          reason: 'stopped instance(s) zm2-worker@3 were not started or verified'
        })
      ],
      totals: { updated: 2, skipped: 2, failed: 3, notUpdated: 1 },
      exitCode: 1
    });
    installUpdater(function() {
      return Promise.resolve(report);
    });

    api.updateNode('26.12.1');

    return flush().then(function() {
      var text = plain(calls.output.join('\n'));
      var lines = text.split('\n');

      function rowLine(serviceName) {
        return lines.filter(function(line) {
          return line.indexOf(serviceName) !== -1;
        })[0] || '';
      }

      assert.deepStrictEqual(calls.exit, [cst.ERROR_EXIT]);
      ['zm2-web', 'zm2-scheduler', 'zm2-python', 'zm2-already', 'zm2-unchanged',
        'zm2-restored', 'zm2-restorefailed', 'zm2-pending', 'zm2-worker'].forEach(function(name) {
        assert.ok(text.indexOf(name) !== -1, 'missing service ' + name);
      });
      assert.ok(/remains stopped/i.test(rowLine('zm2-scheduler')));
      assert.ok(/startup not verified/i.test(rowLine('zm2-scheduler')));
      assert.ok(/stopped instance\(s\)/i.test(rowLine('zm2-worker')));
      assert.ok(/not .*verified/i.test(rowLine('zm2-worker')));
      assert.ok(rowLine('zm2-python').indexOf('26.12.1') === -1);
      assert.ok(/interpreter is not Node/i.test(rowLine('zm2-python')));
      assert.ok(/runtime already configured/i.test(rowLine('zm2-already')));
      assert.ok(/failed, unchanged/i.test(rowLine('zm2-unchanged')));
      assert.ok(/unit not writable/i.test(rowLine('zm2-unchanged')));
      assert.ok(/restored to 24.8.0/i.test(rowLine('zm2-restored')));
      assert.ok(/failed, restore failed/i.test(rowLine('zm2-restorefailed')));
      assert.ok(rowLine('zm2-restorefailed').indexOf('restored to') === -1);
      assert.ok(/not updated/i.test(rowLine('zm2-pending')));
      assert.ok(/nvm preparation failed/i.test(rowLine('zm2-pending')));
      assert.ok(text.indexOf('24.8.0') !== -1);
      assert.ok(text.indexOf('26.12.1') !== -1);
      assert.ok(text.indexOf('journalctl -u zm2-unchanged.service') !== -1);
      assert.ok(text.indexOf('journalctl -u zm2-restored.service') !== -1);
      assert.ok(text.indexOf('journalctl -u zm2-restorefailed.service') !== -1);
      assert.ok(/Totals: updated=2/.test(text));
      assert.ok(/Totals:.*skipped=2/.test(text));
      assert.ok(/Totals:.*failed=3/.test(text));
      assert.ok(/Totals:.*notUpdated=1/.test(text));
      assert.strictEqual((text.match(/Totals:/g) || []).length, 1);
    });
  });

  it('exits 0 when all eligible applications were updated or skipped', function() {
    var report = makeReport({
      results: [
        makeRow({ serviceName: 'zm2-web', name: 'web' }),
        makeRow({
          serviceName: 'zm2-python',
          name: 'python',
          previousVersion: null,
          status: 'skipped',
          startupVerified: false,
          reason: 'interpreter is not Node'
        })
      ],
      totals: { updated: 1, skipped: 1, failed: 0, notUpdated: 0 },
      exitCode: 0
    });
    installUpdater(function() {
      return Promise.resolve(report);
    });

    api.updateNode('26.12.1');

    return flush().then(function() {
      assert.deepStrictEqual(calls.exit, [cst.SUCCESS_EXIT]);
    });
  });
});

describe('update-node CLI and public declarations', function() {
  var home;

  before(function() {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'zm2-update-node-cli-'));
  });

  after(function() {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function runCli(args) {
    var script = [
      "var Module = require('module');",
      "var originalLoad = Module._load;",
      "function FakeAPI() { this.pm2_home = process.env.ZM2_HOME; }",
      "FakeAPI.prototype.connect = function(cb) { process.nextTick(function() { cb(null, {}); }); };",
      "FakeAPI.prototype.getVersion = function(cb) { cb(null, require('./package.json').version); };",
      "FakeAPI.prototype.updateNode = function(version, options) {",
      "  console.log('UPDATE:' + JSON.stringify({ version: version, options: options }));",
      "  process.exit(0);",
      "};",
      "Module._load = function(request, parent, isMain) {",
      "  if (request === '../API.js') return FakeAPI;",
      "  return originalLoad.apply(this, arguments);",
      "};",
      "process.argv = ['node', 'bin/zm2'].concat(" + JSON.stringify(args) + ");",
      "require('./lib/binaries/CLI');"
    ].join('\n');

    return childProcess.spawnSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { ZM2_HOME: home, PM2_HOME: home }),
      encoding: 'utf8',
      timeout: 10000
    });
  }

  function runApiProvenance(opts, envOverrides) {
    var script = [
      "process.env.ZM2_PROGRAMMATIC = 'true';",
      "var API = require('./lib/API.js');",
      "var api = new API(" + JSON.stringify(opts || {}) + ");",
      "console.log('PROVENANCE:' + JSON.stringify({ flag: api._pm2HomeExplicit === true, home: api.pm2_home }));"
    ].join('\n');
    var env = Object.assign({}, process.env);
    delete env.ZM2_HOME;
    delete env.PM2_HOME;
    delete env.OVER_HOME;
    Object.keys(envOverrides || {}).forEach(function(key) {
      if (envOverrides[key] === undefined) delete env[key];
      else env[key] = envOverrides[key];
    });
    env.ZM2_PROGRAMMATIC = 'true';

    var result = childProcess.spawnSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: env,
      encoding: 'utf8',
      timeout: 10000
    });
    assert.strictEqual(result.status, 0, result.stderr || String(result.error));
    var lines = result.stdout.split('\n').filter(function(line) {
      return line.indexOf('PROVENANCE:') === 0;
    });
    assert.strictEqual(lines.length, 1, result.stdout);
    return JSON.parse(lines[0].slice('PROVENANCE:'.length));
  }

  function updateMarkers(result) {
    return result.stdout.split('\n').filter(function(line) {
      return line.indexOf('UPDATE:') === 0;
    }).map(function(line) {
      return JSON.parse(line.slice('UPDATE:'.length));
    });
  }

  it('records explicit provenance for ZM2_HOME, PM2_HOME and programmatic homes', function() {
    var envHome = path.join(home, 'env-home');
    var pm2EnvHome = path.join(home, 'pm2-env-home');
    var guessedHome = path.join(home, 'guessed-home');
    var explicitHome = path.join(home, 'explicit-home');
    var explicitEnvHome = path.join(home, 'explicit-env-home');
    fs.mkdirSync(envHome, { recursive: true });
    fs.mkdirSync(pm2EnvHome, { recursive: true });
    fs.mkdirSync(guessedHome, { recursive: true });
    fs.mkdirSync(explicitEnvHome, { recursive: true });

    var byZm2Home = runApiProvenance({}, { HOME: guessedHome, ZM2_HOME: envHome });
    assert.deepStrictEqual(byZm2Home, { flag: true, home: envHome });
    assert.strictEqual(fs.existsSync(path.join(guessedHome, '.zm2')), false);

    var byPm2Home = runApiProvenance({}, { HOME: guessedHome, PM2_HOME: pm2EnvHome });
    assert.deepStrictEqual(byPm2Home, { flag: true, home: pm2EnvHome });
    assert.strictEqual(fs.existsSync(path.join(guessedHome, '.zm2')), false);

    var guessed = runApiProvenance({}, { HOME: guessedHome });
    assert.deepStrictEqual(guessed, {
      flag: false,
      home: path.join(guessedHome, '.zm2')
    });

    var explicit = runApiProvenance(
      { pm2_home: explicitHome },
      { HOME: guessedHome, ZM2_HOME: explicitEnvHome }
    );
    assert.deepStrictEqual(explicit, { flag: true, home: explicitHome });
    assert.strictEqual(fs.existsSync(path.join(explicitEnvHome, 'module_conf.json')), false);
  });

  it('records independent instances as non-explicit even with ZM2_HOME set', function() {
    var envHome = path.join(home, 'independent-env-home');
    var guessedHome = path.join(home, 'independent-guessed-home');
    fs.mkdirSync(envHome, { recursive: true });
    fs.mkdirSync(guessedHome, { recursive: true });

    var independent = runApiProvenance(
      { independent: true },
      { HOME: guessedHome, ZM2_HOME: envHome }
    );

    try {
      assert.strictEqual(independent.flag, false);
      assert.notStrictEqual(independent.home, envHome);
      assert.strictEqual(path.dirname(independent.home), '/tmp');
      assert.match(path.basename(independent.home), /^[0-9a-f]{16}$/);
      assert.strictEqual(fs.existsSync(path.join(envHome, 'module_conf.json')), false);
      assert.strictEqual(fs.existsSync(path.join(guessedHome, '.zm2')), false);
    } finally {
      try {
        fs.rmSync(independent.home, { recursive: true, force: true });
      } catch (e) {
        /* ignore cleanup errors */
      }
    }
  });

  it('parses an exact version and passes it to the API once', function() {
    var result = runCli(['update-node', '26.12.1']);
    assert.strictEqual(result.status, 0, result.stderr || String(result.error));
    assert.deepStrictEqual(updateMarkers(result), [{ version: '26.12.1', options: { rollback: true } }]);
  });

  it('passes --no-rollback to the API as rollback false', function() {
    var result = runCli(['update-node', '26.12.1', '--no-rollback']);
    assert.strictEqual(result.status, 0, result.stderr || String(result.error));
    assert.deepStrictEqual(updateMarkers(result), [{ version: '26.12.1', options: { rollback: false } }]);
  });

  it('lets the updater validate a non-exact version instead of installing from the CLI', function() {
    var result = runCli(['update-node', 'lts']);
    assert.strictEqual(result.status, 0, result.stderr || String(result.error));
    assert.deepStrictEqual(updateMarkers(result), [{ version: 'lts', options: { rollback: true } }]);
  });

  it('fails in Commander before calling the API when the version is missing', function() {
    var result = runCli(['update-node']);
    assert.strictEqual(result.status, cst.ERROR_EXIT);
    assert.deepStrictEqual(updateMarkers(result), []);
    assert.ok(/missing required argument/i.test(result.stderr));
  });

  it('registers update-node before the catch-all command', function() {
    var source = fs.readFileSync(path.join(ROOT, 'lib/binaries/CLI.js'), 'utf8');
    var updateIndex = source.indexOf("command('update-node <version>')");
    var catchIndex = source.indexOf("command('*')");
    assert.ok(updateIndex !== -1, 'update-node command is not registered');
    assert.ok(catchIndex !== -1, 'catch-all command is missing');
    assert.ok(updateIndex < catchIndex, 'update-node must be registered before the catch-all');
  });

  it('loads the UpdateNode extension from lib/API.js', function() {
    var source = fs.readFileSync(path.join(ROOT, 'lib/API.js'), 'utf8');
    assert.ok(/require\('\.\/API\/UpdateNode(?:\.js)?'\)\(API\)/.test(source));
  });

  it('declares the public method, callback and report types', function() {
    var source = fs.readFileSync(path.join(ROOT, 'types/index.d.ts'), 'utf8');
    assert.ok(/export function updateNode\s*\(/.test(source));
    assert.ok(/interface UpdateNodeRuntime/.test(source));
    assert.ok(/interface UpdateNodeResult/.test(source));
    assert.ok(/interface UpdateNodeTotals/.test(source));
    assert.ok(/interface UpdateNodeReport/.test(source));
    assert.ok(/interface UpdateNodeOptions/.test(source));
    assert.ok(/updateNode\(version: string, options: UpdateNodeOptions, errback\?: UpdateNodeCallback\)/.test(source));
    assert.ok(source.includes("'failed_no_rollback'"));
    assert.ok(/UpdateNodeCallback\s*=\s*\(err: Error \| null, report: UpdateNodeReport\)/.test(source));
  });
});
