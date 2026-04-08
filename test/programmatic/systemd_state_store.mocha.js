
var should = require('should');
var fs = require('fs');
var path = require('path');
var os = require('os');
var StateStore = require('../../lib/Systemd/StateStore');

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
    });
  });
});
