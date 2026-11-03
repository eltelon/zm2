var assert = require('assert');
var RuntimeVerifier = require('../../lib/Systemd/RuntimeVerifier');

function makeStatus(overrides) {
  return Object.assign({
    ActiveState: 'active',
    SubState: 'running',
    MainPID: 4242,
    NRestarts: 2
  }, overrides || {});
}

function createDelay() {
  var calls = [];
  var pending = 0;

  function delay(ms) {
    calls.push(ms);
    pending += 1;

    return new Promise(function(resolve) {
      setTimeout(function() {
        pending -= 1;
        resolve();
      }, 0);
    });
  }

  return {
    delay: delay,
    calls: calls,
    pending: function() {
      return pending;
    }
  };
}

function createRealpath(paths) {
  var calls = [];

  function realpath(target) {
    calls.push(target);

    if (Object.prototype.hasOwnProperty.call(paths, target)) {
      return paths[target];
    }

    throw new Error('ENOENT: no such file or directory, realpath ' + target);
  }

  return {
    realpath: realpath,
    calls: calls
  };
}

function createSystemd(options) {
  var statuses = options.statuses;
  var statusIndex = 0;
  var statusCalls = [];
  var executableCalls = [];
  var forbiddenCalls = [];
  var executable = options.executable || function() {
    return '/opt/node/v26.1.0/bin/node';
  };

  function getStatus(name) {
    statusCalls.push(name);

    var next = statuses[Math.min(statusIndex, statuses.length - 1)];
    statusIndex += 1;

    if (next instanceof Error) {
      throw next;
    }

    if (typeof next === 'function') {
      return next(statusIndex);
    }

    return next;
  }

  function getProcessExecutable(pid) {
    executableCalls.push(pid);
    return executable(pid, executableCalls.length);
  }

  function forbidden(name) {
    return function() {
      forbiddenCalls.push(name);
      throw new Error(name + ' must not be called by RuntimeVerifier');
    };
  }

  return {
    systemd: {
      getStatus: getStatus,
      getProcessExecutable: getProcessExecutable,
      start: forbidden('start'),
      stop: forbidden('stop'),
      restart: forbidden('restart'),
      reload: forbidden('reload')
    },
    statusCalls: statusCalls,
    executableCalls: executableCalls,
    forbiddenCalls: forbiddenCalls
  };
}

function createHarness(options) {
  options = options || {};

  var statuses = options.statuses || [makeStatus()];
  var delay = createDelay();
  var realpath = createRealpath(options.paths || {});
  var systemd = createSystemd({
    statuses: statuses,
    executable: options.executable
  });

  var verifier = new RuntimeVerifier({
    systemd: systemd.systemd,
    realpath: realpath.realpath,
    delay: delay.delay
  });

  return {
    verifier: verifier,
    delay: delay,
    realpath: realpath,
    systemd: systemd
  };
}

