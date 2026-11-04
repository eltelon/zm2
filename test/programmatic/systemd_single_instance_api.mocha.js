'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var API_PATH = require.resolve('../../lib/API');
var COMMON_PATH = require.resolve('../../lib/Common');
var SYSTEMD_PATH = require.resolve('../../lib/Systemd');
var STATE_STORE_PATH = require.resolve('../../lib/Systemd/StateStore');
var INSTANCE_POLICY_PATH = require.resolve('../../lib/Systemd/InstancePolicy');
var HTTP_API_PATH = require.resolve('../../lib/API/HttpApi');
var SYSTEMD_CLIENT_PATH = require.resolve('../../lib/SystemdClient');
var CONSTANTS_PATH = require.resolve('../../constants');

function clearModules() {
  [
    API_PATH,
    COMMON_PATH,
    SYSTEMD_PATH,
    STATE_STORE_PATH,
    INSTANCE_POLICY_PATH,
    HTTP_API_PATH,
    SYSTEMD_CLIENT_PATH,
    CONSTANTS_PATH
  ].forEach(function(modulePath) {
    delete require.cache[modulePath];
  });
}

function makeApi(home, API) {
  var api = Object.create(API.prototype);
  api.pm2_home = home;
  api.cwd = home;
  api._conf = require(CONSTANTS_PATH);
  api.exitCli = function() {};
  return api;
}

describe('single-instance API service guards', function() {
  var restore;
  var home;
  var collision;
  var calls;
  var API;
  var Common;
  var Systemd;
  var StateStore;
  var api;

  function stub(object, key, value) {
    var original = object[key];
    restore.push(function() { object[key] = original; });
    object[key] = value;
  }

  function registerApi(metadata) {
    var store = new StateStore(path.join(home, 'state.json'));
    store.load();
    store.register('zm2-api', Object.assign({
      name: 'zm2_api',
      script: '/srv/zm2-api.js',
      pm_id: 0
    }, metadata));
  }

  function invoke(subcommand) {
    return new Promise(function(resolve) {
      API.prototype.api.call(api, { subcommand: subcommand }, function(error) {
        resolve(error);
      });
    });
  }

  beforeEach(function() {
    restore = [];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'zm2-single-api-'));
    collision = false;
    calls = [];

    clearModules();
    Common = require(COMMON_PATH);
    Systemd = require(SYSTEMD_PATH);
    StateStore = require(STATE_STORE_PATH);
    API = require(API_PATH);

    stub(Common, 'printOut', function() {});
    stub(Common, 'printError', function() {});
    stub(Common, 'warn', function() {});

    ['unitExists', 'getStatus', 'installUnit', 'start', 'restart', 'stop', 'removeUnit'].forEach(function(method) {
      stub(Systemd, method, function(name) {
        calls.push([method, name]);
        if (method === 'unitExists') return false;
        if (method === 'getStatus') return { ActiveState: 'inactive' };
        return undefined;
      });
    });

    var originalExistsSync = fs.existsSync;
    stub(fs, 'existsSync', function(file) {
      if (collision && file === '/etc/systemd/system/zm2-api@.service') return true;
      return originalExistsSync.apply(fs, arguments);
    });

    api = makeApi(home, API);
  });

  afterEach(function() {
    restore.reverse().forEach(function(fn) { fn(); });
    clearModules();
    fs.rmSync(home, { recursive: true, force: true });
  });

  ['start', 'restart'].forEach(function(subcommand) {
    it('rejects ' + subcommand + ' for legacy count 2 before any effect', async function() {
      registerApi({ instances: 2 });
      var statePath = path.join(home, 'state.json');
      var before = fs.readFileSync(statePath, 'utf8');

      var error = await invoke(subcommand);

      assert.ok(error instanceof Error);
      assert.strictEqual(error.code, 'ZM2_MULTI_INSTANCE_DISABLED');
      assert.match(error.message, /zm2-api/);
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(fs.existsSync(path.join(home, 'api-key')), false);
      assert.strictEqual(fs.readFileSync(statePath, 'utf8'), before);
    });

    it('rejects ' + subcommand + ' when a template unit exists despite count 1', async function() {
      registerApi({ instances: 1 });
      collision = true;
      var statePath = path.join(home, 'state.json');
      var before = fs.readFileSync(statePath, 'utf8');

      var error = await invoke(subcommand);

      assert.ok(error instanceof Error);
      assert.strictEqual(error.code, 'ZM2_MULTI_INSTANCE_DISABLED');
      assert.match(error.message, /zm2-api/);
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(fs.existsSync(path.join(home, 'api-key')), false);
      assert.strictEqual(fs.readFileSync(statePath, 'utf8'), before);
    });
  });
});

