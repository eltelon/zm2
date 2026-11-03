'use strict';

var express = require('express');

var DEFAULT_HOST = '127.0.0.1';
var DEFAULT_PORT = 3000;
var READY_MARKER = 'ZM2_EXPRESS_READY';

function normalizeVersion(value) {
  return String(value).trim().replace(/^v/, '');
}

function resolveConfig(env) {
  env = env || process.env;

  var host = env.HOST === undefined || env.HOST === '' ? DEFAULT_HOST : env.HOST;
  var rawPort = env.PORT === undefined || env.PORT === ''
    ? String(DEFAULT_PORT)
    : env.PORT;
  var port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Invalid PORT value: ' + rawPort);
  }

  return {
    host: host,
    port: port,
    failOnNodeVersion: env.FAIL_ON_NODE_VERSION
      ? normalizeVersion(env.FAIL_ON_NODE_VERSION)
      : null
  };
}

function versionFailure(config) {
  if (!config.failOnNodeVersion) return null;
  if (config.failOnNodeVersion === normalizeVersion(process.version)) {
    return 'Refusing to start: FAIL_ON_NODE_VERSION matches ' + process.version;
  }
  return null;
}

function createApp() {
  var app = express();
  app.disable('x-powered-by');
  app.get('/health', function(req, res) {
    res.json({
      status: 'ok',
      pid: process.pid,
      node: process.version
    });
  });
  return app;
}

function main() {
  var config = resolveConfig(process.env);
  var failure = versionFailure(config);
  if (failure) {
    console.error(failure);
    process.exitCode = 1;
    return;
  }

  var server = createApp().listen(config.port, config.host, function() {
    console.log(READY_MARKER);
  });

  function shutdown() {
    server.close(function() {
      process.exit(0);
    });
  }

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_HOST: DEFAULT_HOST,
  DEFAULT_PORT: DEFAULT_PORT,
  READY_MARKER: READY_MARKER,
  createApp: createApp,
  normalizeVersion: normalizeVersion,
  resolveConfig: resolveConfig,
  versionFailure: versionFailure
};