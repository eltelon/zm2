'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var http = require('http');
var net = require('net');
var path = require('path');

var FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'systemd-express');
var SERVER_PATH = path.join(FIXTURE_DIR, 'server.js');
var READY_MARKER = 'ZM2_EXPRESS_READY';
var running = [];

function delay(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

function freePort() {
  return new Promise(function(resolve, reject) {
    var server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function() {
      var port = server.address().port;
      server.close(function(err) {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function spawnFixture(overrides) {
  var env = Object.assign({}, process.env);
  ['HOST', 'PORT', 'FAIL_ON_NODE_VERSION'].forEach(function(name) {
    delete env[name];
  });
  Object.assign(env, overrides || {});

  var child = childProcess.spawn(process.execPath, [SERVER_PATH], {
    cwd: FIXTURE_DIR,
    env: env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  var fixture = { child: child, stdout: '', stderr: '', exit: null };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', function(chunk) {
    fixture.stdout += chunk;
  });
  child.stderr.on('data', function(chunk) {
    fixture.stderr += chunk;
  });
  fixture.exitPromise = new Promise(function(resolve) {
    child.once('exit', function(code, signal) {
      fixture.exit = { code: code, signal: signal };
      resolve(fixture.exit);
    });
  });
  running.push(fixture);
  return fixture;
}

async function waitForMarker(fixture, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 8000);
  while (Date.now() < deadline) {
    if (fixture.stdout.indexOf(READY_MARKER) !== -1) return;
    if (fixture.exit) {
      throw new Error('fixture exited before ' + READY_MARKER +
        ' (code=' + fixture.exit.code + ', signal=' + fixture.exit.signal +
        '); stderr=' + JSON.stringify(fixture.stderr));
    }
    await delay(20);
  }
  throw new Error('timed out waiting for ' + READY_MARKER +
    '; stdout=' + JSON.stringify(fixture.stdout) +
    '; stderr=' + JSON.stringify(fixture.stderr));
}

async function waitForExit(fixture, timeoutMs) {
  if (fixture.exit) return fixture.exit;
  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      reject(new Error('timed out waiting for fixture exit; stdout=' +
        JSON.stringify(fixture.stdout) + '; stderr=' +
        JSON.stringify(fixture.stderr)));
    }, timeoutMs || 8000);
    fixture.exitPromise.then(function(exit) {
      clearTimeout(timer);
      resolve(exit);
    });
  });
}

function waitForExitWithin(fixture, timeoutMs) {
  if (fixture.exit) return Promise.resolve(fixture.exit);
  return new Promise(function(resolve) {
    var timer = setTimeout(function() { resolve(null); }, timeoutMs);
    fixture.exitPromise.then(function(exit) {
      clearTimeout(timer);
      resolve(exit);
    });
  });
}

function requestHealth(port) {
  return new Promise(function(resolve, reject) {
    var request = http.get({
      host: '127.0.0.1',
      port: port,
      path: '/health',
      timeout: 3000
    }, function(response) {
      var body = '';
      response.setEncoding('utf8');
      response.on('data', function(chunk) {
        body += chunk;
      });
      response.on('end', function() {
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: body
        });
      });
    });
    request.on('timeout', function() {
      request.destroy(new Error('health request timed out'));
    });
    request.on('error', reject);
  });
}

async function waitForHealth(port, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 5000);
  var lastError = null;
  while (Date.now() < deadline) {
    try {
      var response = await requestHealth(port);
      if (response.statusCode === 200) return response;
      lastError = new Error('health returned status ' + response.statusCode);
    } catch (err) {
      lastError = err;
    }
    await delay(25);
  }
  throw lastError || new Error('health endpoint did not become available');
}

async function stopFixture(fixture) {
  if (!fixture || !fixture.child || fixture.exit) return;
  fixture.child.kill('SIGTERM');
  var exited = await waitForExitWithin(fixture, 2000);
  if (!exited && !fixture.exit) {
    fixture.child.kill('SIGKILL');
    await fixture.exitPromise;
  }
}

describe('systemd Express fixture', function() {
  afterEach(async function() {
    var fixtures = running;
    running = [];
    for (var i = 0; i < fixtures.length; i++) {
      await stopFixture(fixtures[i]);
    }
  });

  it('defaults HOST to 127.0.0.1 and PORT to 3000', function() {
    var fixture = require(SERVER_PATH);
    assert.deepStrictEqual(fixture.resolveConfig({}), {
      host: '127.0.0.1',
      port: 3000,
      failOnNodeVersion: null
    });
  });

  it('serves /health with the fixture pid and Node version on a dynamic port', async function() {
    var port = await freePort();
    var fixture = spawnFixture({ PORT: String(port) });

    await waitForMarker(fixture);
    var response = await waitForHealth(port);

    assert.strictEqual(response.statusCode, 200);
    assert.match(response.headers['content-type'], /^application\/json/);
    assert.deepStrictEqual(JSON.parse(response.body), {
      status: 'ok',
      pid: fixture.child.pid,
      node: process.version
    });
  });

  it('prints ZM2_EXPRESS_READY on stdout after listening', async function() {
    var port = await freePort();
    var fixture = spawnFixture({
      HOST: '127.0.0.1',
      PORT: String(port)
    });

    await waitForMarker(fixture);
    await waitForHealth(port);

    var lines = fixture.stdout.split(/\r?\n/);
    assert.ok(lines.indexOf(READY_MARKER) !== -1,
      'expected exact marker line in stdout: ' + JSON.stringify(fixture.stdout));
  });

  it('exits nonzero before listening when FAIL_ON_NODE_VERSION matches process.version', async function() {
    var port = await freePort();
    var fixture = spawnFixture({
      HOST: '127.0.0.1',
      PORT: String(port),
      FAIL_ON_NODE_VERSION: process.version
    });

    var exit = await waitForExit(fixture);

    assert.notStrictEqual(exit.code, 0);
    assert.strictEqual(fixture.stdout.indexOf(READY_MARKER), -1);
    assert.notStrictEqual(fixture.stderr.trim(), '');
  });

  it('matches FAIL_ON_NODE_VERSION with an optional v prefix', async function() {
    var port = await freePort();
    var requested = process.version.replace(/^v/, '');
    assert.notStrictEqual(requested, process.version);

    var fixture = spawnFixture({
      HOST: '127.0.0.1',
      PORT: String(port),
      FAIL_ON_NODE_VERSION: requested
    });

    var exit = await waitForExit(fixture);

    assert.notStrictEqual(exit.code, 0);
    assert.strictEqual(fixture.stdout.indexOf(READY_MARKER), -1);
  });

  it('starts normally when FAIL_ON_NODE_VERSION differs from process.version', async function() {
    var port = await freePort();
    var requested = '0.0.0';
    assert.notStrictEqual(requested, process.version.replace(/^v/, ''));

    var fixture = spawnFixture({
      HOST: '127.0.0.1',
      PORT: String(port),
      FAIL_ON_NODE_VERSION: requested
    });

    await waitForMarker(fixture);
    var response = await waitForHealth(port);

    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), {
      status: 'ok',
      pid: fixture.child.pid,
      node: process.version
    });
  });
});