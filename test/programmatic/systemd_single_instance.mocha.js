'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var Systemd = require('../../lib/Systemd');
var Common = require('../../lib/Common');
var StateStore = require('../../lib/Systemd/StateStore');

describe('single-instance migration boundary', function() {
  var restore, home, calls, api, collision;
  var modulePath = require.resolve('../../lib/API/Migrate');
  var originalModule;

  function stub(object, key, value) {
    var old = object[key];
    restore.push(function() { object[key] = old; });
    object[key] = value;
  }

  beforeEach(function() {
    restore = []; calls = []; collision = false;
    // Other suites reload adapters; stub the same module objects Migrate loads.
    Systemd = require('../../lib/Systemd');
    Common = require('../../lib/Common');
    StateStore = require('../../lib/Systemd/StateStore');
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'zm2-single-migrate-'));
    originalModule = require.cache[modulePath];
    stub(process, 'getuid', function() { return 0; });
    stub(Systemd, 'isSystemd', function() { return true; });
    ['installUnit', 'writeEnvFile', 'enable', 'start', 'daemonReload'].forEach(function(method) {
      stub(Systemd, method, function(name, content) { calls.push([method, name, content]); });
    });
    ['printOut', 'printError', 'warn'].forEach(function(method) { stub(Common, method, function() {}); });
    stub(cp, 'execFileSync', function(cmd, args) {
      assert.strictEqual(cmd, 'pm2');
      if (args[0] === 'jlist') return JSON.stringify([{ pm2_env: {
        name: 'app', script: '/apps/app.js', instances: 4, exec_mode: 'cluster_mode', env: { INSTANCES: '4' }
      } }]);
      calls.push(['pm2', args[0]]);
      return '';
    });
    var exists = fs.existsSync;
    stub(fs, 'existsSync', function(file) {
      if (file === '/etc/systemd/system/zm2-app@.service') return collision;
      return exists.apply(fs, arguments);
    });
    var write = fs.writeFileSync;
    stub(fs, 'writeFileSync', function(file) {
      if (String(file).startsWith('/etc/')) {
        calls.push(['writeTemplate', file]);
        return;
      }
      return write.apply(fs, arguments);
    });
    delete require.cache[modulePath];
    function CLI() { this._conf = { PM2_ROOT_PATH: home }; }
    require(modulePath)(CLI);
    api = new CLI();
  });

  afterEach(function() {
    restore.reverse().forEach(function(fn) { fn(); });
    delete require.cache[modulePath];
    if (originalModule) require.cache[modulePath] = originalModule;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('migrates a PM2 cluster into exactly one base service', function(done) {
    api.migrate('app', {}, function(err) {
      try {
        assert.ifError(err);
        assert.ok(!calls.some(function(c) { return c[0] === 'writeTemplate'; }));
        assert.deepStrictEqual(calls.filter(function(c) { return c[0] === 'start'; }), [['start', 'zm2-app', undefined]]);
        var entry = new StateStore(path.join(home, 'state.json')).get('zm2-app');
        assert.strictEqual(entry.instances, 1);
        assert.ok(calls.some(function(c) { return c[0] === 'writeEnvFile' && c[2].includes('INSTANCES=4'); }));
        done();
      } catch (e) { done(e); }
    });
  });

  it('refuses a template collision during forced replacement of real count-one metadata', function(done) {
    collision = true;
    var store = new StateStore(path.join(home, 'state.json'));
    store.register('zm2-app', { name: 'app', instances: 1 });
    var before = fs.readFileSync(path.join(home, 'state.json'), 'utf8');
    api.migrate('app', { force: true }, function(err) {
      try {
        assert.ok(err);
        assert.deepStrictEqual(calls, []);
        assert.strictEqual(fs.readFileSync(path.join(home, 'state.json'), 'utf8'), before);
        done();
      } catch (e) { done(e); }
    });
  });

  it('refuses an existing template before touching units or stopping PM2', function(done) {
    collision = true;
    api.migrate('app', {}, function(err) {
      try {
        assert.ok(err);
        assert.deepStrictEqual(calls, []);
        assert.strictEqual(fs.existsSync(path.join(home, 'state.json')), false);
        done();
      } catch (e) { done(e); }
    });
  });
});
