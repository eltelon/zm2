
var should = require('should');
var fs = require('fs');
var path = require('path');
var os = require('os');
var childProcess = require('child_process');
var StateStore = require('../../lib/Systemd/StateStore');

function expectThrows(fn, pattern) {
  var error = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  should.exist(error, 'expected function to throw');
  error.message.should.match(pattern);
  return error;
}

function listTempFiles(dir) {
  return fs.readdirSync(dir).filter(function(name) {
    return name.indexOf('state.json.tmp') === 0;
  });
}

describe('StateStore', function() {
  var tmpDir;
  var storePath;
  var store;

  beforeEach(function() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm2-test-'));
    storePath = path.join(tmpDir, 'state.json');
    store = new StateStore(storePath);
  });

  afterEach(function() {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch (e) { /* ignore */ }
  });

  describe('load', function() {
    it('should create default state if file does not exist', function() {
      store.load();
      store.data.should.have.property('services');
      store.data.should.have.property('next_id', 1);
    });

    it('should load existing state from file', function() {
      fs.writeFileSync(storePath, JSON.stringify({
        services: { 'zm2-app': { pm_id: 1, name: 'app' } },
        next_id: 2
      }));
      store.load();
      store.data.services.should.have.property('zm2-app');
      store.data.next_id.should.equal(2);
    });

    it('should handle corrupted file gracefully', function() {
      fs.writeFileSync(storePath, 'not valid json{{{');
      store.load();
      store.data.should.have.property('services');
      store.data.should.have.property('next_id', 1);
    });
  });

  describe('register', function() {
    it('should register a new service and assign pm_id starting at 1', function() {
      store.load();
      var pm_id = store.register('zm2-myapp', { name: 'myapp', script: '/app.js' });
      pm_id.should.equal(1);
      store.data.services['zm2-myapp'].should.have.property('name', 'myapp');
      store.data.services['zm2-myapp'].should.have.property('created_at');
    });

    it('should reserve pm_id 0 for zm2-api via explicit pm_id', function() {
      store.load();
      var pm_id = store.register('zm2-api', { name: 'zm2_api', script: '/api.js', pm_id: 0 });
      pm_id.should.equal(0);
      store.data.next_id.should.equal(1);
    });

    it('should reject a pinned pm_id already owned by another service', function() {
      var firstId = store.register('zm2-first', { name: 'first' });
      var before = fs.readFileSync(storePath, 'utf8');
      (function() {
        store.register('zm2-second', { name: 'second', pm_id: firstId });
      }).should.throw(/already assigned/);
      fs.readFileSync(storePath, 'utf8').should.equal(before);
      store.register('zm2-second', { name: 'second' }).should.equal(firstId + 1);
    });

    it('should increment pm_id for each registration', function() {
      store.load();
      var id1 = store.register('zm2-app1', { name: 'app1' });
      var id2 = store.register('zm2-app2', { name: 'app2' });
      id1.should.equal(1);
      id2.should.equal(2);
    });

    it('should update existing service and keep pm_id', function() {
      store.load();
      var id1 = store.register('zm2-myapp', { name: 'myapp', script: '/old.js' });
      var id2 = store.register('zm2-myapp', { name: 'myapp', script: '/new.js' });
      id1.should.equal(id2);
      store.data.services['zm2-myapp'].script.should.equal('/new.js');
    });

    it('should persist to disk', function() {
      store.load();
      store.register('zm2-myapp', { name: 'myapp' });
      fs.existsSync(storePath).should.be.true();

      var store2 = new StateStore(storePath);
      store2.load();
      store2.data.services.should.have.property('zm2-myapp');
    });
  });

  describe('unregister', function() {
    it('should remove a registered service', function() {
      store.load();
      store.register('zm2-myapp', { name: 'myapp' });
      store.unregister('zm2-myapp');
      should(store.data.services['zm2-myapp']).be.undefined();
    });
  });

  describe('get', function() {
    it('should return service by systemd name', function() {
      store.load();
      store.register('zm2-myapp', { name: 'myapp' });
      var entry = store.get('zm2-myapp');
      entry.should.have.property('name', 'myapp');
    });

    it('should return null for unknown service', function() {
      store.load();
      should(store.get('zm2-unknown')).be.null();
    });
  });

  describe('getByName', function() {
    it('should find service by app name', function() {
      store.load();
      store.register('zm2-myapp', { name: 'myapp' });
      var entry = store.getByName('myapp');
      entry.should.have.property('serviceName', 'zm2-myapp');
      entry.should.have.property('name', 'myapp');
    });

    it('should return null for unknown name', function() {
      store.load();
      should(store.getByName('unknown')).be.null();
    });
  });

  describe('getByPmId', function() {
    it('should find service by pm_id', function() {
      store.load();
      store.register('zm2-myapp', { name: 'myapp' });
      var entry = store.getByPmId(1);
      entry.should.have.property('serviceName', 'zm2-myapp');
    });

    it('should handle string pm_id', function() {
      store.load();
      store.register('zm2-myapp', { name: 'myapp' });
      var entry = store.getByPmId('1');
      entry.should.have.property('serviceName', 'zm2-myapp');
    });

    it('should return null for unknown pm_id', function() {
      store.load();
      should(store.getByPmId(999)).be.null();
    });
  });

  describe('getAll', function() {
    it('should return all registered services', function() {
      store.load();
      store.register('zm2-app1', { name: 'app1' });
      store.register('zm2-app2', { name: 'app2' });
      var all = store.getAll();
      all.length.should.equal(2);
      all[0].should.have.property('serviceName');
    });

    it('should return empty array when no services', function() {
      store.load();
      store.getAll().length.should.equal(0);
    });
  });

  describe('count', function() {
    it('should return the number of services', function() {
      store.load();
      store.count().should.equal(0);
      store.register('zm2-app1', { name: 'app1' });
      store.count().should.equal(1);
    });
  });

  describe('clear', function() {
    it('should remove all state', function() {
      store.load();
      store.register('zm2-app1', { name: 'app1' });
      store.clear();
      store.count().should.equal(0);
      store.data.next_id.should.equal(1);
      fs.existsSync(storePath + '.lock').should.be.false();
    });
  });

  describe('transactions across stale clients', function() {
    it('should assign unique pm_ids when two clients loaded the same snapshot register', function() {
      var clientA = new StateStore(storePath);
      var clientB = new StateStore(storePath);
      clientA.load();
      clientB.load();

      var idA = clientA.register('zm2-a', { name: 'a' });
      var idB = clientB.register('zm2-b', { name: 'b' });

      idA.should.equal(1);
      idB.should.equal(2);

      var fresh = new StateStore(storePath);
      fresh.load();
      fresh.getAll().length.should.equal(2);
      fresh.get('zm2-a').pm_id.should.equal(1);
      fresh.get('zm2-b').pm_id.should.equal(2);
      fresh.data.next_id.should.equal(3);
    });

    it('should not resurrect entries removed by another client', function() {
      var stale = new StateStore(storePath);
      var live = new StateStore(storePath);
      stale.load();
      live.load();

      live.register('zm2-x', { name: 'x' });
      live.register('zm2-y', { name: 'y' });
      stale.unregister('zm2-x');

      var fresh = new StateStore(storePath);
      fresh.load();
      fresh.getAll().length.should.equal(1);
      should(fresh.get('zm2-x')).be.null();
      fresh.get('zm2-y').name.should.equal('y');
      fresh.data.next_id.should.equal(3);
    });

    it('should keep the existing pm_id when updating, even if metadata pins pm_id 0', function() {
      var first = new StateStore(storePath);
      first.load();
      first.register('zm2-api', { name: 'zm2_api', pm_id: 0 });

      var second = new StateStore(storePath);
      second.load();
      var id = second.register('zm2-api', { name: 'zm2_api_v2', pm_id: 99 });

      id.should.equal(0);
      var entry = second.get('zm2-api');
      entry.pm_id.should.equal(0);
      entry.name.should.equal('zm2_api_v2');
      second.data.next_id.should.equal(1);
    });

    it('should refresh reads from commits made by another client', function() {
      var reader = new StateStore(storePath);
      var writer = new StateStore(storePath);
      reader.load();
      writer.load();

      writer.register('zm2-myapp', { name: 'myapp' });

      reader.get('zm2-myapp').name.should.equal('myapp');
      reader.getByName('myapp').serviceName.should.equal('zm2-myapp');
      reader.getByPmId(1).name.should.equal('myapp');
      reader.count().should.equal(1);
      reader.getAll().length.should.equal(1);
    });

    it('should assign unique ids when multiple child processes register concurrently', function(done) {
      this.timeout(10000);

      var childCount = 6;
      var modulePath = path.resolve(__dirname, '..', '..', 'lib', 'Systemd', 'StateStore.js');
      var script = [
        'var StateStore = require(process.argv[1]);',
        'var store = new StateStore(process.argv[2], { lockTimeoutMs: 5000 });',
        'var serviceName = process.argv[3];',
        'store.load();',
        'process.on("message", function(message) {',
        '  if (message !== "go") return;',
        '  try {',
        '    store.register(serviceName, { name: serviceName });',
        '    process.exit(0);',
        '  } catch (e) {',
        '    console.error(e.stack || e);',
        '    process.exit(1);',
        '  }',
        '});',
        'process.send("ready");'
      ].join('\n');

      var children = [];
      var ready = 0;
      var closed = 0;
      var finished = false;

      function finish(err) {
        if (finished) return;
        finished = true;
        done(err);
      }

      function maybeStart() {
        if (ready !== childCount) return;
        children.forEach(function(child) { child.send('go'); });
      }

      for (var i = 0; i < childCount; i++) {
        var child = childProcess.spawn(process.execPath, [
          '-e', script, modulePath, storePath, 'zm2-child-' + i
        ], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        children.push(child);

        child.stderr.on('data', function(chunk) {
          if (chunk.toString().trim()) {
            finish(new Error('child failed: ' + chunk.toString()));
          }
        });

        child.on('message', function(message) {
          if (message !== 'ready') return;
          ready++;
          maybeStart();
        });

        child.on('error', finish);

        child.on('close', function(code) {
          if (code !== 0) return finish(new Error('child exited with code ' + code));
          closed++;
          if (closed !== childCount) return;

          try {
            var fresh = new StateStore(storePath);
            fresh.load();
            var entries = fresh.getAll();
            entries.length.should.equal(childCount);
            var ids = entries.map(function(entry) { return entry.pm_id; }).sort(function(a, b) {
              return a - b;
            });
            ids.should.eql([1, 2, 3, 4, 5, 6]);
            fresh.data.next_id.should.equal(7);
            finish();
          } catch (e) {
            finish(e);
          }
        });
      }
    });
  });

  describe('atomic persistence and failures', function() {
    it('should commit with owner-only permissions without leftovers', function() {
      store.load();
      store.register('zm2-myapp', { name: 'myapp' });

      (fs.statSync(storePath).mode & 0o777).should.equal(0o600);
      fs.existsSync(storePath + '.lock').should.be.false();
      listTempFiles(tmpDir).should.eql([]);
    });

    it('should preserve prior state and release the lock when writing fails', function() {
      store.load();
      store.register('zm2-original', { name: 'original' });
      var before = fs.readFileSync(storePath, 'utf8');

      var originalWriteFileSync = fs.writeFileSync;
      fs.writeFileSync = function(file, data) {
        if (typeof file === 'number' &&
            typeof data === 'string' &&
            data.indexOf('"services"') !== -1) {
          throw new Error('simulated write failure');
        }
        return originalWriteFileSync.apply(fs, arguments);
      };

      try {
        expectThrows(function() {
          store.register('zm2-new', { name: 'new' });
        }, /simulated write failure/);
      } finally {
        fs.writeFileSync = originalWriteFileSync;
      }

      fs.readFileSync(storePath, 'utf8').should.equal(before);
      fs.existsSync(storePath + '.lock').should.be.false();
      listTempFiles(tmpDir).should.eql([]);

      var fresh = new StateStore(storePath);
      fresh.load();
      fresh.getAll().length.should.equal(1);
      fresh.get('zm2-original').name.should.equal('original');
    });

    it('should preserve prior state and release the lock when rename fails', function() {
      store.load();
      store.register('zm2-original', { name: 'original' });
      var before = fs.readFileSync(storePath, 'utf8');

      var originalRenameSync = fs.renameSync;
      fs.renameSync = function(source, destination) {
        if (destination === storePath) throw new Error('simulated rename failure');
        return originalRenameSync.apply(fs, arguments);
      };

      try {
        expectThrows(function() {
          store.register('zm2-new', { name: 'new' });
        }, /simulated rename failure/);
      } finally {
        fs.renameSync = originalRenameSync;
      }

      fs.readFileSync(storePath, 'utf8').should.equal(before);
      fs.existsSync(storePath + '.lock').should.be.false();
      listTempFiles(tmpDir).should.eql([]);

      store.register('zm2-new', { name: 'new' }).should.equal(2);
      var fresh = new StateStore(storePath);
      fresh.load();
      fresh.getAll().length.should.equal(2);
    });

    it('should refuse to mutate a corrupt state file and keep it untouched', function() {
      var corrupt = '{"services": {"zm2-old": {"pm_id": 1}}, "next_id": 2';
      fs.writeFileSync(storePath, corrupt);

      var corruptStore = new StateStore(storePath);
      corruptStore.load();
      corruptStore.count().should.equal(0);

      expectThrows(function() {
        corruptStore.register('zm2-new', { name: 'new' });
      }, /corrupt|refus/i);

      fs.readFileSync(storePath, 'utf8').should.equal(corrupt);
      fs.existsSync(storePath + '.lock').should.be.false();
      listTempFiles(tmpDir).should.eql([]);
    });

    it('should refuse to mutate a state file with an invalid structure', function() {
      var invalid = JSON.stringify({ services: [], next_id: 1 });
      fs.writeFileSync(storePath, invalid);

      var invalidStore = new StateStore(storePath);

      expectThrows(function() {
        invalidStore.register('zm2-new', { name: 'new' });
      }, /invalid|refus/i);

      fs.readFileSync(storePath, 'utf8').should.equal(invalid);
      fs.existsSync(storePath + '.lock').should.be.false();
    });

    it('should refuse to mutate an unreadable state file', function() {
      store.load();
      store.register('zm2-original', { name: 'original' });
      var before = fs.readFileSync(storePath, 'utf8');

      var originalReadFileSync = fs.readFileSync;
      fs.readFileSync = function(filePath, encoding) {
        if (filePath === storePath) {
          var error = new Error('permission denied');
          error.code = 'EACCES';
          throw error;
        }
        return originalReadFileSync.apply(fs, arguments);
      };

      try {
        var fresh = new StateStore(storePath);
        expectThrows(function() {
          fresh.register('zm2-new', { name: 'new' });
        }, /cannot read|permission denied|refus/i);
      } finally {
        fs.readFileSync = originalReadFileSync;
      }

      fs.readFileSync(storePath, 'utf8').should.equal(before);
      fs.existsSync(storePath + '.lock').should.be.false();
    });

    it('should fail in bounded time when the lock is held by another process', function() {
      fs.writeFileSync(storePath + '.lock', JSON.stringify({ pid: 999999 }));
      var locked = new StateStore(storePath, { lockTimeoutMs: 150, lockRetryMs: 10 });

      var start = Date.now();
      var error = expectThrows(function() {
        locked.register('zm2-new', { name: 'new' });
      }, /timed out|lock/i);
      var elapsed = Date.now() - start;

      error.message.indexOf(storePath + '.lock').should.not.equal(-1);
      elapsed.should.be.aboveOrEqual(100);
      elapsed.should.be.below(1000);
      fs.existsSync(storePath + '.lock').should.be.true();
      fs.existsSync(storePath).should.be.false();
    });

    it('should reject save() when another client committed after this snapshot', function() {
      var first = new StateStore(storePath);
      var second = new StateStore(storePath);
      first.load();
      second.load();

      second.register('zm2-second', { name: 'second' });

      expectThrows(function() {
        first.save();
      }, /stale|another process|reload/i);

      fs.existsSync(storePath + '.lock').should.be.false();
      var fresh = new StateStore(storePath);
      fresh.load();
      fresh.getAll().length.should.equal(1);
      fresh.get('zm2-second').name.should.equal('second');

      first.load();
      first.save().should.equal(first);
      fs.existsSync(storePath + '.lock').should.be.false();
    });
  });
});
