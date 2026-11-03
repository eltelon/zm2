'use strict';

var should = require('should');
var fs = require('fs');
var path = require('path');
var os = require('os');
var Module = require('module');

var REAL_UNIT_DIR = '/etc/systemd/system';
var REAL_ENV_DIR = '/etc/zm2/env';
var SYSTEMD_PATH = require.resolve('../../lib/Systemd');

/**
 * Map production systemd paths into an isolated temporary root.
 * Any other path is returned untouched.
 */
function mapToTemp(tmpRoot, filePath) {
  if (filePath === REAL_UNIT_DIR) {
    return path.join(tmpRoot, 'systemd');
  }
  if (filePath.indexOf(REAL_UNIT_DIR + '/') === 0) {
    return path.join(tmpRoot, 'systemd', filePath.slice(REAL_UNIT_DIR.length + 1));
  }
  if (filePath === REAL_ENV_DIR) {
    return path.join(tmpRoot, 'env');
  }
  if (filePath.indexOf(REAL_ENV_DIR + '/') === 0) {
    return path.join(tmpRoot, 'env', filePath.slice(REAL_ENV_DIR.length + 1));
  }
  return filePath;
}

var PATH_FS_METHODS = [
  'existsSync',
  'mkdirSync',
  'unlinkSync',
  'writeFileSync',
  'openSync',
  'chmodSync',
  'statSync',
  'readFileSync'
];

/**
 * Build a minimal fs boundary that only redirects path-based calls.
 * File-descriptor calls are inherited from the real fs module.
 */
function createFsBoundary(tmpRoot) {
  var boundary = Object.create(fs);

  PATH_FS_METHODS.forEach(function(method) {
    var original = fs[method];
    if (typeof original !== 'function') return;

    boundary[method] = function(filePath) {
      var args = Array.prototype.slice.call(arguments);
      if (typeof args[0] === 'string') {
        args[0] = mapToTemp(tmpRoot, args[0]);
      }
      return original.apply(fs, args);
    };
  });

  return boundary;
}

/**
 * Load lib/Systemd.js with fs and child_process boundaries.
 * systemctl is always stubbed through Systemd._systemctl in tests.
 */
function loadSandbox(tmpRoot) {
  var fsBoundary = createFsBoundary(tmpRoot);
  var childProcessBoundary = {
    execFileSync: function() {
      throw new Error('unexpected child_process.execFileSync call');
    },
    spawn: function() {
      throw new Error('unexpected child_process.spawn call');
    }
  };

  var originalLoad = Module._load;
  Module._load = function(request) {
    if (request === 'fs') return fsBoundary;
    if (request === 'child_process') return childProcessBoundary;
    return originalLoad.apply(this, arguments);
  };

  delete require.cache[SYSTEMD_PATH];

  var Systemd;
  try {
    Systemd = require(SYSTEMD_PATH);
  } finally {
    Module._load = originalLoad;
  }

  return {
    Systemd: Systemd,
    fs: fsBoundary
  };
}

function installSystemctlStub(Systemd, failWhen) {
  var state = {
    calls: []
  };

  Systemd._systemctl = function(args) {
    state.calls.push(args.slice());
    if (failWhen) {
      var error = failWhen(args);
      if (error) throw error;
    }
    return '';
  };

  return state;
}

function captureError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

function fileMode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

function writeFixture(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '[fixture]\n', 'utf8');
}

function allFilesExist(filePaths) {
  return Object.keys(filePaths).every(function(key) {
    return fs.existsSync(filePaths[key]);
  });
}

function allFilesMissing(filePaths) {
  return Object.keys(filePaths).every(function(key) {
    return !fs.existsSync(filePaths[key]);
  });
}

