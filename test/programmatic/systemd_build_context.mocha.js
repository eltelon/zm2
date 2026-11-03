'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var spawnSync = require('child_process').spawnSync;
var root = path.resolve(__dirname, '../..');

describe('systemd build context allowlist', function() {
  it('copies required sources but excludes local credentials, dependencies and unrelated files', function() {
    var temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zm2-context-test-'));
    var fixture = path.join(root, 'test/fixtures/systemd-express');
    var canary = '.env.zm2-context-canary-' + process.pid;
    var canaryPath = path.join(fixture, canary);
    fs.writeFileSync(canaryPath, 'dummy-not-a-secret');
    try {
      var dest = path.join(temp, 'context');
      var result = spawnSync('bash', [path.join(root, 'test/systemd/build-context.sh'), dest], { encoding: 'utf8' });
      assert.strictEqual(result.status, 0, result.stderr);
      ['bin/zm2', 'lib/API.js', 'package.json', 'test/fixtures/systemd-express/server.js',
        'test/e2e/systemd/update-node.sh', 'test/systemd/Dockerfile', '.dockerignore'].forEach(function(file) {
        assert.ok(fs.existsSync(path.join(dest, file)), file);
      });
      ['.git', 'node_modules', 'README.md', 'test/fixtures/systemd-express/node_modules',
        'test/fixtures/systemd-express/' + canary].forEach(function(file) {
        assert.ok(!fs.existsSync(path.join(dest, file)), file);
      });
      var rejected = spawnSync('bash', [path.join(root, 'test/systemd/build-context.sh'), dest], { encoding: 'utf8' });
      assert.notStrictEqual(rejected.status, 0, 'nonempty contexts must be rejected');
    } finally {
      fs.rmSync(canaryPath, { force: true });
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
