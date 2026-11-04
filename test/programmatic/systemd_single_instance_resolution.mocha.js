'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

// Real StateStore and selector dispatch: no synthetic metadata identities.
describe('single-instance identity boundaries', function() {
  var restore, calls, home, client, api, Systemd, store;
  function stub(object, key, value) {
    var original = object[key];
    restore.push(function() { object[key] = original; });
    object[key] = value;
  }

  beforeEach(function() {
    restore = []; calls = [];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'zm2-instance-resolution-'));
    Systemd = require('../../lib/Systemd');
    var StateStore = require('../../lib/Systemd/StateStore');
    delete require.cache[require.resolve('../../lib/SystemdClient')];
    var Client = require('../../lib/SystemdClient');
    var API = require('../../lib/API');
    var Common = require('../../lib/Common');
    stub(require('../../lib/API/Modules/Modularizer'), 'getAdditionalConf', function() { return {}; });
    store = new StateStore(path.join(home, 'state.json'));
    store.register('zm2-api', { name: 'zm2_api', pm_id: 0, instances: 1 });
    client = Object.create(Client.prototype);
    client.stateStore = store;
    api = Object.create(API.prototype);
    api.Client = client;
    api.pm2_configuration = {};
    ['enable', 'start', 'restart', 'reload', 'stop', 'disable', 'writeEnvFile', 'installUnit',
      'daemonReload', 'installTimer', 'removeUnit', 'removeTemplateUnit'].forEach(function(method) {
      stub(Systemd, method, function(name) { calls.push([method, name]); });
    });
    stub(Systemd, 'listUnits', function() { return [{ name: 'zm2-worker@0' }]; });
    // unitExists checks files: instantiated units only have an @.service template.
    stub(Systemd, 'unitExists', function(name) { return name === 'zm2-worker@'; });
    stub(Systemd, 'getStatusBulk', function() { return {}; });
    stub(Systemd, 'getStatus', function() { return { ActiveState: 'inactive', MainPID: 0 }; });
    stub(Common, 'printOut', function() {});
    stub(Common, 'printError', function() {});
  });

  afterEach(function() {
    restore.reverse().forEach(function(fn) { fn(); });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('rejects a template collision with real count-one metadata before prepare writes', function(done) {
    store.register('zm2-worker', { name: 'worker', instances: 1 });
    assert.strictEqual(store.get('zm2-worker').serviceName, undefined);
    var before = fs.readFileSync(path.join(home, 'state.json'), 'utf8');
    var exists = fs.existsSync;
    stub(fs, 'existsSync', function(file) {
      return file === '/etc/systemd/system/zm2-worker@.service' || exists(file);
    });
    client._prepare({ name: 'worker', pm_exec_path: __filename, exec_interpreter: process.execPath }, function(err) {
      try {
        assert.ok(err);
        assert.strictEqual(err.code, 'ZM2_MULTI_INSTANCE_DISABLED');
        assert.deepStrictEqual(calls, []);
        assert.strictEqual(fs.readFileSync(path.join(home, 'state.json'), 'utf8'), before);
        done();
      } catch (error) { done(error); }
    });
  });

  ['startProcessId', 'restartProcessId', 'reloadProcessId'].forEach(function(action) {
    it('rejects discovered worker@0 through ' + action + ' without touching registered ID 0', function(done) {
      api._operate(action, 'worker@0', {}, function(err) {
        try {
          assert.ok(err);
          assert.match(err.message, /Multi-instance/);
          assert.deepStrictEqual(calls, []);
          done();
        } catch (error) { done(error); }
      });
    });
  });

  ['start', 'restart', 'reload', 'stop', 'delete'].forEach(function(method) {
    it('round-trips discovered pm_id through public ' + method, function(done) {
      client.getProcessIdByName('worker@0', function(err, ids) {
        if (err) return done(err);
        api[method](ids[0], function(error) {
          try {
            if (method === 'stop' || method === 'delete') {
              assert.ifError(error);
              assert.ok(calls.length > 0);
              assert.ok(calls.every(function(call) { return call[1] === 'zm2-worker@0'; }));
            } else {
              assert.ok(error);
              assert.match(error.message, /Multi-instance/);
              assert.deepStrictEqual(calls, []);
            }
            done();
          } catch (e) { done(e); }
        });
      });
    });
  });

  it('does not parse a numeric-prefix instance alias as registered ID 0', function(done) {
    stub(Systemd, 'unitExists', function(name) { return name === 'zm2-0worker@'; });
    client._restartProcess({ id: '0worker@0' }, function(err) {
      try {
        assert.ok(err);
        assert.strictEqual(err.code, 'ZM2_MULTI_INSTANCE_DISABLED');
        assert.deepStrictEqual(calls, []);
        done();
      } catch (error) { done(error); }
    });
  });

  it('keeps discovered aliases addressable for explicit stop', function(done) {
    api._operate('stopProcessId', 'worker@0', {}, function(err) {
      try {
        assert.ifError(err);
        assert.deepStrictEqual(calls, [['stop', 'zm2-worker@0'], ['disable', 'zm2-worker@0']]);
        done();
      } catch (error) { done(error); }
    });
  });
});