describe('single-instance resurrection aggregation', function() {
  var restore;
  var home;
  var dumpPath;
  var started;
  var API;
  var Common;
  var api;

  function stub(object, key, value) {
    var original = object[key];
    restore.push(function() { object[key] = original; });
    object[key] = value;
  }

  function writeDump(entries) {
    fs.writeFileSync(dumpPath, JSON.stringify(entries));
  }

  function invoke() {
    return new Promise(function(resolve) {
      API.prototype.resurrect.call(api, function(error, list) {
        resolve({ error: error, list: list });
      });
    });
  }

  beforeEach(function() {
    restore = [];
    started = [];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'zm2-single-resurrect-'));
    dumpPath = path.join(home, 'dump.zm2');

    clearModules();
    Common = require(COMMON_PATH);
    API = require(API_PATH);

    stub(Common, 'printOut', function() {});
    stub(Common, 'printError', function() {});

    api = makeApi(home, API);
    api._conf = Object.assign({}, require(CONSTANTS_PATH), { DUMP_FILE_PATH: dumpPath });
    api.speedList = function() {
      throw new Error('speedList must not run when resurrection fails');
    };
  });

  afterEach(function() {
    restore.reverse().forEach(function(fn) { fn(); });
    clearModules();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('continues eligible apps and returns an aggregate error when a legacy app is rejected', async function() {
    writeDump([
      { name: 'legacy', pm_exec_path: '/apps/legacy.js', instances: 2 },
      { name: 'healthy', pm_exec_path: '/apps/healthy.js', instances: 1 }
    ]);

    api.start = function(script, opts, cb) {
      started.push(script);
      if (script === '/apps/legacy.js') {
        var error = new Error('Multi-instance activation is disabled for zm2-legacy');
        error.code = 'ZM2_MULTI_INSTANCE_DISABLED';
        return cb(error);
      }
      return cb(null, { pm_id: started.length });
    };

    var result = await invoke();

    assert.ok(result.error instanceof Error);
    assert.match(result.error.message, /legacy/);
    assert.match(result.error.message, /Multi-instance activation is disabled/);
    assert.deepStrictEqual(started, ['/apps/legacy.js', '/apps/healthy.js']);
  });

  it('treats a missing script as a failure while continuing other apps', async function() {
    writeDump([
      { name: 'missing' },
      { name: 'healthy', pm_exec_path: '/apps/healthy.js' }
    ]);

    api.start = function(script, opts, cb) {
      started.push(script);
      return cb(null, { pm_id: started.length });
    };

    var result = await invoke();

    assert.ok(result.error instanceof Error);
    assert.match(result.error.message, /missing/);
    assert.match(result.error.message, /no script/i);
    assert.deepStrictEqual(started, ['/apps/healthy.js']);
  });

  it('returns success when every dumped app resurrects', async function() {
    writeDump([
      { name: 'one', pm_exec_path: '/apps/one.js' },
      { name: 'two', pm_exec_path: '/apps/two.js' }
    ]);

    api.start = function(script, opts, cb) {
      started.push(script);
      return cb(null, { pm_id: started.length });
    };

    var result = await invoke();

    assert.strictEqual(result.error, null);
    assert.deepStrictEqual(started, ['/apps/one.js', '/apps/two.js']);
    assert.strictEqual(result.list.length, 2);
  });

  it('exits nonzero from the CLI branch when resurrection fails', function(done) {
    writeDump([{ name: 'legacy', pm_exec_path: '/apps/legacy.js', instances: 2 }]);

    api.start = function(script, opts, cb) {
      var error = new Error('Multi-instance activation is disabled for zm2-legacy');
      error.code = 'ZM2_MULTI_INSTANCE_DISABLED';
      return cb(error);
    };
    api.exitCli = function(code) {
      try {
        assert.strictEqual(code, require(CONSTANTS_PATH).ERROR_EXIT);
        done();
      } catch (error) {
        done(error);
      }
    };

    API.prototype.resurrect.call(api);
  });
});
