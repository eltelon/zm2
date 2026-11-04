'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var Startup = require('../../lib/API/Startup');
var Systemd = require('../../lib/Systemd');
var StateStore = require('../../lib/Systemd/StateStore');
var Common = require('../../lib/Common');

function makeMetadata(overrides) {
  return Object.assign({
    name: 'app',
    script: '/srv/app/main.js',
    cwd: '/srv/app',
    instances: 1,
    exec_interpreter: 'node'
  }, overrides || {});
}

function createHome(entries) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'zm2-single-ops-'));
  var store = new StateStore(path.join(root, 'state.json'));
  store.load();

  entries.forEach(function(entry) {
    store.register(entry.serviceName, makeMetadata(entry.metadata));
  });

  return root;
}

function createCli(home) {
  function CLI() {
    this._conf = { PM2_ROOT_PATH: home };
  }

  Startup(CLI);
  return new CLI();
}

function invoke(cli, method) {
  return new Promise(function(resolve) {
    cli[method]('linux', {}, function(error) {
      resolve(error);
    });
  });
}

describe('single-instance startup operations', function() {
  var homes;
  var calls;
  var original;

  beforeEach(function() {
    homes = [];
    calls = { enable: [], disable: [] };
    original = {
      isSystemd: Systemd.isSystemd,
      enable: Systemd.enable,
      disable: Systemd.disable,
      getuid: process.getuid,
      printOut: Common.printOut,
      printError: Common.printError
    };

    Systemd.isSystemd = function() { return true; };
    Systemd.enable = function(name) { calls.enable.push(name); };
    Systemd.disable = function(name) { calls.disable.push(name); };
    process.getuid = function() { return 0; };
    Common.printOut = function() {};
    Common.printError = function() {};
  });

  afterEach(function() {
    Systemd.isSystemd = original.isSystemd;
    Systemd.enable = original.enable;
    Systemd.disable = original.disable;
    process.getuid = original.getuid;
    Common.printOut = original.printOut;
    Common.printError = original.printError;

    homes.forEach(function(home) {
      fs.rmSync(home, { recursive: true, force: true });
    });
  });

  it('enables eligible singles, skips legacy counts and reports an aggregate failure', async function() {
    var home = createHome([
      { serviceName: 'zm2-single', metadata: { name: 'single' } },
      { serviceName: 'zm2-legacy', metadata: { name: 'legacy', instances: 2 } }
    ]);
    homes.push(home);

    var error = await invoke(createCli(home), 'startup');

    assert.ok(error instanceof Error);
    assert.match(error.message, /zm2-legacy/);
    assert.deepStrictEqual(calls.enable, ['zm2-single']);
    assert.strictEqual(calls.enable.indexOf('zm2-legacy@0'), -1);
    assert.strictEqual(calls.enable.indexOf('zm2-legacy@1'), -1);
  });

  it('does not enable an instance alias even when its count is one', async function() {
    var home = createHome([
      { serviceName: 'zm2-worker@1', metadata: { name: 'worker' } },
      { serviceName: 'zm2-single', metadata: { name: 'single' } }
    ]);
    homes.push(home);

    var error = await invoke(createCli(home), 'startup');

    assert.ok(error instanceof Error);
    assert.match(error.message, /zm2-worker@1/);
    assert.deepStrictEqual(calls.enable, ['zm2-single']);
  });

  it('reports an enable failure while continuing with remaining singles', async function() {
    var home = createHome([
      { serviceName: 'zm2-broken', metadata: { name: 'broken' } },
      { serviceName: 'zm2-single', metadata: { name: 'single' } }
    ]);
    homes.push(home);
    Systemd.enable = function(name) {
      calls.enable.push(name);
      if (name === 'zm2-broken') throw new Error('enable rejected by systemd');
    };

    var error = await invoke(createCli(home), 'startup');

    assert.ok(error instanceof Error);
    assert.match(error.message, /zm2-broken/);
    assert.match(error.message, /enable rejected by systemd/);
    assert.deepStrictEqual(calls.enable, ['zm2-broken', 'zm2-single']);
  });

  it('returns success when every entry is a single instance', async function() {
    var home = createHome([
      { serviceName: 'zm2-one', metadata: { name: 'one' } },
      { serviceName: 'zm2-two', metadata: { name: 'two' } }
    ]);
    homes.push(home);

    var error = await invoke(createCli(home), 'startup');

    assert.strictEqual(error, null);
    assert.deepStrictEqual(calls.enable, ['zm2-one', 'zm2-two']);
  });

  it('keeps unstartup disabling every legacy template instance', async function() {
    var home = createHome([
      { serviceName: 'zm2-single', metadata: { name: 'single' } },
      { serviceName: 'zm2-legacy', metadata: { name: 'legacy', instances: 2 } }
    ]);
    homes.push(home);

    var error = await invoke(createCli(home), 'uninstallStartup');

    assert.strictEqual(error, null);
    assert.deepStrictEqual(calls.disable, [
      'zm2-single',
      'zm2-legacy@0',
      'zm2-legacy@1'
    ]);
  });
});