describe('RuntimeVerifier', function() {
  var serviceName = 'zm2-myapp';
  var symlinkExecutable = '/opt/node/current/bin/node';
  var canonicalExecutable = '/opt/node/v26.1.0/bin/node';

  describe('successful startup verification', function() {
    it('samples at time 0 and every 500 ms through 5000 ms inclusive', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable }
      });

      await harness.verifier.verify(serviceName, symlinkExecutable);

      assert.strictEqual(harness.systemd.statusCalls.length, 11);
      assert.deepStrictEqual(harness.systemd.statusCalls, new Array(11).fill(serviceName));
      assert.strictEqual(harness.systemd.executableCalls.length, 11);
      assert.deepStrictEqual(harness.systemd.executableCalls, new Array(11).fill(4242));
      assert.deepStrictEqual(harness.delay.calls, new Array(10).fill(500));
      assert.strictEqual(harness.delay.pending(), 0);
    });

    it('compares the expected executable after canonicalizing symlinks', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable }
      });

      await harness.verifier.verify(serviceName, symlinkExecutable);

      assert.deepStrictEqual(harness.realpath.calls, [symlinkExecutable]);
    });

    it('does not call start, stop, restart, or reload', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable }
      });

      await harness.verifier.verify(serviceName, symlinkExecutable);

      assert.deepStrictEqual(harness.systemd.forbiddenCalls, []);
    });

    it('uses injected fs.realpathSync when no realpath resolver is given', async function() {
      var realpathCalls = [];
      var delay = createDelay();
      var systemd = createSystemd({ statuses: [makeStatus()] });
      var fakeFs = {
        realpathSync: function(target) {
          realpathCalls.push(target);
          return canonicalExecutable;
        }
      };

      var verifier = new RuntimeVerifier({
        systemd: systemd.systemd,
        fs: fakeFs,
        delay: delay.delay
      });

      await verifier.verify(serviceName, symlinkExecutable);

      assert.deepStrictEqual(realpathCalls, [symlinkExecutable]);
    });
  });

  describe('transient service states', function() {
    [
      { ActiveState: 'failed', SubState: 'failed' },
      { ActiveState: 'inactive', SubState: 'dead' },
      { ActiveState: 'activating', SubState: 'start' },
      { ActiveState: 'active', SubState: 'reloading' }
    ].forEach(function(state) {
      it('rejects immediately when the state becomes ' +
        state.ActiveState + '/' + state.SubState, async function() {
        var harness = createHarness({
          paths: { '/opt/node/current/bin/node': canonicalExecutable },
          statuses: [
            makeStatus(),
            makeStatus(state),
            makeStatus()
          ]
        });

        await assert.rejects(
          harness.verifier.verify(serviceName, symlinkExecutable),
          new RegExp('Runtime verification failed for ' + serviceName +
            ': expected active/running but found ' +
            state.ActiveState + '/' + state.SubState)
        );

        assert.strictEqual(harness.systemd.statusCalls.length, 2);
        assert.strictEqual(harness.delay.calls.length, 1);
        assert.strictEqual(harness.delay.pending(), 0);
      });
    });

    it('does not ignore a transient failure that later recovers', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable },
        statuses: [
          makeStatus(),
          makeStatus({ ActiveState: 'failed', SubState: 'failed' }),
          makeStatus(),
          makeStatus()
        ]
      });

      await assert.rejects(
        harness.verifier.verify(serviceName, symlinkExecutable),
        /expected active\/running but found failed\/failed/
      );

      assert.strictEqual(harness.systemd.statusCalls.length, 2);
      assert.strictEqual(harness.delay.calls.length, 1);
    });

    it('rejects when systemd returns no status object', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable },
        statuses: [null]
      });

      await assert.rejects(
        harness.verifier.verify(serviceName, symlinkExecutable),
        /systemd status is missing or invalid/
      );

      assert.strictEqual(harness.delay.calls.length, 0);
    });
  });

  describe('MainPID validation', function() {
    [0, -1, 1.5, NaN, Infinity, '4242', null, undefined].forEach(function(pid) {
      it('rejects MainPID ' + String(pid), async function() {
        var harness = createHarness({
          paths: { '/opt/node/current/bin/node': canonicalExecutable },
          statuses: [makeStatus({ MainPID: pid })]
        });

        await assert.rejects(
          harness.verifier.verify(serviceName, symlinkExecutable),
          /MainPID must be a positive integer/
        );

        assert.strictEqual(harness.systemd.executableCalls.length, 0);
        assert.strictEqual(harness.delay.calls.length, 0);
      });
    });

    it('rejects when MainPID changes during observation', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable },
        statuses: [
          makeStatus({ MainPID: 4242 }),
          makeStatus({ MainPID: 4242 }),
          makeStatus({ MainPID: 4243 })
        ]
      });

      await assert.rejects(
        harness.verifier.verify(serviceName, symlinkExecutable),
        /MainPID changed from 4242 to 4243/
      );

      assert.strictEqual(harness.systemd.statusCalls.length, 3);
      assert.strictEqual(harness.delay.calls.length, 2);
      assert.strictEqual(harness.delay.pending(), 0);
    });
  });

  describe('NRestarts validation', function() {
    [-1, 1.5, NaN, Infinity, '2', null, undefined].forEach(function(restarts) {
      it('rejects NRestarts ' + String(restarts), async function() {
        var harness = createHarness({
          paths: { '/opt/node/current/bin/node': canonicalExecutable },
          statuses: [makeStatus({ NRestarts: restarts })]
        });

        await assert.rejects(
          harness.verifier.verify(serviceName, symlinkExecutable),
          /NRestarts must be a non-negative integer/
        );

        assert.strictEqual(harness.systemd.executableCalls.length, 0);
        assert.strictEqual(harness.delay.calls.length, 0);
      });
    });

    it('uses the first post-restart status as the NRestarts baseline', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable },
        statuses: [
          makeStatus({ NRestarts: 7 }),
          makeStatus({ NRestarts: 7 }),
          makeStatus({ NRestarts: 8 })
        ]
      });

      await assert.rejects(
        harness.verifier.verify(serviceName, symlinkExecutable),
        /NRestarts changed from 7 to 8/
      );

      assert.strictEqual(harness.systemd.statusCalls.length, 3);
      assert.strictEqual(harness.delay.calls.length, 2);
    });
  });

  describe('process executable validation', function() {
    it('rejects when the process executable differs from the expected runtime', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable },
        executable: function() {
          return '/opt/node/v24.8.0/bin/node';
        }
      });

      await assert.rejects(
        harness.verifier.verify(serviceName, symlinkExecutable),
        /expected executable \/opt\/node\/v26\.1\.0\/bin\/node but PID 4242 runs \/opt\/node\/v24\.8\.0\/bin\/node/
      );

      assert.strictEqual(harness.systemd.statusCalls.length, 1);
      assert.strictEqual(harness.systemd.executableCalls.length, 1);
      assert.strictEqual(harness.delay.calls.length, 0);
    });

    it('rejects when reading the process executable fails', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable },
        executable: function() {
          throw new Error('permission denied');
        }
      });

      await assert.rejects(
        harness.verifier.verify(serviceName, symlinkExecutable),
        /unable to read executable for PID 4242: permission denied/
      );

      assert.strictEqual(harness.delay.calls.length, 0);
    });

    it('rejects when the process executable is not a valid path', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable },
        executable: function() {
          return '';
        }
      });

      await assert.rejects(
        harness.verifier.verify(serviceName, symlinkExecutable),
        /process executable for PID 4242 is not a valid path/
      );
    });
  });

  describe('query and resolution failures', function() {
    it('rejects when reading systemd status fails', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable },
        statuses: [new Error('systemctl show failed')]
      });

      await assert.rejects(
        harness.verifier.verify(serviceName, symlinkExecutable),
        /unable to query systemd status: systemctl show failed/
      );

      assert.strictEqual(harness.delay.calls.length, 0);
    });

    it('rejects when the expected executable cannot be resolved', async function() {
      var harness = createHarness({
        paths: {}
      });

      await assert.rejects(
        harness.verifier.verify(serviceName, symlinkExecutable),
        /unable to resolve expected executable "\/opt\/node\/current\/bin\/node"/
      );

      assert.strictEqual(harness.systemd.statusCalls.length, 0);
      assert.strictEqual(harness.delay.calls.length, 0);
    });

    it('includes the service name in every verification error', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable },
        statuses: [makeStatus({ ActiveState: 'failed', SubState: 'failed' })]
      });

      await assert.rejects(
        harness.verifier.verify(serviceName, symlinkExecutable),
        /^Error: Runtime verification failed for zm2-myapp: /
      );
    });
  });

  describe('input validation', function() {
    it('rejects an empty service name', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable }
      });

      await assert.rejects(
        harness.verifier.verify('', symlinkExecutable),
        /service name must be a non-empty string/
      );

      assert.strictEqual(harness.systemd.statusCalls.length, 0);
    });

    it('rejects a non-string service name', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable }
      });

      await assert.rejects(
        harness.verifier.verify(null, symlinkExecutable),
        /service name must be a non-empty string/
      );
    });

    it('rejects an empty expected executable', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable }
      });

      await assert.rejects(
        harness.verifier.verify(serviceName, ''),
        /expected executable must be a non-empty string/
      );

      assert.strictEqual(harness.realpath.calls.length, 0);
    });

    it('rejects a non-string expected executable', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable }
      });

      await assert.rejects(
        harness.verifier.verify(serviceName, null),
        /expected executable must be a non-empty string/
      );
    });
  });

  describe('timer cleanup', function() {
    it('leaves no pending delay after a rejection', async function() {
      var harness = createHarness({
        paths: { '/opt/node/current/bin/node': canonicalExecutable },
        statuses: [
          makeStatus(),
          makeStatus({ ActiveState: 'failed', SubState: 'failed' })
        ]
      });

      await assert.rejects(
        harness.verifier.verify(serviceName, symlinkExecutable),
        /expected active\/running/
      );

      assert.strictEqual(harness.delay.pending(), 0);
      assert.strictEqual(harness.delay.calls.length, 1);
    });
  });
});
