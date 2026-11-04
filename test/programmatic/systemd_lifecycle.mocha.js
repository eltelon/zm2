'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var childProcess = require('child_process');
var API = require('../../lib/API');
var Common = require('../../lib/Common');
var Modularizer = require('../../lib/API/Modules/Modularizer');
var Systemd = require('../../lib/Systemd');
var SystemdClient = require('../../lib/SystemdClient');

// All systemd and /etc writes are stubbed; exercise the actual API dispatch.
describe('Systemd lifecycle safety', function() {
  var restore;
  var calls;
  var client;
  var api;
  var entry;
  var failure;
  var jsonProcessing;
  var zm2Status;

  function stub(object, key, fn) {
    var original = object[key];
    restore.push(function() { object[key] = original; });
    object[key] = fn;
  }

  function operation(method) {
    return function(name) {
      calls.push([method, name]);
      if (failure && failure.method === method && (!failure.name || failure.name === name)) {
        throw failure.error;
      }
    };
  }

  beforeEach(function() {
    restore = [];
    calls = [];
    failure = null;
    jsonProcessing = process.env.ZM2_JSON_PROCESSING;
    zm2Status = process.env.ZM2_STATUS;
    entry = { serviceName: 'zm2-app', name: 'app', pm_id: 7, instances: 1, script: '/apps/app.js' };
    client = Object.create(SystemdClient.prototype);
    client._resolveEntry = function() { return entry; };
    client.stateStore = {
      register: function() { calls.push(['register']); return 7; },
      unregister: function() { calls.push(['unregister']); },
      get: function() { return entry; },
      getAll: function() { return [entry]; }
    };
    client.getProcessIdByName = function(name, allow, cb) {
      if (typeof allow === 'function') cb = allow;
      cb(null, name === 'app' ? [7] : []);
    };
    client.getProcessIdsByNamespace = function(name, allow, cb) {
      if (typeof allow === 'function') cb = allow;
      cb(null, name === 'production' ? [7] : []);
    };
    client.getAllProcessIdWithoutModules = function(cb) { cb(null, [7]); };
    client.getAllProcessId = client.getAllProcessIdWithoutModules;
    client._getMonitorData = function(cb) {
      cb(null, [{ name: 'app', pm_id: 7, pm2_env: { name: 'app', pm_id: 7,
        pm_exec_path: '/apps/app.js', status: 'stopped' } }]);
    };
    api = Object.create(API.prototype);
    api.Client = client;
    api.cwd = '/apps';
    api.pm2_configuration = {};
    api._handleAttributeUpdate = function(opts) { return opts; };
    ['enable', 'disable', 'start', 'stop', 'restart', 'reload', 'writeEnvFile', 'installUnit',
      'daemonReload', 'installTimer', 'removeUnit', 'removeTemplateUnit'].forEach(function(method) {
      stub(Systemd, method, operation(method));
    });
    stub(Systemd, 'getStatus', function() { return { ActiveState: 'active', MainPID: 123 }; });
    stub(fs, 'writeFileSync', function(file) {
      assert.ok(file.indexOf('/etc/systemd/system/zm2-app') === 0, file);
    });
    stub(Common, 'printOut', function() {});
    stub(Common, 'printError', function() {});
    stub(Common, 'verifyConfs', function(input) {
      return (Array.isArray(input) ? input : [input]).map(function(app) {
        return Object.assign({ name: 'app', namespace: 'default' }, app);
      });
    });
    stub(Common, 'mergeEnvironmentVariables', function() { return { TOKEN: 'updated' }; });
    stub(Modularizer, 'getAdditionalConf', function() { return {}; });
  });

  afterEach(function() {
    restore.reverse().forEach(function(fn) { fn(); });
    if (jsonProcessing === undefined) delete process.env.ZM2_JSON_PROCESSING;
    else process.env.ZM2_JSON_PROCESSING = jsonProcessing;
    if (zm2Status === undefined) delete process.env.ZM2_STATUS;
    else process.env.ZM2_STATUS = zm2Status;
  });

  ['app', '7', 'production', 'all', '/apps/app.js'].forEach(function(target) {
    it('enables an existing application when start targets ' + target, function(done) {
      api.start(target, {}, function(err, result) {
        try {
          assert.ifError(err);
          assert.deepStrictEqual(calls, [['enable', 'zm2-app'], ['restart', 'zm2-app']]);
          assert.strictEqual(result[0].pm_id, 7);
          done();
        } catch (e) { done(e); }
      });
    });
  });

  ['app', '7', 'production', 'all', '/apps/app.js'].forEach(function(target) {
    it('preserves enable errors when start targets ' + target, function(done) {
      var error = new Error('enable denied');
      error.code = 'EACCES';
      failure = { method: 'enable', error: error };
      api.start(target, {}, function(err) {
        try {
          assert.strictEqual(err, error);
          assert.ok(!calls.some(function(c) { return c[0] === 'restart'; }));
          done();
        } catch (e) { done(e); }
      });
    });
  });

  it('enables existing applications from an ecosystem object', function(done) {
    api.start({ name: 'app', script: '/apps/app.js' }, {}, function(err, result) {
      try {
        assert.ifError(err);
        assert.ok(calls.some(function(c) { return c[0] === 'enable'; }));
        assert.ok(calls.some(function(c) { return c[0] === 'restart'; }));
        assert.strictEqual(result[0].pm_id, 7);
        done();
      } catch (e) { done(e); }
    });
  });

  it('returns ecosystem start failures instead of reporting success', function(done) {
    var error = new Error('enable denied');
    failure = { method: 'enable', error: error };
    api.start({ name: 'app', script: '/apps/app.js' }, {}, function(err) {
      try {
        assert.strictEqual(err, error);
        done();
      } catch (e) { done(e); }
    });
  });

  it('preserves restart behavior when starting an already registered app', function(done) {
    api.start('app', { updateEnv: true }, function(err) {
      try {
        assert.ifError(err);
        assert.ok(calls.some(function(c) { return c[0] === 'restart'; }));
        assert.ok(calls.some(function(c) { return c[0] === 'enable'; }));
        done();
      } catch (e) { done(e); }
    });
  });

  it('does not enable an explicit restart', function(done) {
    api.restart('7', {}, function(err) {
      try {
        assert.ifError(err);
        assert.deepStrictEqual(calls, [['restart', 'zm2-app']]);
        done();
      } catch (e) { done(e); }
    });
  });

  it('passes update-env through the start operation', function(done) {
    api._operate('startProcessId', '7', { updateEnv: true }, function(err, result) {
      try {
        assert.ifError(err);
        assert.strictEqual(calls[0][0], 'writeEnvFile');
        assert.strictEqual(result[0].pm_id, 7);
        done();
      } catch (e) { done(e); }
    });
  });

  ['_startProcess', '_restartProcess', '_reloadProcess'].forEach(function(method) {
    [
      { serviceName: 'zm2-app', instances: 3 },
      { serviceName: 'zm2-app@0', instances: 1 }
    ].forEach(function(legacy) {
      it('rejects ' + method + ' for legacy ' + legacy.serviceName + '/' + legacy.instances + ' before mutations', function(done) {
        Object.assign(entry, legacy);
        client[method]({ id: 7, env: { TOKEN: 'must-not-write' } }, function(err) {
          try {
            assert.strictEqual(err && err.code, 'ZM2_MULTI_INSTANCE_DISABLED');
            assert.deepStrictEqual(calls, []);
            assert.strictEqual(entry.instances, legacy.instances);
            done();
          } catch (e) { done(e); }
        });
      });
    });
  });

  ['app', '7', 'production', 'all', '/apps/app.js', { name: 'app', script: '/apps/app.js', instances: 4 }].forEach(function(target) {
    it('rejects public start on legacy via ' + JSON.stringify(target), function(done) {
      entry.instances = 3;
      api.start(target, { updateEnv: true }, function(err) {
        try {
          assert.strictEqual(err && err.code, 'ZM2_MULTI_INSTANCE_DISABLED');
          assert.deepStrictEqual(calls, []);
          done();
        } catch (e) { done(e); }
      });
    });
  });

  it('normalizes direct prepare to a single base unit and metadata', function(done) {
    var registered;
    client.stateStore.get = function() { return registered || null; };
    client.stateStore.register = function(name, metadata) {
      registered = Object.assign({ serviceName: name, pm_id: 7 }, metadata);
      return 7;
    };
    client._prepare({ name: 'app', script: '/apps/app.js', instances: 4, env: { INSTANCES: '4' } }, function(err) {
      try {
        assert.ifError(err);
        assert.strictEqual(registered.instances, 1);
        assert.deepStrictEqual(calls.map(function(c) { return c[0]; }), ['writeEnvFile', 'installUnit', 'enable', 'start']);
        assert.ok(calls.every(function(c) { return c[1] === 'zm2-app'; }));
        done();
      } catch (e) { done(e); }
    });
  });

  it('refuses prepare over an existing legacy group without touching files', function(done) {
    entry.instances = 2;
    client._prepare({ name: 'app', script: '/apps/app.js', instances: 1 }, function(err) {
      try {
        assert.strictEqual(err && err.code, 'ZM2_MULTI_INSTANCE_DISABLED');
        assert.deepStrictEqual(calls, []);
        done();
      } catch (e) { done(e); }
    });
  });

  [1, 3].forEach(function(instances) {
    it(instances > 1 ? 'rejects legacy multi-instance start' : 'enables the single service before returning start success', function(done) {
      entry.instances = instances;
      client._startProcess({ id: 7 }, function(err, proc) {
        try {
          if (instances > 1) {
            assert.strictEqual(err && err.code, 'ZM2_MULTI_INSTANCE_DISABLED');
            assert.deepStrictEqual(calls, []);
            return done();
          }
          assert.ifError(err);
          assert.strictEqual(calls.length, instances * 2);
          for (var i = 0; i < instances; i++) {
            var name = 'zm2-app' + (instances > 1 ? '@' + i : '');
            assert.deepStrictEqual(calls[i * 2], ['enable', name]);
            assert.deepStrictEqual(calls[i * 2 + 1], ['start', name]);
          }
          assert.strictEqual(proc.pm2_env.pm_id, 7);
          done();
        } catch (e) { done(e); }
      });
    });

    ['enable', 'start'].forEach(function(method) {
      it(instances > 1 ? 'rejects legacy before ' + method : 'propagates ' + method + ' failure for single-service start', function(done) {
        entry.instances = instances;
        var error = new Error(method + ' denied');
        failure = { method: method, name: 'zm2-app' + (instances > 1 ? '@1' : ''), error: error };
        client._startProcess({ id: 7 }, function(err, result) {
          try {
            if (instances > 1) {
              assert.strictEqual(err && err.code, 'ZM2_MULTI_INSTANCE_DISABLED');
              assert.deepStrictEqual(calls, []);
            } else {
              assert.strictEqual(err, error);
            }
            assert.strictEqual(result, undefined);
            done();
          } catch (e) { done(e); }
        });
      });
    });

    ['stop', 'disable'].forEach(function(method) {
      it('propagates ' + method + ' failure for ' + instances + ' instance stop', function(done) {
        entry.instances = instances;
        var error = new Error(method + ' denied');
        failure = { method: method, name: 'zm2-app' + (instances > 1 ? '@1' : ''), error: error };
        client._stopProcess({ id: 7 }, function(err, result) {
          try {
            assert.strictEqual(err, error);
            assert.strictEqual(result, undefined);
            done();
          } catch (e) { done(e); }
        });
      });
    });

    it('does not register a new app after enable failure with ' + instances + ' instances', function(done) {
      var error = new Error('enable denied');
      failure = { method: 'enable', error: error };
      client._prepare({ name: 'app', script: '/apps/app.js', instances: instances }, function(err) {
        try {
          assert.strictEqual(err, error);
          assert.ok(!calls.some(function(c) { return c[0] === 'register' || c[0] === 'start'; }));
          done();
        } catch (e) { done(e); }
      });
    });

    it('keeps registration if removal fails with ' + instances + ' instances', function(done) {
      entry.instances = instances;
      var error = new Error('stop denied during removal');
      failure = { method: instances > 1 ? 'removeTemplateUnit' : 'removeUnit', error: error };
      client._deleteProcess({ id: 7 }, function(err) {
        try {
          assert.strictEqual(err, error);
          assert.ok(!calls.some(function(c) { return c[0] === 'unregister'; }));
          done();
        } catch (e) { done(e); }
      });
    });
  });

  it('preserves the systemd error through public API operations', function(done) {
    var error = new Error('permission denied stopping zm2-app.service');
    failure = { method: 'stop', error: error };
    api._operate('stopProcessId', '7', {}, function(err) {
      try {
        assert.strictEqual(err, error);
        done();
      } catch (e) { done(e); }
    });
  });

  it('propagates failed enable when starting a new ecosystem app', function(done) {
    var error = new Error('enable denied');
    failure = { method: 'enable', error: error };
    client._getMonitorData = function(cb) { cb(null, []); };
    stub(Common, 'resolveAppAttributes', function(opts, app) { return app; });
    api.start({ name: 'app', script: '/apps/app.js' }, {}, function(err) {
      try {
        assert.strictEqual(err, error);
        done();
      } catch (e) { done(e); }
    });
  });

  ['stop', 'delete'].forEach(function(action) {
    it('propagates ' + action + ' failures from an ecosystem file', function(done) {
      var error = new Error(action + ' denied');
      failure = { method: action === 'stop' ? 'disable' : 'removeUnit', error: error };
      var readFile = fs.readFileSync;
      stub(fs, 'readFileSync', function(file) {
        if (file === 'ecosystem.json') return JSON.stringify({ apps: [{ name: 'app', script: '/apps/app.js' }] });
        return readFile.apply(fs, arguments);
      });
      api[action]('ecosystem.json', function(err) {
        try {
          assert.strictEqual(err, error);
          done();
        } catch (e) { done(e); }
      });
    });
  });

  it('does not report successful public kill when deletion fails', function(done) {
    var error = new Error('removal denied');
    failure = { method: 'removeUnit', error: error };
    api.killDaemon(function(err, result) {
      try {
        assert.strictEqual(err, error);
        assert.strictEqual(result, undefined);
        done();
      } catch (e) { done(e); }
    });
  });

  it('keeps public kill idempotent with no registered applications', function(done) {
    client.getAllProcessId = function(cb) { cb(null, []); };
    api.killDaemon(function(err, result) {
      try {
        assert.ifError(err);
        assert.strictEqual(result.success, true);
        done();
      } catch (e) { done(e); }
    });
  });

  it('exits unsuccessfully when CLI kill fails', function() {
    var home = fs.mkdtempSync(path.join(os.tmpdir(), 'zm2-kill-test-'));
    try {
      var script = [
        "require('./lib/Systemd').isSystemd = function() { return true; };",
        "require('./lib/API').prototype.killDaemon = function(cb) { cb(new Error('stop failed')); };",
        "process.argv = ['node', 'bin/zm2', 'kill'];",
        "require('./lib/binaries/CLI');"
      ].join('\n');
      var result = childProcess.spawnSync(process.execPath, ['-e', script], {
        cwd: path.join(__dirname, '../..'),
        env: Object.assign({}, process.env, { ZM2_HOME: home, PM2_HOME: home }),
        encoding: 'utf8',
        timeout: 10000
      });
      assert.ifError(result.error);
      assert.strictEqual(result.status, 1, result.stderr);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not report successful killDaemon when a stop fails', function(done) {
    var error = new Error('stop denied');
    entry.instances = 3;
    failure = { method: 'stop', name: 'zm2-app@1', error: error };
    client.killDaemon(function(err, result) {
      try {
        assert.strictEqual(err, error);
        assert.strictEqual(result, undefined);
        done();
      } catch (e) { done(e); }
    });
  });
});
