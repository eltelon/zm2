#!/usr/bin/env node

/**
 * ZM2 API Server — Standalone entry point for systemd.
 *
 * Reads configuration from environment variables:
 *   ZM2_HOME     — Path to ZM2 home directory (default: ~/.zm2)
 *   ZM2_API_PORT — Port to listen on (default: 9615)
 *   ZM2_API_HOST — Host to bind to (default: 127.0.0.1)
 */

'use strict';

var path = require('path');
var HttpApi = require('./HttpApi');

// Read config from environment
var zm2Home = process.env.ZM2_HOME || path.resolve(process.env.HOME || '/root', '.zm2');
var port = parseInt(process.env.ZM2_API_PORT, 10) || 9615;
var host = process.env.ZM2_API_HOST || '127.0.0.1';
var keyPath = path.join(zm2Home, 'api-key');

// Override ZM2_HOME so API constructor picks it up
process.env.ZM2_HOME = zm2Home;

var API = require('../API');
var api = new API({ daemon_mode: false });

api.Client.start(function(err) {
  if (err) {
    console.error('[ZM2 API] Failed to connect to systemd:', err.message);
    process.exit(1);
  }

  var apiKey = HttpApi.loadOrCreateApiKey(keyPath);
  var server = HttpApi.createServer(api, apiKey);

  server.listen(port, host, function() {
    console.log('[ZM2 API] Listening on ' + host + ':' + port);
    console.log('[ZM2 API] Prometheus metrics at /metrics');
  });

  server.on('error', function(err) {
    console.error('[ZM2 API] Server error:', err.message);
    process.exit(1);
  });

  process.on('SIGTERM', function() {
    console.log('[ZM2 API] Shutting down...');
    server.close(function() {
      api.Client.close(function() {
        process.exit(0);
      });
    });
  });
});
