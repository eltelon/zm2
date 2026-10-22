'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var StateStore = require('../../lib/Systemd/StateStore');
var RuntimeConfig = require('../../lib/Systemd/RuntimeConfig');
var UnitGenerator = require('../../lib/Systemd/UnitGenerator');
var NodeRuntimeUpdater = require('../../lib/Systemd/NodeRuntimeUpdater');

var tempRoots = [];

function createRoot() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'zm2-node-update-'));
  tempRoots.push(root);
  return root;
}

function cleanupRoots() {
  tempRoots.forEach(function(root) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (e) {
      /* ignore cleanup errors */
    }
  });
  tempRoots = [];
}

function writeFile(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

function writeExecutable(file) {
  writeFile(file, '#!/bin/sh\nexit 0\n', 0o755);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  var resolve;
  var reject;
  var promise = new Promise(function(res, rej) {
    resolve = res;
    reject = rej;
  });
  return { promise: promise, resolve: resolve, reject: reject };
}

async function waitFor(predicate) {
  for (var i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise(function(resolve) { setImmediate(resolve); });
  }
  throw new Error('Timed out waiting for condition');
}

function accessError(code) {
  var error = new Error(code + ': simulated access failure');
  error.code = code;
  return error;
}

function overrideFs(overrides) {
  return new Proxy(fs, {
    get: function(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return overrides[property];
      }
      var value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function makeEntry(overrides) {
  return Object.assign({
    serviceName: 'zm2-app',
    pm_id: 1,
    name: 'app',
    script: '/srv/app/main.js',
    cwd: '/srv/app',
    instances: 1,
    exec_interpreter: 'node',
    created_at: 100,
    updated_at: 200,
    custom: 'keep-me'
  }, overrides || {});
}

function makeSnapshot(entry, previousExecutable, overrides) {
  var previous = previousExecutable || '/usr/bin/node';
  var snapshot = {
    serviceName: entry.serviceName,
    isTemplate: Number(entry.instances || 1) > 1,
    instances: Number(entry.instances || 1),
    unit: {
      path: '/etc/systemd/system/' + entry.serviceName + '.service',
      exists: true,
      content: '[Service]\n',
      mode: 0o644,
      uid: 0,
      gid: 0
    },
    env: {
      path: '/etc/zm2/env/' + entry.serviceName + '.env',
      exists: true,
      content: 'FOO=bar\n',
      mode: 0o600,
      uid: 0,
      gid: 0
    },
    executable: previous,
    previousExecutable: previous,
    metadata: clone(entry)
  };

  return Object.assign(snapshot, overrides || {});
}

function activeStatus(overrides) {
  return Object.assign({
    ActiveState: 'active',
    SubState: 'running',
    MainPID: 1234,
    NRestarts: 0
  }, overrides || {});
}

function inactiveStatus() {
  return {
    ActiveState: 'inactive',
    SubState: 'dead',
    MainPID: 0,
    NRestarts: 0
  };
}

function createNvm(options) {
  options = options || {};
  var calls = { validate: [], prepare: [] };
  var runtime = options.runtime || {
    version: '20.11.1',
    executable: '/opt/zm2-node/bin/node',
    binDir: '/opt/zm2-node/bin'
  };

  return {
    calls: calls,
    runtime: runtime,
    validateVersion: function(input) {
      calls.validate.push(input);
      if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(String(input))) {
        throw new Error(
          'Invalid Node version ' + JSON.stringify(input) +
          ': expected an exact major.minor.patch version'
        );
      }
      return String(input).replace(/^v/, '');
    },
    prepare: function(version) {
      calls.prepare.push(version);
      if (options.prepareError) return Promise.reject(options.prepareError);
      return Promise.resolve(runtime);
    }
  };
}

function createStateStore(entries, options) {
  options = options || {};

  var store = {
    filePath: options.filePath,
    entries: entries,
    loadCalls: [],
    registerCalls: [],
    load: function(opts) {
      store.loadCalls.push(opts);
      if (options.loadError) throw options.loadError;
      if (opts && opts.strict && options.strictError) throw options.strictError;
      return store;
    },
    getAll: function() {
      if (options.getAllError) throw options.getAllError;
      return entries;
    },
    register: function(serviceName, metadata) {
      store.registerCalls.push({
        serviceName: serviceName,
        metadata: clone(metadata)
      });
      if (options.registerError) throw options.registerError;

      var found = null;
      entries.forEach(function(entry) {
        if (entry.serviceName === serviceName) found = entry;
      });
      if (found) Object.assign(found, metadata);
      return found ? found.pm_id : metadata.pm_id;
    }
  };

  return store;
}

function createSystemd(options) {
  options = options || {};
  var calls = [];

  function forbidden(type) {
    return function(name) {
      calls.push({ type: type, name: name });
      throw new Error(type + ' must not be called');
    };
  }

  return {
    calls: calls,
    isSystemd: function() {
      return options.isSystemd === undefined ? true : !!options.isSystemd;
    },
    getStatus: function(name) {
      calls.push({ type: 'getStatus', name: name });
      var value = options.statuses && options.statuses[name];
      if (value instanceof Error) throw value;
      if (typeof value === 'function') return value(name);
      return value || activeStatus();
    },
    daemonReload: function() {
      calls.push({ type: 'daemonReload' });
      if (options.daemonReloadError) throw options.daemonReloadError;
    },
    restart: function(name) {
      calls.push({ type: 'restart', name: name });
      if (options.restartError) {
        var error = typeof options.restartError === 'function'
          ? options.restartError(name)
          : options.restartError;
        if (error) throw error;
      }
      if (typeof options.restart === 'function') return options.restart(name);
    },
    start: forbidden('start'),
    stop: forbidden('stop'),
    enable: forbidden('enable'),
    disable: forbidden('disable'),
    reload: forbidden('reload')
  };
}

function createRuntimeConfig(options) {
  options = options || {};
  var calls = { inspect: [], plan: [], apply: [], restore: [] };

  function snapshotFor(entry) {
    var configured = options.snapshots;
    if (typeof configured === 'function') {
      var fromFunction = configured(entry);
      if (fromFunction) return fromFunction;
    } else if (configured && configured[entry.serviceName]) {
      return configured[entry.serviceName];
    }
    return makeSnapshot(entry, options.previousExecutable || options.oldExecutable);
  }

  function errorFor(spec, entry) {
    if (!spec) return null;
    if (spec instanceof Error) return spec;
    if (typeof spec === 'function') return spec(entry);
    return spec[entry.serviceName] || null;
  }

  return {
    calls: calls,
    inspect: function(entry) {
      calls.inspect.push(entry.serviceName);
      var error = errorFor(options.inspectError, entry);
      if (error) throw error;
      return snapshotFor(entry);
    },
    plan: function(snapshot, runtime) {
      calls.plan.push(snapshot.serviceName);
      var error = errorFor(options.planError, snapshot);
      if (error) throw error;
      if (typeof options.plan === 'function') return options.plan(snapshot, runtime);

      var changed = typeof options.planChanged === 'function'
        ? options.planChanged(snapshot, runtime)
        : (options.planChanged === undefined ? true : options.planChanged);

      return {
        changed: changed,
        unitContent: 'unit:' + snapshot.serviceName,
        envContent: 'env:' + snapshot.serviceName
      };
    },
    apply: function(snapshot, plan) {
      calls.apply.push(snapshot.serviceName);
      var error = errorFor(options.applyError, snapshot);
      if (error) throw error;
      if (typeof options.apply === 'function') return options.apply(snapshot, plan);
    },
    restore: function(snapshot) {
      calls.restore.push(snapshot.serviceName);
      var error = errorFor(options.restoreError, snapshot);
      if (error) throw error;
    }
  };
}

function createVerifier(options) {
  options = options || {};
  var calls = [];

  return {
    calls: calls,
    verify: function(name, executable) {
      calls.push({ name: name, executable: executable });
      if (typeof options.verify === 'function') return options.verify(name, executable);
      if (options.verifyError) {
        var error = typeof options.verifyError === 'function'
          ? options.verifyError(name)
          : options.verifyError;
        if (error) throw error;
      }
    }
  };
}

function createProcessRunner(options) {
  options = options || {};
  var calls = [];

  return {
    calls: calls,
    run: function(command, args, runOptions) {
      calls.push({ command: command, args: args, options: runOptions });
      if (typeof options.run === 'function') {
        return options.run(command, args, runOptions);
      }
      if (options.runError) throw options.runError;
      return { code: 0, stdout: 'v20.11.1\n', stderr: '' };
    }
  };
}

function createHarness(options) {
  options = options || {};

  var root = createRoot();
  var unitDir = path.join(root, 'units');
  var envDir = path.join(root, 'env');
  var stateDir = path.join(root, 'state');
  var homeDir = path.join(root, 'home');
  var nvmDir = path.join(root, 'nvm');

  fs.mkdirSync(unitDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(nvmDir, { recursive: true });

  if (!options.skipNvmSetup) {
    writeFile(path.join(nvmDir, 'nvm.sh'), '# fake nvm.sh\n', 0o644);
  }
  if (options.nvmAtHome) {
    writeFile(path.join(homeDir, '.nvm', 'nvm.sh'), '# fake home nvm.sh\n', 0o644);
  }

  var oldExecutable = path.join(root, 'old-node', 'bin', 'node');
  var newExecutable = path.join(root, 'new-node', 'bin', 'node');
  writeExecutable(oldExecutable);
  writeExecutable(newExecutable);

  var env = options.env || { NVM_DIR: nvmDir, HOME: homeDir };
  var pm2Home = Object.prototype.hasOwnProperty.call(options, 'pm2Home')
    ? options.pm2Home
    : root;

  var entries = (options.entries || []).map(function(entry) {
    return Object.assign({}, entry);
  });

  var stateStore = options.stateStore;
  if (!stateStore && options.useRealStateStore) {
    var stateHome = pm2Home || env.ZM2_HOME || root;
    var statePath = path.join(stateHome, 'state.json');
    if (options.stateData !== undefined) {
      writeFile(statePath, JSON.stringify(options.stateData));
    }
  } else if (!stateStore) {
    stateStore = createStateStore(entries, {
      filePath: path.join(stateDir, 'state.json'),
      loadError: options.loadError,
      strictError: options.strictError,
      registerError: options.registerError,
      getAllError: options.getAllError
    });
  }

  var systemd = options.systemd || createSystemd(options.systemdOptions || {});
  var runtime = options.runtime || {
    version: '20.11.1',
    executable: newExecutable,
    binDir: path.dirname(newExecutable)
  };
  var nvm = options.nvm || createNvm({
    prepareError: options.prepareError,
    runtime: runtime
  });
  var runtimeConfig = options.runtimeConfig || createRuntimeConfig({
    oldExecutable: oldExecutable,
    snapshots: options.snapshots,
    inspectError: options.inspectError,
    planChanged: options.planChanged,
    planError: options.planError,
    plan: options.plan,
    applyError: options.applyError,
    apply: options.apply,
    restoreError: options.restoreError
  });
  var verifier = options.verifier || createVerifier(options.verifierOptions || {});
  var processRunner = options.runProcess || createProcessRunner(options.processOptions || {});

  var fsOption = options.fs;
  if (typeof fsOption === 'function') {
    fsOption = fsOption({
      root: root,
      unitDir: unitDir,
      envDir: envDir,
      stateDir: stateDir,
      homeDir: homeDir,
      nvmDir: nvmDir,
      oldExecutable: oldExecutable,
      newExecutable: newExecutable
    });
  }

  var updater = new NodeRuntimeUpdater({
    stateStore: stateStore,
    pm2Home: pm2Home,
    pm2HomeExplicit: options.pm2HomeExplicit,
    systemd: systemd,
    nvm: nvm,
    runtimeConfig: runtimeConfig,
    verifier: verifier,
    fs: fsOption || fs,
    env: env,
    platform: options.platform || 'linux',
    isSystemd: options.isSystemd,
    unitDir: unitDir,
    envDir: envDir,
    run: processRunner.run,
    sudoUser: options.sudoUser,
    effectiveUser: options.effectiveUser
  });

  return {
    root: root,
    unitDir: unitDir,
    envDir: envDir,
    stateDir: stateDir,
    homeDir: homeDir,
    nvmDir: nvmDir,
    oldExecutable: oldExecutable,
    newExecutable: newExecutable,
    entries: entries,
    stateStore: stateStore,
    systemd: systemd,
    nvm: nvm,
    runtime: runtime,
    runtimeConfig: runtimeConfig,
    verifier: verifier,
    processRunner: processRunner,
    updater: updater
  };
}

function callsOfType(systemd, type) {
  return systemd.calls.filter(function(call) {
    return call.type === type;
  });
}

function restartNames(systemd) {
  return callsOfType(systemd, 'restart').map(function(call) {
    return call.name;
  });
}

function verifyNames(verifier) {
  return verifier.calls.map(function(call) {
    return call.name;
  });
}

function reportKeys() {
  return ['exitCode', 'globalError', 'requestedVersion', 'results', 'runtime', 'totals'].sort();
}

function rowKeys() {
  return [
    'errors',
    'name',
    'previousVersion',
    'reason',
    'rollbackErrors',
    'serviceName',
    'startupVerified',
    'status',
    'stopped'
  ].sort();
}

describe('NodeRuntimeUpdater', function() {
  afterEach(cleanupRoots);

  describe('preflight', function() {
    it('rejects an invalid version before preparing or loading state', async function() {
      var h = createHarness({ entries: [makeEntry()] });

      var report = await h.updater.run('lts');

      assert.match(report.globalError, /Invalid Node version/);
      assert.strictEqual(report.requestedVersion, 'lts');
      assert.strictEqual(report.runtime, null);
      assert.deepStrictEqual(report.results, []);
      assert.strictEqual(report.exitCode, 1);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.deepStrictEqual(h.stateStore.loadCalls, []);
    });

    it('rejects non-Linux hosts before loading state', async function() {
      var h = createHarness({ entries: [makeEntry()], platform: 'darwin' });

      var report = await h.updater.run('20.11.1');

      assert.match(report.globalError, /Linux/);
      assert.deepStrictEqual(report.results, []);
      assert.deepStrictEqual(h.stateStore.loadCalls, []);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('rejects hosts without systemd before loading state', async function() {
      var h = createHarness({ entries: [makeEntry()], isSystemd: false });

      var report = await h.updater.run('20.11.1');

      assert.match(report.globalError, /systemd/);
      assert.deepStrictEqual(report.results, []);
      assert.deepStrictEqual(h.stateStore.loadCalls, []);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('reloads StateStore strictly even after a tolerant load', async function() {
      var root = createRoot();
      var statePath = path.join(root, 'state.json');
      var store = new StateStore(statePath);

      writeFile(statePath, JSON.stringify({
        services: {
          'zm2-app': {
            pm_id: 1,
            name: 'app',
            script: '/srv/app/main.js',
            instances: 1,
            exec_interpreter: 'node'
          }
        },
        next_id: 2
      }));
      store.load();
      writeFile(statePath, 'not valid json{{{');

      var h = createHarness({ stateStore: store, entries: [] });
      var report = await h.updater.run('20.11.1');

      assert.match(report.globalError, /Cannot read ZM2 state|JSON|Unexpected/i);
      assert.deepStrictEqual(report.results, []);
      assert.strictEqual(report.runtime, null);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('rejects an unwritable StateStore directory before installing Node', async function() {
      var h = createHarness({
        entries: [makeEntry()],
        fs: function(dirs) {
          return overrideFs({
            accessSync: function(file, mode) {
              if (file === dirs.stateDir && (mode & fs.constants.W_OK)) {
                throw accessError('EACCES');
              }
              return fs.accessSync(file, mode);
            }
          });
        }
      });

      var report = await h.updater.run('20.11.1');

      assert.match(report.globalError, /StateStore directory is not writable/);
      assert.strictEqual(report.results[0].status, 'not_updated');
      assert.strictEqual(report.results[0].previousVersion, '20.11.1');
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('rejects an unwritable systemd unit directory before installing Node', async function() {
      var h = createHarness({
        entries: [makeEntry()],
        fs: function(dirs) {
          return overrideFs({
            accessSync: function(file, mode) {
              if (file === dirs.unitDir && (mode & fs.constants.W_OK)) {
                throw accessError('EACCES');
              }
              return fs.accessSync(file, mode);
            }
          });
        }
      });

      var report = await h.updater.run('20.11.1');

      assert.match(report.globalError, /systemd unit directory is not writable/);
      assert.strictEqual(report.results[0].status, 'not_updated');
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('rejects an unwritable environment directory before installing Node', async function() {
      var h = createHarness({
        entries: [makeEntry()],
        fs: function(dirs) {
          return overrideFs({
            accessSync: function(file, mode) {
              if (file === dirs.envDir && (mode & fs.constants.W_OK)) {
                throw accessError('EACCES');
              }
              return fs.accessSync(file, mode);
            }
          });
        }
      });

      var report = await h.updater.run('20.11.1');

      assert.match(report.globalError, /ZM2 environment directory is not writable/);
      assert.strictEqual(report.results[0].status, 'not_updated');
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('rejects a missing or unreadable nvm.sh before installing Node', async function() {
      var h = createHarness({ entries: [makeEntry()], skipNvmSetup: true });

      var report = await h.updater.run('20.11.1');

      assert.match(report.globalError, /nvm\.sh/);
      assert.strictEqual(report.results[0].status, 'not_updated');
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('rejects an unwritable nvm directory before installing Node', async function() {
      var h = createHarness({
        entries: [makeEntry()],
        fs: function(dirs) {
          return overrideFs({
            accessSync: function(file, mode) {
              if (file === dirs.nvmDir && (mode & fs.constants.W_OK)) {
                throw accessError('EACCES');
              }
              return fs.accessSync(file, mode);
            }
          });
        }
      });

      var report = await h.updater.run('20.11.1');

      assert.match(report.globalError, /nvm directory is not writable/);
      assert.strictEqual(report.results[0].status, 'not_updated');
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('requires explicit NVM_DIR when the sudo origin differs', async function() {
      var h = createHarness({
        entries: [],
        pm2Home: null,
        env: { HOME: '/home/deploy', SUDO_USER: 'deploy' },
        effectiveUser: 'root'
      });

      var report = await h.updater.run('20.11.1');

      assert.match(report.globalError, /NVM_DIR/);
      assert.match(report.globalError, /ZM2_HOME|pm2Home/);
      assert.deepStrictEqual(report.results, []);
      assert.deepStrictEqual(h.stateStore.loadCalls, []);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('requires an explicit ZM2 home when the sudo origin differs', async function() {
      var h = createHarness({
        entries: [],
        pm2Home: null,
        env: { NVM_DIR: '/home/deploy/.nvm', HOME: '/home/deploy', SUDO_USER: 'deploy' },
        effectiveUser: 'root'
      });

      var report = await h.updater.run('20.11.1');

      assert.match(report.globalError, /ZM2_HOME|pm2Home/);
      assert.deepStrictEqual(report.results, []);
      assert.deepStrictEqual(h.stateStore.loadCalls, []);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('refuses sudo when pm2Home was provided without explicit provenance', async function() {
      var h = createHarness({
        entries: [],
        pm2HomeExplicit: false,
        env: { NVM_DIR: '/home/deploy/.nvm', HOME: '/home/deploy', SUDO_USER: 'deploy' },
        effectiveUser: 'root'
      });

      var report = await h.updater.run('20.11.1');

      assert.match(report.globalError, /ZM2_HOME|pm2Home/);
      assert.deepStrictEqual(report.results, []);
      assert.deepStrictEqual(h.stateStore.loadCalls, []);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('accepts pm2Home when provenance is explicitly true', async function() {
      var h = createHarness({
        entries: [],
        pm2HomeExplicit: true,
        env: { NVM_DIR: '/home/deploy/.nvm', HOME: '/home/deploy', SUDO_USER: 'deploy' },
        effectiveUser: 'root'
      });

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.globalError, null);
      assert.strictEqual(report.exitCode, 0);
      assert.strictEqual(h.stateStore.loadCalls.length, 1);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
    });

    it('accepts an explicit ZM2_HOME even when pm2Home provenance is false', async function() {
      var guessedHome = path.join(createRoot(), 'guessed-home');
      var explicitHome = path.join(createRoot(), 'explicit-home');
      var h = createHarness({
        entries: [makeEntry({ exec_interpreter: 'python3' })],
        pm2Home: null,
        pm2HomeExplicit: false,
        useRealStateStore: true,
        stateData: {
          services: {
            'zm2-python': {
              pm_id: 1,
              name: 'python',
              script: '/srv/python/main.py',
              instances: 1,
              exec_interpreter: 'python3'
            }
          },
          next_id: 2
        },
        env: {
          NVM_DIR: '/home/deploy/.nvm',
          ZM2_HOME: explicitHome,
          HOME: guessedHome,
          SUDO_USER: 'deploy'
        },
        effectiveUser: 'root'
      });

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.globalError, null);
      assert.strictEqual(report.results[0].status, 'skipped');
      assert.strictEqual(report.exitCode, 0);
      assert.strictEqual(fs.existsSync(path.join(explicitHome, 'state.json')), true);
      assert.strictEqual(fs.existsSync(path.join(guessedHome, '.zm2')), false);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
    });

    it('accepts an explicit PM2_HOME even when pm2Home provenance is false', async function() {
      var h = createHarness({
        entries: [],
        pm2Home: null,
        pm2HomeExplicit: false,
        env: {
          NVM_DIR: '/home/deploy/.nvm',
          PM2_HOME: '/home/deploy/.zm2',
          HOME: '/home/deploy',
          SUDO_USER: 'deploy'
        },
        effectiveUser: 'root'
      });

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.globalError, null);
      assert.strictEqual(report.exitCode, 0);
      assert.strictEqual(h.stateStore.loadCalls.length, 1);
    });

    it('accepts explicit NVM_DIR and a programmatic pm2Home under sudo', async function() {
      var h = createHarness({
        entries: [],
        env: { NVM_DIR: '/home/deploy/.nvm', HOME: '/home/deploy', SUDO_USER: 'deploy' },
        effectiveUser: 'root'
      });

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.globalError, null);
      assert.strictEqual(report.exitCode, 0);
      assert.strictEqual(h.stateStore.loadCalls.length, 1);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.deepStrictEqual(h.processRunner.calls, []);
    });

    it('accepts explicit NVM_DIR and ZM2_HOME under sudo', async function() {
      var h = createHarness({
        entries: [],
        pm2Home: null,
        env: {
          NVM_DIR: '/home/deploy/.nvm',
          ZM2_HOME: '/home/deploy/.zm2',
          HOME: '/home/deploy',
          SUDO_USER: 'deploy'
        },
        effectiveUser: 'root'
      });

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.globalError, null);
      assert.strictEqual(report.exitCode, 0);
      assert.strictEqual(h.stateStore.loadCalls.length, 1);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
    });

    it('falls back to HOME/.nvm when NVM_DIR is unset', async function() {
      var snapshots = {};
      var h = createHarness({
        entries: [makeEntry()],
        nvmAtHome: true,
        env: { HOME: '/tmp/ignored-home' },
        snapshots: snapshots,
        planChanged: false
      });

      h.updater.env = { HOME: h.homeDir };
      h.entries[0].exec_interpreter = h.newExecutable;
      snapshots['zm2-app'] = makeSnapshot(h.entries[0], h.newExecutable);

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.globalError, null);
      assert.strictEqual(report.results[0].status, 'skipped');
      assert.deepStrictEqual(h.nvm.calls.prepare, ['20.11.1']);
      assert.strictEqual(report.exitCode, 0);
    });

    it('does not prepare nvm when there are no eligible applications', async function() {
      var h = createHarness({
        entries: [
          makeEntry({ serviceName: 'zm2-python', name: 'python', exec_interpreter: 'python3' }),
          makeEntry({ serviceName: 'zm2-none', name: 'none', exec_interpreter: 'none' })
        ],
        skipNvmSetup: true
      });

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.globalError, null);
      assert.strictEqual(report.exitCode, 0);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.deepStrictEqual(h.runtimeConfig.calls.inspect, []);
      assert.deepStrictEqual(report.results.map(function(row) {
        return row.status;
      }), ['skipped', 'skipped']);
    });
  });

  describe('selection', function() {
    it('classifies Node interpreters and skips wrappers and other runtimes', async function() {
      var snapshots = {};
      var h = createHarness({
        entries: [],
        prepareError: new Error('nvm install failed'),
        snapshots: snapshots
      });

      var relativeDir = path.join(h.root, '.nvm', 'bin');
      var relativeExecutable = path.join(relativeDir, 'node');
      writeExecutable(relativeExecutable);

      var entries = [
        makeEntry({ serviceName: 'zm2-node', name: 'node', exec_interpreter: 'node' }),
        makeEntry({ serviceName: 'zm2-node-version', name: 'node-version', exec_interpreter: 'node@20.11.1' }),
        makeEntry({ serviceName: 'zm2-node-vversion', name: 'node-vversion', exec_interpreter: 'node@v20.11.1' }),
        makeEntry({ serviceName: 'zm2-absolute', name: 'absolute', exec_interpreter: h.oldExecutable }),
        makeEntry({
          serviceName: 'zm2-relative',
          name: 'relative',
          cwd: h.root,
          exec_interpreter: '.nvm/bin/node'
        }),
        makeEntry({ serviceName: 'zm2-default', name: 'default', exec_interpreter: undefined }),
        makeEntry({ serviceName: 'zm2-sh', name: 'sh', exec_interpreter: '/bin/sh' }),
        makeEntry({ serviceName: 'zm2-npm', name: 'npm', exec_interpreter: 'npm' }),
        makeEntry({ serviceName: 'zm2-python', name: 'python', exec_interpreter: 'python3' }),
        makeEntry({ serviceName: 'zm2-bun', name: 'bun', exec_interpreter: 'bun' }),
        makeEntry({ serviceName: 'zm2-none', name: 'none', exec_interpreter: 'none' }),
        makeEntry({ serviceName: 'zm2-runner', name: 'runner', exec_interpreter: '/opt/custom/runner' })
      ];

      entries.forEach(function(entry) {
        h.entries.push(entry);
      });
      snapshots['zm2-relative'] = makeSnapshot(h.entries[4], relativeExecutable);

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.exitCode, 1);
      assert.match(report.globalError, /nvm install failed/);
      assert.deepStrictEqual(h.nvm.calls.prepare, ['20.11.1']);

      var statuses = {};
      report.results.forEach(function(row) {
        statuses[row.serviceName] = row;
      });

      [
        'zm2-node',
        'zm2-node-version',
        'zm2-node-vversion',
        'zm2-absolute',
        'zm2-relative',
        'zm2-default'
      ].forEach(function(serviceName) {
        assert.strictEqual(statuses[serviceName].status, 'not_updated', serviceName);
      });

      [
        'zm2-sh',
        'zm2-npm',
        'zm2-python',
        'zm2-bun',
        'zm2-none',
        'zm2-runner'
      ].forEach(function(serviceName) {
        assert.strictEqual(statuses[serviceName].status, 'skipped', serviceName);
        assert.match(statuses[serviceName].reason, /not Node|interpreter/i);
        assert.strictEqual(statuses[serviceName].previousVersion, null);
      });
    });

    it('skips only the reserved internal API entry, not every api name', async function() {
      var h = createHarness({
        entries: [
          makeEntry({
            serviceName: 'zm2-api',
            pm_id: 0,
            name: 'zm2_api',
            script: '/opt/zm2/lib/API/HttpApiServer.js',
            exec_interpreter: 'node'
          }),
          makeEntry({
            serviceName: 'zm2-api-user',
            pm_id: 4,
            name: 'api',
            script: '/srv/api/main.js',
            exec_interpreter: 'node'
          }),
          makeEntry({
            serviceName: 'zm2-other',
            pm_id: 0,
            name: 'other',
            script: '/srv/other.js',
            exec_interpreter: 'node'
          })
        ],
        prepareError: new Error('nvm failed')
      });

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.results[0].status, 'skipped');
      assert.match(report.results[0].reason, /internal ZM2 HTTP API/);
      assert.strictEqual(report.results[1].status, 'not_updated');
      assert.strictEqual(report.results[2].status, 'not_updated');
      assert.strictEqual(h.nvm.calls.prepare.length, 1);
    });

    it('treats a missing interpreter as the default Node interpreter', async function() {
      var h = createHarness({
        entries: [makeEntry({ exec_interpreter: undefined })],
        prepareError: new Error('nvm failed')
      });

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.results[0].status, 'not_updated');
      assert.strictEqual(h.nvm.calls.prepare.length, 1);
    });
  });

  describe('invalid units and states', function() {
    it('reports a missing unit and continues with the next application', async function() {
      var snapshots = {};
      var h = createHarness({
        entries: [
          makeEntry({ serviceName: 'zm2-bad', name: 'bad' }),
          makeEntry({ serviceName: 'zm2-good', name: 'good' })
        ],
        snapshots: snapshots,
        planChanged: false,
        inspectError: function(entry) {
          if (entry.serviceName === 'zm2-bad') {
            return new Error('Unit zm2-bad.service not found');
          }
          return null;
        }
      });

      h.entries[1].exec_interpreter = h.newExecutable;
      snapshots['zm2-good'] = makeSnapshot(h.entries[1], h.newExecutable);

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.results[0].status, 'failed_unchanged');
      assert.match(report.results[0].reason, /not found/);
      assert.strictEqual(report.results[1].status, 'skipped');
      assert.strictEqual(h.nvm.calls.prepare.length, 1);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('does not prepare nvm when every eligible application fails preflight', async function() {
      var h = createHarness({
        entries: [makeEntry({ serviceName: 'zm2-missing' })],
        inspectError: new Error('Unit zm2-missing.service not found')
      });

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.results[0].status, 'failed_unchanged');
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('rejects metadata and ExecStart executable mismatches without writing', async function() {
      var snapshots = {};
      var h = createHarness({
        entries: [makeEntry({ serviceName: 'zm2-mismatch', name: 'mismatch' })],
        snapshots: snapshots
      });

      h.entries[0].exec_interpreter = h.oldExecutable;
      snapshots['zm2-mismatch'] = makeSnapshot(h.entries[0], h.newExecutable);

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.results[0].status, 'failed_unchanged');
      assert.match(report.results[0].reason, /does not match|ExecStart/i);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('rejects node@ metadata that disagrees with the configured executable version', async function() {
      var h = createHarness({
        entries: [makeEntry({ exec_interpreter: 'node@18.19.0' })],
        processOptions: {
          run: function() {
            return { code: 0, stdout: 'v20.11.1\n', stderr: '' };
          }
        }
      });

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.results[0].status, 'failed_unchanged');
      assert.match(report.results[0].reason, /does not match|version/i);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('rejects transitional and failed instances without restarting them', async function() {
      var h = createHarness({
        entries: [
          makeEntry({ serviceName: 'zm2-transitional', name: 'transitional', instances: 2 }),
          makeEntry({ serviceName: 'zm2-failed', name: 'failed', instances: 1 })
        ],
        systemdOptions: {
          statuses: {
            'zm2-transitional@0': activeStatus(),
            'zm2-transitional@1': { ActiveState: 'activating', SubState: 'start' },
            'zm2-failed': { ActiveState: 'failed', SubState: 'failed' }
          }
        }
      });

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.results[0].status, 'failed_unchanged');
      assert.match(report.results[0].reason, /zm2-transitional@1|activating/i);
      assert.strictEqual(report.results[1].status, 'failed_unchanged');
      assert.match(report.results[1].reason, /zm2-failed|failed/i);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, []);
      assert.deepStrictEqual(restartNames(h.systemd), []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('reports an application permission error and continues', async function() {
      var snapshots = {};
      var h = createHarness({
        entries: [
          makeEntry({ serviceName: 'zm2-denied', name: 'denied' }),
          makeEntry({ serviceName: 'zm2-good', name: 'good' })
        ],
        snapshots: snapshots,
        planChanged: false,
        inspectError: function(entry) {
          if (entry.serviceName === 'zm2-denied') {
            return accessError('EACCES');
          }
          return null;
        }
      });

      h.entries[1].exec_interpreter = h.newExecutable;
      snapshots['zm2-good'] = makeSnapshot(h.entries[1], h.newExecutable);

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.results[0].status, 'failed_unchanged');
      assert.match(report.results[0].reason, /EACCES/);
      assert.strictEqual(report.results[1].status, 'skipped');
      assert.strictEqual(h.nvm.calls.prepare.length, 1);
      assert.strictEqual(report.exitCode, 1);
    });

    it('rejects an invalid instance count before writing', async function() {
      var h = createHarness({
        entries: [makeEntry({ instances: 0 })]
      });

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.results[0].status, 'failed_unchanged');
      assert.match(report.results[0].reason, /instance count/i);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, []);
      assert.strictEqual(report.exitCode, 1);
    });
  });

  describe('runtime preparation failure', function() {
    it('marks eligible rows not_updated without writing or restarting', async function() {
      var h = createHarness({
        entries: [
          makeEntry({ serviceName: 'zm2-one', name: 'one' }),
          makeEntry({ serviceName: 'zm2-python', name: 'python', exec_interpreter: 'python3' }),
          makeEntry({ serviceName: 'zm2-two', name: 'two' })
        ],
        prepareError: new Error('nvm install failed')
      });

      var report = await h.updater.run('20.11.1');

      assert.match(report.globalError, /nvm install failed/);
      assert.strictEqual(report.runtime, null);
      assert.strictEqual(report.results[0].status, 'not_updated');
      assert.strictEqual(report.results[0].previousVersion, '20.11.1');
      assert.strictEqual(report.results[1].status, 'skipped');
      assert.strictEqual(report.results[2].status, 'not_updated');
      assert.deepStrictEqual(h.runtimeConfig.calls.plan, []);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, []);
      assert.deepStrictEqual(callsOfType(h.systemd, 'daemonReload'), []);
      assert.deepStrictEqual(restartNames(h.systemd), []);
      assert.deepStrictEqual(h.verifier.calls, []);
      assert.deepStrictEqual(h.stateStore.registerCalls, []);
      assert.strictEqual(report.exitCode, 1);
      assert.deepStrictEqual(report.totals, {
        updated: 0,
        skipped: 1,
        failed: 0,
        notUpdated: 2
      });
    });
  });

  describe('happy path', function() {
    it('applies, reloads, restarts and verifies each active instance sequentially', async function() {
      var h = createHarness({
        entries: [makeEntry({ instances: 2 })],
        planChanged: true
      });
      var gate = deferred();

      h.verifier.verify = function(name, executable) {
        h.verifier.calls.push({ name: name, executable: executable });
        if (name === 'zm2-app@0') return gate.promise;
      };

      var runPromise = h.updater.run('20.11.1');

      await waitFor(function() {
        return h.verifier.calls.length === 1;
      });

      assert.deepStrictEqual(restartNames(h.systemd), ['zm2-app@0']);
      assert.deepStrictEqual(verifyNames(h.verifier), ['zm2-app@0']);

      gate.resolve();
      var report = await runPromise;

      assert.strictEqual(report.globalError, null);
      assert.strictEqual(report.runtime.version, '20.11.1');
      assert.strictEqual(report.runtime.executable, h.newExecutable);
      assert.strictEqual(report.runtime.binDir, path.dirname(h.newExecutable));
      assert.deepStrictEqual(report.totals, {
        updated: 1,
        skipped: 0,
        failed: 0,
        notUpdated: 0
      });
      assert.strictEqual(report.exitCode, 0);
      assert.deepStrictEqual(Object.keys(report).sort(), reportKeys());

      var row = report.results[0];
      assert.deepStrictEqual(Object.keys(row).sort(), rowKeys());
      assert.strictEqual(row.serviceName, 'zm2-app');
      assert.strictEqual(row.name, 'app');
      assert.strictEqual(row.previousVersion, '20.11.1');
      assert.strictEqual(row.status, 'updated');
      assert.strictEqual(row.stopped, false);
      assert.strictEqual(row.startupVerified, true);
      assert.strictEqual(row.reason, null);
      assert.deepStrictEqual(row.errors, []);
      assert.deepStrictEqual(row.rollbackErrors, []);

      assert.deepStrictEqual(h.runtimeConfig.calls.plan, ['zm2-app']);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, ['zm2-app']);
      assert.deepStrictEqual(restartNames(h.systemd), ['zm2-app@0', 'zm2-app@1']);
      assert.deepStrictEqual(verifyNames(h.verifier), ['zm2-app@0', 'zm2-app@1']);
      h.verifier.calls.forEach(function(call) {
        assert.strictEqual(call.executable, h.newExecutable);
      });
      assert.strictEqual(callsOfType(h.systemd, 'daemonReload').length, 1);

      assert.strictEqual(h.stateStore.registerCalls.length, 1);
      var registerCall = h.stateStore.registerCalls[0];
      assert.strictEqual(registerCall.serviceName, 'zm2-app');
      assert.strictEqual(registerCall.metadata.exec_interpreter, h.newExecutable);
      assert.strictEqual(registerCall.metadata.pm_id, 1);
      assert.strictEqual(registerCall.metadata.name, 'app');
      assert.strictEqual(registerCall.metadata.script, '/srv/app/main.js');
      assert.strictEqual(registerCall.metadata.cwd, '/srv/app');
      assert.strictEqual(registerCall.metadata.created_at, 100);
      assert.strictEqual(registerCall.metadata.custom, 'keep-me');
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(registerCall.metadata, 'serviceName'),
        false
      );

      assert.strictEqual(h.updater.rollbackContexts.length, 1);
      assert.deepStrictEqual(
        h.updater.rollbackContexts[0].instances.map(function(instance) {
          return { name: instance.name, active: instance.active };
        }),
        [
          { name: 'zm2-app@0', active: true },
          { name: 'zm2-app@1', active: true }
        ]
      );

      assert.deepStrictEqual(restartNames(h.systemd).filter(function(name) {
        return name !== 'zm2-app@0' && name !== 'zm2-app@1';
      }), []);
    });

    it('updates a stopped application without starting or verifying it', async function() {
      var h = createHarness({
        entries: [makeEntry()],
        planChanged: true,
        systemdOptions: {
          statuses: {
            'zm2-app': inactiveStatus()
          }
        }
      });

      var report = await h.updater.run('20.11.1');

      var row = report.results[0];
      assert.strictEqual(row.status, 'updated');
      assert.strictEqual(row.stopped, true);
      assert.strictEqual(row.startupVerified, false);
      assert.match(row.reason, /stopped|not verified/i);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, ['zm2-app']);
      assert.strictEqual(callsOfType(h.systemd, 'daemonReload').length, 1);
      assert.deepStrictEqual(restartNames(h.systemd), []);
      assert.deepStrictEqual(h.verifier.calls, []);
      assert.strictEqual(h.stateStore.registerCalls.length, 1);
      assert.strictEqual(report.exitCode, 0);
    });

    it('handles mixed template statuses and applies shared configuration once', async function() {
      var h = createHarness({
        entries: [makeEntry({ instances: 3 })],
        planChanged: true,
        systemdOptions: {
          statuses: {
            'zm2-app@0': activeStatus(),
            'zm2-app@1': inactiveStatus(),
            'zm2-app@2': activeStatus()
          }
        }
      });

      var report = await h.updater.run('20.11.1');

      var row = report.results[0];
      assert.strictEqual(row.status, 'updated');
      assert.strictEqual(row.stopped, false);
      assert.strictEqual(row.startupVerified, true);
      assert.match(row.reason, /zm2-app@1/);
      assert.match(row.reason, /not started|not verified/i);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, ['zm2-app']);
      assert.strictEqual(callsOfType(h.systemd, 'daemonReload').length, 1);
      assert.deepStrictEqual(restartNames(h.systemd), ['zm2-app@0', 'zm2-app@2']);
      assert.deepStrictEqual(verifyNames(h.verifier), ['zm2-app@0', 'zm2-app@2']);
      assert.strictEqual(h.stateStore.registerCalls.length, 1);
      assert.strictEqual(report.exitCode, 0);
    });

    it('skips without restarting when the runtime is already configured', async function() {
      var snapshots = {};
      var h = createHarness({
        entries: [makeEntry()],
        snapshots: snapshots,
        planChanged: false
      });

      h.entries[0].exec_interpreter = h.newExecutable;
      snapshots['zm2-app'] = makeSnapshot(h.entries[0], h.newExecutable);

      var report = await h.updater.run('20.11.1');

      var row = report.results[0];
      assert.strictEqual(row.status, 'skipped');
      assert.strictEqual(row.previousVersion, '20.11.1');
      assert.strictEqual(row.stopped, false);
      assert.strictEqual(row.startupVerified, false);
      assert.match(row.reason, /already configured/i);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, []);
      assert.deepStrictEqual(callsOfType(h.systemd, 'daemonReload'), []);
      assert.deepStrictEqual(restartNames(h.systemd), []);
      assert.deepStrictEqual(h.verifier.calls, []);
      assert.deepStrictEqual(h.stateStore.registerCalls, []);
      assert.deepStrictEqual(report.totals, {
        updated: 0,
        skipped: 1,
        failed: 0,
        notUpdated: 0
      });
      assert.strictEqual(report.exitCode, 0);
    });

    it('repairs stale metadata when the configuration is already current', async function() {
      var snapshots = {};
      var h = createHarness({
        entries: [makeEntry({ exec_interpreter: 'node' })],
        snapshots: snapshots,
        planChanged: false
      });

      snapshots['zm2-app'] = makeSnapshot(h.entries[0], h.newExecutable);

      var report = await h.updater.run('20.11.1');

      var row = report.results[0];
      assert.strictEqual(row.status, 'updated');
      assert.strictEqual(row.startupVerified, false);
      assert.match(row.reason, /metadata/i);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, []);
      assert.deepStrictEqual(callsOfType(h.systemd, 'daemonReload'), []);
      assert.deepStrictEqual(restartNames(h.systemd), []);
      assert.deepStrictEqual(h.verifier.calls, []);
      assert.strictEqual(h.stateStore.registerCalls.length, 1);
      assert.strictEqual(
        h.stateStore.registerCalls[0].metadata.exec_interpreter,
        h.newExecutable
      );
      assert.strictEqual(h.stateStore.registerCalls[0].metadata.pm_id, 1);
      assert.strictEqual(h.stateStore.registerCalls[0].metadata.custom, 'keep-me');
      assert.strictEqual(report.exitCode, 0);
    });

    it('reads the previous version from the configured executable', async function() {
      var h = createHarness({
        entries: [makeEntry()],
        planChanged: true,
        processOptions: {
          run: function() {
            return { code: 0, stdout: 'v18.19.0\n', stderr: '' };
          }
        }
      });
      var spacedExecutable = path.join(h.root, 'node 18', 'bin', 'node');
      writeExecutable(spacedExecutable);

      h.entries[0].exec_interpreter = spacedExecutable;
      h.runtimeConfig.inspect = function(entry) {
        return makeSnapshot(entry, spacedExecutable);
      };

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(h.processRunner.calls.length, 1);
      assert.strictEqual(h.processRunner.calls[0].command, spacedExecutable);
      assert.deepStrictEqual(h.processRunner.calls[0].args, ['--version']);
      assert.strictEqual(h.processRunner.calls[0].options.shell, false);
      assert.strictEqual(report.results[0].previousVersion, '18.19.0');
      assert.strictEqual(report.exitCode, 0);
    });

    it('reports an unknown previous version but proceeds when --version fails', async function() {
      var h = createHarness({
        entries: [makeEntry()],
        planChanged: true,
        processOptions: {
          run: function() {
            return { code: 1, stdout: '', stderr: 'bad executable' };
          }
        }
      });

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.results[0].status, 'updated');
      assert.strictEqual(report.results[0].previousVersion, null);
      assert.strictEqual(h.processRunner.calls.length, 1);
      assert.strictEqual(report.exitCode, 0);
    });

    it('fails unchanged when the previous executable cannot be restored safely', async function() {
      var missing = path.join('/tmp', 'zm2-definitely-missing-node', 'bin', 'node');
      var h = createHarness({
        entries: [makeEntry()],
        planChanged: true
      });

      h.runtimeConfig.inspect = function(entry) {
        return makeSnapshot(entry, missing);
      };

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.results[0].status, 'failed_unchanged');
      assert.strictEqual(report.results[0].previousVersion, null);
      assert.match(report.results[0].reason, /missing|not executable|previous Node/i);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, []);
      assert.deepStrictEqual(h.processRunner.calls, []);
      assert.strictEqual(report.exitCode, 1);
    });

    it('does not begin the next application until the current one completes', async function() {
      var h = createHarness({
        entries: [
          makeEntry({ serviceName: 'zm2-one', name: 'one' }),
          makeEntry({ serviceName: 'zm2-two', name: 'two' })
        ],
        planChanged: true
      });
      var gate = deferred();

      h.verifier.verify = function(name, executable) {
        h.verifier.calls.push({ name: name, executable: executable });
        if (name === 'zm2-one') return gate.promise;
      };

      var runPromise = h.updater.run('20.11.1');

      await waitFor(function() {
        return h.verifier.calls.length === 1;
      });

      assert.deepStrictEqual(h.runtimeConfig.calls.plan, ['zm2-one']);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, ['zm2-one']);
      assert.deepStrictEqual(restartNames(h.systemd), ['zm2-one']);

      gate.resolve();
      var report = await runPromise;

      assert.deepStrictEqual(h.runtimeConfig.calls.plan, ['zm2-one', 'zm2-two']);
      assert.deepStrictEqual(h.runtimeConfig.calls.apply, ['zm2-one', 'zm2-two']);
      assert.deepStrictEqual(restartNames(h.systemd), ['zm2-one', 'zm2-two']);
      assert.deepStrictEqual(verifyNames(h.verifier), ['zm2-one', 'zm2-two']);
      assert.deepStrictEqual(
        h.stateStore.registerCalls.map(function(call) { return call.serviceName; }),
        ['zm2-one', 'zm2-two']
      );
      assert.deepStrictEqual(report.results.map(function(row) {
        return row.status;
      }), ['updated', 'updated']);
      assert.strictEqual(report.exitCode, 0);
    });

    it('does not report a partially changed application as failed_unchanged', async function() {
      var h = createHarness({
        entries: [makeEntry()],
        planChanged: true,
        applyError: new Error('unit write failed')
      });

      var report = await h.updater.run('20.11.1');

      var row = report.results[0];
      assert.strictEqual(row.status, 'failed_restore');
      assert.notStrictEqual(row.status, 'failed_unchanged');
      assert.match(row.reason, /unit write failed/);
      assert.deepStrictEqual(row.errors, ['unit write failed']);
      assert.deepStrictEqual(row.rollbackErrors, []);
      assert.deepStrictEqual(restartNames(h.systemd), []);
      assert.deepStrictEqual(h.verifier.calls, []);
      assert.deepStrictEqual(h.stateStore.registerCalls, []);
      assert.strictEqual(report.exitCode, 1);
    });
  });

  describe('real configuration integration', function() {
    it('updates real unit, env and StateStore files while preserving stopped apps', async function() {
      var root = createRoot();
      var unitDir = path.join(root, 'units');
      var envDir = path.join(root, 'env');
      var nvmDir = path.join(root, 'nvm');
      var homeDir = path.join(root, 'home');
      var statePath = path.join(root, 'state.json');
      var oldExecutable = path.join(root, 'old-node', 'bin', 'node');
      var newExecutable = path.join(root, 'new-node', 'bin', 'node');

      fs.mkdirSync(unitDir, { recursive: true });
      fs.mkdirSync(envDir, { recursive: true });
      fs.mkdirSync(nvmDir, { recursive: true });
      fs.mkdirSync(homeDir, { recursive: true });
      writeFile(path.join(nvmDir, 'nvm.sh'), '# fake nvm.sh\n', 0o644);
      writeExecutable(oldExecutable);
      writeExecutable(newExecutable);

      function createApp(name, active) {
        var serviceName = 'zm2-' + name;
        var unitPath = path.join(unitDir, serviceName + '.service');
        var envPath = path.join(envDir, serviceName + '.env');
        var conf = {
          name: name,
          pm_exec_path: '/srv/' + name + '/main.js',
          exec_interpreter: oldExecutable,
          pm_cwd: '/srv/' + name,
          user: 'deploy',
          restart_delay: 5000,
          max_memory_restart: '256M',
          args: ['--flag']
        };
        var unitContent = UnitGenerator.generate(conf).replace(
          'EnvironmentFile=-/etc/zm2/env/' + serviceName + '.env',
          'EnvironmentFile=-' + envPath
        );

        writeFile(unitPath, unitContent, 0o640);
        writeFile(envPath, 'FOO=' + name + '\nPATH=/usr/bin:/bin\n', 0o600);

        return {
          serviceName: serviceName,
          name: name,
          active: active,
          unitPath: unitPath,
          envPath: envPath,
          conf: conf
        };
      }

      var activeApp = createApp('active', true);
      var stoppedApp = createApp('stopped', false);
      var state = { services: {}, next_id: 3 };

      [activeApp, stoppedApp].forEach(function(app, index) {
        state.services[app.serviceName] = {
          pm_id: index + 1,
          name: app.name,
          script: app.conf.pm_exec_path,
          cwd: app.conf.pm_cwd,
          instances: 1,
          exec_interpreter: oldExecutable,
          created_at: 100 + index,
          updated_at: 200 + index,
          custom: 'keep-' + app.name
        };
      });
      writeFile(statePath, JSON.stringify(state));

      var store = new StateStore(statePath);
      store.load();

      var systemdCalls = [];
      var apps = [activeApp, stoppedApp];
      function appFor(name) {
        var found = null;
        apps.forEach(function(app) {
          if (app.serviceName === name) found = app;
        });
        return found;
      }

      var systemd = {
        isSystemd: function() { return true; },
        getRuntimeProperties: function(name) {
          var app = appFor(name);
          return {
            ExecStart: '{ path=' + oldExecutable +
              ' ; argv[]=' + oldExecutable + ' ' + app.conf.pm_exec_path +
              ' ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a]' +
              ' ; pid=0 ; code=(null) ; status=0/0 }',
            FragmentPath: app.unitPath,
            DropInPaths: '',
            Environment: '',
            EnvironmentFiles: app.envPath + ' (ignore_errors=yes)',
            User: 'deploy',
            Group: 'deploy'
          };
        },
        getStatus: function(name) {
          systemdCalls.push({ type: 'getStatus', name: name });
          return appFor(name).active ? activeStatus() : inactiveStatus();
        },
        daemonReload: function() {
          systemdCalls.push({ type: 'daemonReload' });
        },
        restart: function(name) {
          systemdCalls.push({ type: 'restart', name: name });
        },
        start: function(name) {
          systemdCalls.push({ type: 'start', name: name });
          throw new Error('start must not be called');
        },
        stop: function(name) {
          systemdCalls.push({ type: 'stop', name: name });
          throw new Error('stop must not be called');
        },
        enable: function(name) {
          systemdCalls.push({ type: 'enable', name: name });
          throw new Error('enable must not be called');
        },
        disable: function(name) {
          systemdCalls.push({ type: 'disable', name: name });
          throw new Error('disable must not be called');
        }
      };

      var runtimeConfig = new RuntimeConfig({
        systemd: systemd,
        unitDir: unitDir,
        envDir: envDir
      });
      var nvm = {
        validateVersion: function(version) { return version; },
        prepare: function() {
          return Promise.resolve({
            version: '20.11.1',
            executable: newExecutable,
            binDir: path.dirname(newExecutable)
          });
        }
      };
      var verifierCalls = [];
      var verifier = {
        verify: function(name, executable) {
          verifierCalls.push({ name: name, executable: executable });
        }
      };
      var processCalls = [];
      var run = function(command, args, options) {
        processCalls.push({ command: command, args: args, options: options });
        return { code: 0, stdout: 'v18.19.0\n', stderr: '' };
      };

      var updater = new NodeRuntimeUpdater({
        stateStore: store,
        pm2Home: root,
        systemd: systemd,
        nvm: nvm,
        runtimeConfig: runtimeConfig,
        verifier: verifier,
        fs: fs,
        env: { NVM_DIR: nvmDir, HOME: homeDir },
        platform: 'linux',
        isSystemd: true,
        unitDir: unitDir,
        envDir: envDir,
        run: run
      });

      var report = await updater.run('20.11.1');

      assert.strictEqual(report.globalError, null);
      assert.strictEqual(report.exitCode, 0);
      assert.deepStrictEqual(report.results.map(function(row) {
        return row.status;
      }), ['updated', 'updated']);

      assert.strictEqual(report.results[0].serviceName, activeApp.serviceName);
      assert.strictEqual(report.results[0].previousVersion, '18.19.0');
      assert.strictEqual(report.results[0].stopped, false);
      assert.strictEqual(report.results[0].startupVerified, true);
      assert.strictEqual(report.results[1].serviceName, stoppedApp.serviceName);
      assert.strictEqual(report.results[1].stopped, true);
      assert.strictEqual(report.results[1].startupVerified, false);
      assert.match(report.results[1].reason, /stopped|not verified/i);

      apps.forEach(function(app) {
        var unitContent = fs.readFileSync(app.unitPath, 'utf8');
        var envContent = fs.readFileSync(app.envPath, 'utf8');
        assert.ok(unitContent.indexOf('ExecStart=' + newExecutable) !== -1);
        assert.ok(unitContent.indexOf(oldExecutable) === -1);
        assert.ok(envContent.indexOf('PATH=' + path.dirname(newExecutable) + ':/usr/bin:/bin') !== -1);
        assert.ok(envContent.indexOf('FOO=' + app.name) !== -1);
      });

      assert.deepStrictEqual(
        systemdCalls.filter(function(call) { return call.type === 'restart'; })
          .map(function(call) { return call.name; }),
        [activeApp.serviceName]
      );
      assert.strictEqual(
        systemdCalls.filter(function(call) { return call.type === 'daemonReload'; }).length,
        2
      );
      assert.deepStrictEqual(verifierCalls, [
        { name: activeApp.serviceName, executable: newExecutable }
      ]);
      assert.strictEqual(processCalls.length, 2);

      var reloaded = new StateStore(statePath);
      reloaded.load({ strict: true });
      apps.forEach(function(app, index) {
        var metadata = reloaded.get(app.serviceName);
        assert.strictEqual(metadata.exec_interpreter, newExecutable);
        assert.strictEqual(metadata.pm_id, index + 1);
        assert.strictEqual(metadata.created_at, 100 + index);
        assert.strictEqual(metadata.custom, 'keep-' + app.name);
      });
    });
  });

  describe('report and defaults', function() {
    it('returns the exact report schema for an empty state', async function() {
      var h = createHarness({ entries: [] });

      var report = await h.updater.run('20.11.1');

      assert.deepStrictEqual(Object.keys(report).sort(), reportKeys());
      assert.strictEqual(report.requestedVersion, '20.11.1');
      assert.strictEqual(report.runtime, null);
      assert.strictEqual(report.globalError, null);
      assert.deepStrictEqual(report.results, []);
      assert.deepStrictEqual(report.totals, {
        updated: 0,
        skipped: 0,
        failed: 0,
        notUpdated: 0
      });
      assert.strictEqual(report.exitCode, 0);
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
    });

    it('returns the exact row schema for a skipped application', async function() {
      var h = createHarness({
        entries: [makeEntry({ exec_interpreter: 'python3' })],
        skipNvmSetup: true
      });

      var report = await h.updater.run('20.11.1');

      var row = report.results[0];
      assert.deepStrictEqual(Object.keys(row).sort(), rowKeys());
      assert.strictEqual(row.serviceName, 'zm2-app');
      assert.strictEqual(row.name, 'app');
      assert.strictEqual(row.previousVersion, null);
      assert.strictEqual(row.status, 'skipped');
      assert.strictEqual(row.stopped, false);
      assert.strictEqual(row.startupVerified, false);
      assert.match(row.reason, /not Node/);
      assert.deepStrictEqual(row.errors, []);
      assert.deepStrictEqual(row.rollbackErrors, []);
      assert.strictEqual(report.exitCode, 0);
    });

    it('uses pm2Home/state.json when no StateStore is injected', async function() {
      var h = createHarness({
        entries: [],
        useRealStateStore: true,
        stateData: {
          services: {
            'zm2-python': {
              pm_id: 1,
              name: 'python',
              script: '/srv/python/main.py',
              instances: 1,
              exec_interpreter: 'python3'
            }
          },
          next_id: 2
        }
      });

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.globalError, null);
      assert.strictEqual(report.results.length, 1);
      assert.strictEqual(report.results[0].serviceName, 'zm2-python');
      assert.strictEqual(report.results[0].status, 'skipped');
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.strictEqual(report.exitCode, 0);
    });

    it('does not require nvm access when every application is skipped', async function() {
      var h = createHarness({
        entries: [makeEntry({ exec_interpreter: 'python3' })],
        skipNvmSetup: true
      });

      var report = await h.updater.run('20.11.1');

      assert.strictEqual(report.globalError, null);
      assert.strictEqual(report.results[0].status, 'skipped');
      assert.deepStrictEqual(h.nvm.calls.prepare, []);
      assert.strictEqual(report.exitCode, 0);
    });
  });
});
