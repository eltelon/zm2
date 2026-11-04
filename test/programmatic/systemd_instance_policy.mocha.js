'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var Common = require('../../lib/Common');

describe('single-instance policy', function() {
  var policy;
  var dir;
  before(function() { policy = require('../../lib/Systemd/InstancePolicy'); });
  beforeEach(function() { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm2-instance-policy-')); });
  afterEach(function() { fs.rmSync(dir, { recursive: true, force: true }); });

  [undefined, 1, '1', 0, '0', 4, '4', 'max', -1].forEach(function(count) {
    it('normalizes ' + count + ' to one without changing application environment', function() {
      var env = { INSTANCES: '8', NODE_APP_INSTANCE: 'custom' };
      var conf = { instances: count, env: env };
      var warnings = [];
      policy.normalize(conf, function(message) { warnings.push(message); });
      assert.strictEqual(conf.instances, 1);
      assert.strictEqual(conf.env, env);
      assert.deepStrictEqual(env, { INSTANCES: '8', NODE_APP_INSTANCE: 'custom' });
      assert.strictEqual(warnings.length, count === undefined || count === 1 || count === '1' ? 0 : 1);
      if (warnings.length) assert.match(warnings[0], /single instance/i);
    });
  });

  [
    { serviceName: 'zm2-app', instances: 3 },
    { serviceName: 'zm2-app', instances: '2' },
    { serviceName: 'zm2-app@0', instances: 1 },
    { serviceName: 'zm2-app@.service', instances: 1 }
  ].forEach(function(entry) {
    it('rejects legacy ' + JSON.stringify(entry) + ' without rewriting metadata', function() {
      var before = JSON.stringify(entry);
      assert.throws(function() { policy.assertSingle(entry, { unitDir: dir }); }, function(err) {
        return err.code === 'ZM2_MULTI_INSTANCE_DISABLED' && /stop.*delete.*recreate/i.test(err.message);
      });
      assert.strictEqual(JSON.stringify(entry), before);
    });
  });

  it('rejects a template file even if metadata says one', function() {
    fs.writeFileSync(path.join(dir, 'zm2-app@.service'), '[Service]\n');
    assert.throws(function() {
      policy.assertSingle({ serviceName: 'zm2-app', instances: 1 }, { fs: fs, unitDir: dir });
    }, { code: 'ZM2_MULTI_INSTANCE_DISABLED' });
  });

  it('allows a single service with no template collision', function() {
    assert.doesNotThrow(function() {
      policy.assertSingle({ serviceName: 'zm2-app', instances: 1 }, { unitDir: dir });
    });
  });

  it('normalizes ecosystem configs before returning verified options', function() {
    var conf = Common.verifyConfs({ name: 'app', script: '/tmp/app.js', instances: 'max', env: { INSTANCES: '4' } });
    assert.ok(!(conf instanceof Error), String(conf));
    assert.strictEqual(conf[0].instances, 1);
    assert.strictEqual(conf[0].env.INSTANCES, '4');
  });
});
