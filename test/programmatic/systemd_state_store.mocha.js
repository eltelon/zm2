
var should = require('should');
var fs = require('fs');
var path = require('path');
var os = require('os');
var StateStore = require('../../lib/Systemd/StateStore');

function withFsMethod(name, replacement, fn) {
  var original = fs[name];
  fs[name] = replacement;
  try {
    return fn();
  } finally {
    fs[name] = original;
  }
}

function tempFiles(dir) {
  return fs.readdirSync(dir).filter(function(name) {
    return /\.tmp$/.test(name);
  });
}

function fsError(code) {
  var err = new Error(code + ': simulated failure');
  err.code = code;
  return err;
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

    it('should create default state for a missing file in strict mode', function() {
      store.load({ strict: true });
      store.data.should.eql({ services: {}, next_id: 1 });
    });

    it('should load a valid state unchanged in strict mode', function() {
      var state = {
        services: {
          'zm2-app': { pm_id: 1, name: 'app', script: '/app.js' },
          'zm2-api': { pm_id: 0, name: 'zm2_api', script: '/api.js' }
        },
        next_id: 2
      };
      fs.writeFileSync(storePath, JSON.stringify(state));
      store.load({ strict: true });
      store.data.should.eql(state);
    });

    it('should throw on corrupted JSON in strict mode', function() {
      fs.writeFileSync(storePath, 'not valid json{{{');
      (function() {
        store.load({ strict: true });
      }).should.throw();
    });

    it('should throw on read errors in strict mode', function() {
      var denied = fsError('EACCES');
      withFsMethod('readFileSync', function() { throw denied; }, function() {
        var thrown;
        try {
          store.load({ strict: true });
        } catch (e) {
          thrown = e;
        }
        should(thrown).equal(denied);
      });
    });

    it('should keep tolerant read errors as an empty state', function() {
      withFsMethod('readFileSync', function() { throw fsError('EACCES'); }, function() {
        store.load();
      });
      store.data.should.eql({ services: {}, next_id: 1 });
    });

    it('should reject a non-object state or services in strict mode', function() {
      [
        { services: null, next_id: 1 },
        { services: [], next_id: 1 },
        { services: 'invalid', next_id: 1 },
        [],
        null
      ].forEach(function(state) {
        fs.writeFileSync(storePath, JSON.stringify(state));
        (function() {
          store.load({ strict: true });
        }).should.throw(/Invalid state/);
      });
    });

    it('should reject non-object service metadata in strict mode', function() {
      [
        { services: { 'zm2-app': null }, next_id: 1 },
        { services: { 'zm2-app': [] }, next_id: 1 },
        { services: { 'zm2-app': 'metadata' }, next_id: 1 }
      ].forEach(function(state) {
        fs.writeFileSync(storePath, JSON.stringify(state));
        (function() {
          store.load({ strict: true });
        }).should.throw(/Invalid state/);
      });
    });

    it('should reject malformed IDs in strict mode', function() {
      [
        { services: {}, next_id: 0 },
        { services: {}, next_id: -1 },
        { services: {}, next_id: 1.5 },
        { services: {}, next_id: '2' },
        { services: {} },
        { services: { 'zm2-app': { pm_id: -1 } }, next_id: 1 },
        { services: { 'zm2-app': { pm_id: 1.5 } }, next_id: 1 },
        { services: { 'zm2-app': { pm_id: '1' } }, next_id: 1 },
        { services: { 'zm2-app': { name: 'app' } }, next_id: 1 }
      ].forEach(function(state) {
        fs.writeFileSync(storePath, JSON.stringify(state));
        (function() {
          store.load({ strict: true });
        }).should.throw(/Invalid state/);
      });
    });
  });

  describe('save', function() {
    it('should write through an exclusive temporary file in the same directory', function() {
      fs.writeFileSync(storePath, JSON.stringify({ services: {}, next_id: 1 }));
      store.load();
      var opened = [];
      var originalOpenSync = fs.openSync;
      withFsMethod('openSync', function(filePath, flags) {
        opened.push({ filePath: filePath, flags: flags });
        return originalOpenSync.apply(fs, arguments);
      }, function() {
        store.save();
      });

      opened.length.should.equal(1);
      path.dirname(opened[0].filePath).should.equal(tmpDir);
      opened[0].flags.should.equal('wx');
    });

    it('should not truncate the previous file and should remove the temp file when rename fails', function() {
      var state = { services: { 'zm2-app': { pm_id: 1, name: 'app' } }, next_id: 2 };
      fs.writeFileSync(storePath, JSON.stringify(state, null, 2));
      store.load();
      var before = fs.readFileSync(storePath, 'utf8');

      withFsMethod('renameSync', function() { throw fsError('EIO'); }, function() {
        (function() {
          store.save();
        }).should.throw(/EIO/);
      });

      fs.readFileSync(storePath, 'utf8').should.equal(before);
      tempFiles(tmpDir).length.should.equal(0);
    });

    it('should remove the temp file when writing fails', function() {
      var state = { services: {}, next_id: 1 };
      fs.writeFileSync(storePath, JSON.stringify(state, null, 2));
      store.load();
      var before = fs.readFileSync(storePath, 'utf8');
      var opened = null;
      var originalOpenSync = fs.openSync;

      withFsMethod('openSync', function(filePath, flags) {
        opened = filePath;
        return originalOpenSync.apply(fs, arguments);
      }, function() {
        withFsMethod('writeFileSync', function() { throw fsError('ENOSPC'); }, function() {
          (function() {
            store.save();
          }).should.throw(/ENOSPC/);
        });
      });

      should(opened).be.a.String();
      fs.existsSync(opened).should.be.false();
      fs.readFileSync(storePath, 'utf8').should.equal(before);
      tempFiles(tmpDir).length.should.equal(0);
    });

    it('should preserve the existing file mode, uid and gid', function() {
      fs.writeFileSync(storePath, JSON.stringify({ services: {}, next_id: 1 }));
      fs.chmodSync(storePath, 0o640);
      var before = fs.statSync(storePath);

      store.load();
      store.register('zm2-app', { name: 'app' });

      var after = fs.statSync(storePath);
      (after.mode & 0o777).should.equal(0o640);
      after.uid.should.equal(before.uid);
      after.gid.should.equal(before.gid);
      tempFiles(tmpDir).length.should.equal(0);
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

  describe('replace', function() {
    var initialState;

    beforeEach(function() {
      initialState = {
        services: {
          'zm2-app': {
            pm_id: 3,
            name: 'app',
            script: '/old.js',
            exec_interpreter: '/old/node',
            created_at: 111,
            updated_at: 222,
            extra: 'remove-me'
          },
          'zm2-other': {
            pm_id: 1,
            name: 'other',
            script: '/other.js',
            created_at: 100,
            updated_at: 100
          }
        },
        next_id: 4
      };
      fs.writeFileSync(storePath, JSON.stringify(initialState, null, 2));
      store.load();
    });

    it('should replace an existing entry exactly without merging or touching other entries', function() {
      var replacement = {
        pm_id: 3,
        name: 'app',
        script: '/old.js',
        exec_interpreter: '/old/node',
        created_at: 111,
        updated_at: 222
      };

      store.replace('zm2-app', replacement).should.equal(store);

      store.get('zm2-app').should.eql(replacement);
      should(store.get('zm2-app').extra).be.undefined();
      store.get('zm2-other').should.eql(initialState.services['zm2-other']);
      store.data.next_id.should.equal(4);

      var onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      onDisk.should.eql(store.data);
      onDisk.services['zm2-app'].should.eql(replacement);
      should(onDisk.services['zm2-app'].extra).be.undefined();
    });

    it('should reject replacing a missing service without changing memory or disk', function() {
      var before = fs.readFileSync(storePath, 'utf8');
      var beforeMemory = JSON.parse(JSON.stringify(store.data));

      (function() {
        store.replace('zm2-missing', { pm_id: 9, name: 'missing' });
      }).should.throw(/missing/i);

      store.data.should.eql(beforeMemory);
      fs.readFileSync(storePath, 'utf8').should.equal(before);
    });

    it('should keep memory consistent with the previous disk state when saving fails', function() {
      var before = fs.readFileSync(storePath, 'utf8');
      var beforeMemory = JSON.parse(JSON.stringify(store.data));

      withFsMethod('renameSync', function() { throw fsError('EIO'); }, function() {
        (function() {
          store.replace('zm2-app', {
            pm_id: 3,
            name: 'app',
            script: '/new.js',
            exec_interpreter: '/new/node',
            created_at: 111,
            updated_at: 222
          });
        }).should.throw(/EIO/);
      });

      store.data.should.eql(beforeMemory);
      fs.readFileSync(storePath, 'utf8').should.equal(before);
      tempFiles(tmpDir).length.should.equal(0);
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
    });
  });
});
