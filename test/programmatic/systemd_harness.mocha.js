'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var spawnSync = require('child_process').spawnSync;
var yaml = require('js-yaml');
var root = path.resolve(__dirname, '../..');
var runner = path.join(root, 'test/systemd/run.sh');

describe('isolated systemd harness host guards', function() {
  var temp;
  var calls;

  beforeEach(function() {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zm2-harness-guard-'));
    calls = path.join(temp, 'calls');
    fs.writeFileSync(path.join(temp, 'docker'), '#!/bin/bash\n' +
      'printf "%s\\n" "$*" >> "$FAKE_CALLS"\n' +
      'if [[ "${FAKE_UP_FAIL:-}" == 1 ]]; then\n' +
      '  case "$*" in\n' +
      '    *"compose -f"*" config") printf "services: {}\\n"; exit 0 ;;\n' +
      '    *"compose -f"*" build") exit 0 ;;\n' +
      '    *"compose -f"*" up -d") exit 23 ;;\n' +
      '    *"compose -f"*" ps -a -q sandbox") printf "fixture-created\\n"; exit 0 ;;\n' +
      '    *" logs fixture-created"|*" inspect fixture-created "*|*" cp fixture-created:"*|*"compose -f"*" exec "*|*"compose -f"*" down "*) exit 0 ;;\n' +
      '  esac\n' +
      'fi\n' +
      'case "$*" in\n' +
      '  *"context inspect"*) printf "%s\\n" "$FAKE_ENDPOINT" ;;\n' +
      '  *"info --format"*) printf "%s\\n" "${FAKE_BACKEND:-linux 2 aarch64}" ;;\n' +
      '  *"compose version"*) printf "5.4.0\\n" ;;\n' +
      '  *) printf "unexpected docker mutation\\n" >&2; exit 99 ;;\n' +
      'esac\n', { mode: 0o700 });
  });

  afterEach(function() { fs.rmSync(temp, { recursive: true, force: true }); });

  function run(overrides, args) {
    var env = Object.assign({}, process.env, {
      PATH: temp + ':' + process.env.PATH,
      FAKE_CALLS: calls,
      FAKE_ENDPOINT: 'unix://' + os.homedir() + '/.colima/zm2-systemd-test/docker.sock'
    });
    delete env.ZM2_SYSTEMD_E2E;
    delete env.ZM2_SYSTEMD_CONTEXT;
    delete env.DOCKER_HOST;
    delete env.DOCKER_CONTEXT;
    Object.assign(env, overrides);
    return spawnSync('bash', [runner].concat(args || ['--preflight']), { env: env, encoding: 'utf8' });
  }

  function noDocker() {
    assert.strictEqual(fs.existsSync(calls), false, 'Docker must not be invoked');
  }

  it('refuses execution without explicit opt-in before invoking Docker', function() {
    var result = run({});
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /ZM2_SYSTEMD_E2E=1/);
    noDocker();
  });

  it('refuses a different Docker context before invoking Docker', function() {
    var result = run({ ZM2_SYSTEMD_E2E: '1', ZM2_SYSTEMD_CONTEXT: 'default' });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /context/i);
    noDocker();
  });

  it('rejects ambient remote Docker overrides', function() {
    var result = run({ ZM2_SYSTEMD_E2E: '1', DOCKER_HOST: 'ssh://production' });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /DOCKER_HOST/);
    noDocker();
  });

  it('rejects a conflicting ambient Docker context', function() {
    var result = run({ ZM2_SYSTEMD_E2E: '1', DOCKER_CONTEXT: 'production' });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /DOCKER_CONTEXT/);
    noDocker();
  });

  it('rejects a backend without Linux cgroups v2 before Compose', function() {
    var result = run({ ZM2_SYSTEMD_E2E: '1', FAKE_BACKEND: 'linux 1 aarch64' });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /cgroups v2/);
    assert.ok(!/compose/.test(fs.readFileSync(calls, 'utf8')));
  });

  it('rejects a context redirected away from the disposable local socket', function() {
    var result = run({ ZM2_SYSTEMD_E2E: '1', FAKE_ENDPOINT: 'unix:///var/run/docker.sock' });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /socket|endpoint/i);
    assert.ok(!/info|compose|run|build/.test(fs.readFileSync(calls, 'utf8')));
  });

  it('collects a partially created container before cleanup and preserves startup failure', function() {
    var parent = path.join(temp, 'results');
    var result = run({ ZM2_SYSTEMD_E2E: '1', ZM2_SYSTEMD_RESULTS: parent,
      ZM2_SYSTEMD_KEEP: '0', FAKE_UP_FAIL: '1' }, []);
    assert.strictEqual(result.status, 23, result.stderr);
    var commands = fs.readFileSync(calls, 'utf8');
    assert.ok(commands.includes('ps -a -q sandbox'), commands);
    assert.ok(commands.includes('logs fixture-created'), commands);
    assert.ok(commands.includes('cp fixture-created:/var/lib/zm2-evidence/.'), commands);
    assert.ok(commands.indexOf('cp fixture-created:') < commands.indexOf('down --volumes'), commands);
    var results = path.join(parent, fs.readdirSync(parent)[0]);
    assert.strictEqual(fs.readFileSync(path.join(results, 'exit-code.txt'), 'utf8').trim(), '23');
  });

  it('preflight inspects only the explicit isolated endpoint without mutation', function() {
    var results = path.join(temp, 'must-not-be-created');
    var result = run({ ZM2_SYSTEMD_E2E: '1', ZM2_SYSTEMD_RESULTS: results });
    assert.strictEqual(fs.existsSync(results), false);
    assert.strictEqual(result.status, 0, result.stderr);
    var commands = fs.readFileSync(calls, 'utf8').trim().split('\n');
    assert.strictEqual(commands.length, 3);
    commands.forEach(function(command) {
      assert.ok(command.startsWith('--context colima-zm2-systemd-test '), command);
      assert.ok(/context inspect|info --format|compose version/.test(command), command);
    });
  });
});

describe('systemd harness isolation configuration', function() {
  it('uses private cgroups and tmpfs, without host mounts or published ports', function() {
    var config = yaml.load(fs.readFileSync(path.join(root, 'test/systemd/compose.yaml'), 'utf8'));
    var service = config.services.sandbox;
    assert.strictEqual(service.privileged, true);
    assert.strictEqual(service.cgroup, 'private');
    assert.ok(!service.volumes || service.volumes.length === 0);
    assert.ok(!service.ports || service.ports.length === 0);
    assert.ok(!service.network_mode);
    assert.deepStrictEqual(service.command, ['/sbin/init']);
    assert.ok(service.tmpfs.some(function(entry) { return entry.split(':')[0] === '/run'; }));
    assert.ok(service.tmpfs.some(function(entry) { return entry.split(':')[0] === '/tmp'; }));
  });

  it('excludes all build files except an explicit source allowlist', function() {
    var ignore = fs.readFileSync(path.join(root, 'test/systemd/Dockerfile.dockerignore'), 'utf8');
    assert.strictEqual(ignore.split('\n')[0], '**');
    assert.ok(!/^!\*|^!\/$/m.test(ignore));
    ['!bin/**', '!lib/**', '!test/fixtures/systemd-express/server.js'].forEach(function(rule) {
      assert.ok(ignore.split('\n').includes(rule), rule);
    });
    assert.ok(!ignore.includes('!test/fixtures/systemd-express/**'));
  });
});