describe('Systemd safety', function() {
  var tmpRoot;
  var sandbox;
  var unitRoot;
  var envRoot;
  var originalSystemdCache;

  beforeEach(function() {
    originalSystemdCache = require.cache[SYSTEMD_PATH];
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zm2-safety-'));
    unitRoot = path.join(tmpRoot, 'systemd');
    envRoot = path.join(tmpRoot, 'env');
    sandbox = loadSandbox(tmpRoot);
  });

  afterEach(function() {
    delete require.cache[SYSTEMD_PATH];
    if (originalSystemdCache) {
      require.cache[SYSTEMD_PATH] = originalSystemdCache;
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (e) { /* ignore */ }
  });

  function createSingleFiles(name, withTimer) {
    var files = {
      unit: path.join(unitRoot, name + '.service'),
      env: path.join(envRoot, name + '.env')
    };

    writeFixture(files.unit);
    writeFixture(files.env);

    if (withTimer !== false) {
      files.timer = path.join(unitRoot, name + '-cron.timer');
      files.timerService = path.join(unitRoot, name + '-cron.service');
      writeFixture(files.timer);
      writeFixture(files.timerService);
    }

    return files;
  }

  function createTemplateFiles(name) {
    var files = {
      template: path.join(unitRoot, name + '@.service'),
      env: path.join(envRoot, name + '.env'),
      timer: path.join(unitRoot, name + '-cron.timer'),
      timerService: path.join(unitRoot, name + '-cron.service')
    };

    Object.keys(files).forEach(function(key) {
      writeFixture(files[key]);
    });

    return files;
  }

  describe('writeEnvFile permissions', function() {
    it('should create the env directory with 0700 and a new file with 0600', function() {
      sandbox.Systemd.writeEnvFile('zm2-app', 'SECRET=value\n');

      var envPath = path.join(envRoot, 'zm2-app.env');
      fs.existsSync(envRoot).should.be.true();
      fs.existsSync(envPath).should.be.true();
      fileMode(envRoot).should.equal(0o700);
      fileMode(envPath).should.equal(0o600);
      fs.readFileSync(envPath, 'utf8').should.equal('SECRET=value\n');
    });

    it('should restrict an existing insecure directory and file before writing', function() {
      fs.mkdirSync(envRoot, { recursive: true });
      fs.chmodSync(envRoot, 0o755);

      var envPath = path.join(envRoot, 'zm2-app.env');
      fs.writeFileSync(envPath, 'OLD=value\n', 'utf8');
      fs.chmodSync(envPath, 0o644);

      sandbox.Systemd.writeEnvFile('zm2-app', 'NEW=value\n');

      fileMode(envRoot).should.equal(0o700);
      fileMode(envPath).should.equal(0o600);
      fs.readFileSync(envPath, 'utf8').should.equal('NEW=value\n');
    });

    it('should not write secrets when restricting the existing directory fails', function() {
      fs.mkdirSync(envRoot, { recursive: true });
      fs.chmodSync(envRoot, 0o755);

      var envPath = path.join(envRoot, 'zm2-app.env');
      fs.writeFileSync(envPath, 'OLD=value\n', 'utf8');
      fs.chmodSync(envPath, 0o644);

      var expected = new Error('directory chmod denied');
      var originalChmod = sandbox.fs.chmodSync;
      sandbox.fs.chmodSync = function() {
        throw expected;
      };

      var caught;
      try {
        caught = captureError(function() {
          sandbox.Systemd.writeEnvFile('zm2-app', 'NEW=value\n');
        });
      } finally {
        sandbox.fs.chmodSync = originalChmod;
      }

      (caught === expected).should.be.true();
      fileMode(envRoot).should.equal(0o755);
      fileMode(envPath).should.equal(0o644);
      fs.readFileSync(envPath, 'utf8').should.equal('OLD=value\n');
    });

    it('should preserve existing data when restricting the file fails', function() {
      fs.mkdirSync(envRoot, { recursive: true });
      fs.chmodSync(envRoot, 0o700);

      var envPath = path.join(envRoot, 'zm2-app.env');
      fs.writeFileSync(envPath, 'OLD=value\n', 'utf8');
      fs.chmodSync(envPath, 0o644);

      var expected = new Error('file chmod denied');
      var originalFchmod = sandbox.fs.fchmodSync;
      sandbox.fs.fchmodSync = function() {
        throw expected;
      };

      var caught;
      try {
        caught = captureError(function() {
          sandbox.Systemd.writeEnvFile('zm2-app', 'NEW=value\n');
        });
      } finally {
        sandbox.fs.fchmodSync = originalFchmod;
      }

      (caught === expected).should.be.true();
      fileMode(envPath).should.equal(0o644);
      fs.readFileSync(envPath, 'utf8').should.equal('OLD=value\n');
    });
  });

  describe('removeUnit lifecycle safety', function() {
    it('should stop and disable the cron timer before stopping the service', function() {
      var files = createSingleFiles('zm2-app');
      var state = installSystemctlStub(sandbox.Systemd);

      sandbox.Systemd.removeUnit('zm2-app');

      state.calls.should.eql([
        ['stop', 'zm2-app-cron.timer'],
        ['disable', 'zm2-app-cron.timer'],
        ['stop', 'zm2-app.service'],
        ['disable', 'zm2-app.service'],
        ['daemon-reload']
      ]);
      allFilesMissing(files).should.be.true();
    });

    it('should propagate stop failures and preserve all files', function() {
      var files = createSingleFiles('zm2-app');
      var expected = new Error('service stop failed');
      var state = installSystemctlStub(sandbox.Systemd, function(args) {
        if (args[0] === 'stop' && args[1] === 'zm2-app.service') return expected;
        return null;
      });

      var caught = captureError(function() {
        sandbox.Systemd.removeUnit('zm2-app');
      });

      (caught === expected).should.be.true();
      allFilesExist(files).should.be.true();
      state.calls.should.eql([
        ['stop', 'zm2-app-cron.timer'],
        ['disable', 'zm2-app-cron.timer'],
        ['stop', 'zm2-app.service']
      ]);
    });

    it('should propagate disable failures and preserve all files', function() {
      var files = createSingleFiles('zm2-app');
      var expected = new Error('service disable failed');
      var state = installSystemctlStub(sandbox.Systemd, function(args) {
        if (args[0] === 'disable' && args[1] === 'zm2-app.service') return expected;
        return null;
      });

      var caught = captureError(function() {
        sandbox.Systemd.removeUnit('zm2-app');
      });

      (caught === expected).should.be.true();
      allFilesExist(files).should.be.true();
      state.calls.should.eql([
        ['stop', 'zm2-app-cron.timer'],
        ['disable', 'zm2-app-cron.timer'],
        ['stop', 'zm2-app.service'],
        ['disable', 'zm2-app.service']
      ]);
    });

    it('should propagate timer stop failures and preserve all files', function() {
      var files = createSingleFiles('zm2-app');
      var expected = new Error('timer stop failed');
      var state = installSystemctlStub(sandbox.Systemd, function(args) {
        if (args[0] === 'stop' && args[1] === 'zm2-app-cron.timer') return expected;
        return null;
      });

      var caught = captureError(function() {
        sandbox.Systemd.removeUnit('zm2-app');
      });

      (caught === expected).should.be.true();
      allFilesExist(files).should.be.true();
      state.calls.should.eql([
        ['stop', 'zm2-app-cron.timer']
      ]);
    });

    it('should propagate timer disable failures and preserve all files', function() {
      var files = createSingleFiles('zm2-app');
      var expected = new Error('timer disable failed');
      var state = installSystemctlStub(sandbox.Systemd, function(args) {
        if (args[0] === 'disable' && args[1] === 'zm2-app-cron.timer') return expected;
        return null;
      });

      var caught = captureError(function() {
        sandbox.Systemd.removeUnit('zm2-app');
      });

      (caught === expected).should.be.true();
      allFilesExist(files).should.be.true();
      state.calls.should.eql([
        ['stop', 'zm2-app-cron.timer'],
        ['disable', 'zm2-app-cron.timer']
      ]);
    });

    it('should skip timer commands when no cron timer exists', function() {
      var files = createSingleFiles('zm2-app', false);
      var state = installSystemctlStub(sandbox.Systemd);

      sandbox.Systemd.removeUnit('zm2-app');

      state.calls.should.eql([
        ['stop', 'zm2-app.service'],
        ['disable', 'zm2-app.service'],
        ['daemon-reload']
      ]);
      allFilesMissing(files).should.be.true();
    });
  });

  describe('removeTemplateUnit lifecycle safety', function() {
    it('should stop and disable the cron timer before stopping instances', function() {
      var files = createTemplateFiles('zm2-app');
      var state = installSystemctlStub(sandbox.Systemd);

      sandbox.Systemd.removeTemplateUnit('zm2-app', 2);

      state.calls.should.eql([
        ['stop', 'zm2-app-cron.timer'],
        ['disable', 'zm2-app-cron.timer'],
        ['stop', 'zm2-app@0.service'],
        ['disable', 'zm2-app@0.service'],
        ['stop', 'zm2-app@1.service'],
        ['disable', 'zm2-app@1.service'],
        ['daemon-reload']
      ]);
      allFilesMissing(files).should.be.true();
    });

    it('should propagate instance stop failures and preserve all files', function() {
      var files = createTemplateFiles('zm2-app');
      var expected = new Error('instance stop failed');
      var state = installSystemctlStub(sandbox.Systemd, function(args) {
        if (args[0] === 'stop' && args[1] === 'zm2-app@1.service') return expected;
        return null;
      });

      var caught = captureError(function() {
        sandbox.Systemd.removeTemplateUnit('zm2-app', 2);
      });

      (caught === expected).should.be.true();
      allFilesExist(files).should.be.true();
      state.calls.should.eql([
        ['stop', 'zm2-app-cron.timer'],
        ['disable', 'zm2-app-cron.timer'],
        ['stop', 'zm2-app@0.service'],
        ['disable', 'zm2-app@0.service'],
        ['stop', 'zm2-app@1.service']
      ]);
    });

    it('should propagate instance disable failures and preserve all files', function() {
      var files = createTemplateFiles('zm2-app');
      var expected = new Error('instance disable failed');
      var state = installSystemctlStub(sandbox.Systemd, function(args) {
        if (args[0] === 'disable' && args[1] === 'zm2-app@1.service') return expected;
        return null;
      });

      var caught = captureError(function() {
        sandbox.Systemd.removeTemplateUnit('zm2-app', 2);
      });

      (caught === expected).should.be.true();
      allFilesExist(files).should.be.true();
      state.calls.should.eql([
        ['stop', 'zm2-app-cron.timer'],
        ['disable', 'zm2-app-cron.timer'],
        ['stop', 'zm2-app@0.service'],
        ['disable', 'zm2-app@0.service'],
        ['stop', 'zm2-app@1.service'],
        ['disable', 'zm2-app@1.service']
      ]);
    });
  });
});