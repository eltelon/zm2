'use strict';

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/, '');
}

var target = normalizeVersion(process.env.ZM2_NODE_TARGET);

// Fail only when this process is already running on the requested runtime.
// On the previous runtime it stays alive, which lets the test prove rollback.
if (target && normalizeVersion(process.version) === target) {
  console.error('[update-node-e2e] incompatible fixture exiting on ' + process.version);
  process.exit(1);
}

setInterval(function() {}, 1000);
