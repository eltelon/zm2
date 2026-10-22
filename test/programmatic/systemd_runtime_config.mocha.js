var should = require('should');
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var UnitGenerator = require('../../lib/Systemd/UnitGenerator');
var RuntimeConfig = require('../../lib/Systemd/RuntimeConfig');
var Systemd = require('../../lib/Systemd');

var DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function writeFile(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  if (mode !== undefined) fs.chmodSync(file, mode);
}

function execProperty(executable) {
  return '{ path=' + executable +
    ' ; argv[]=' + executable + ' /srv/app/main.js' +
    ' ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a]' +
    ' ; pid=0 ; code=(null) ; status=0/0 }';
}

function makeProps(opts) {
  var instanceVar = opts.instanceVar || 'NODE_APP_INSTANCE';
  return {
    ExecStart: execProperty(opts.executable),
    FragmentPath: opts.unitPath,
    DropInPaths: '',
    Environment: opts.instance === undefined ? '' : instanceVar + '=' + opts.instance,
    EnvironmentFiles: opts.envPath + ' (ignore_errors=yes)',
    User: 'deploy',
    Group: 'deploy'
  };
}

function fakeSystemd(properties) {
  var calls = [];
  return {
    calls: calls,
    getRuntimeProperties: function(name) {
      calls.push(name);
      if (!Object.prototype.hasOwnProperty.call(properties, name)) {
        throw new Error('Unit ' + name + '.service not found');
      }
      return Object.assign({}, properties[name]);
    }
  };
}

function proxyFs(options) {
  options = options || {};
  var calls = [];
  var renameCount = 0;

  var proxy = new Proxy(fs, {
    get: function(target, property) {
      if (property === 'writeFileSync' && options.writeFileSync) {
        return function(file, data, writeOptions) {
          calls.push({ method: 'writeFileSync', path: file });
          return options.writeFileSync(fs, file, data, writeOptions);
        };
      }

      if (property === 'chownSync') {
        return function(file, uid, gid) {
          calls.push({ method: 'chownSync', path: file, uid: uid, gid: gid });
          if (options.failChown) {
            var chownError = new Error('chown denied');
            chownError.code = 'EPERM';
            throw chownError;
          }
          return fs.chownSync(file, uid, gid);
        };
      }

      if (property === 'renameSync') {
        return function(source, destination) {
          renameCount++;
          calls.push({
            method: 'renameSync',
            count: renameCount,
            source: source,
            destination: destination
          });
          if (options.failRenameAt === renameCount) {
            var renameError = new Error('simulated rename failure');
            renameError.code = 'EIO';
            throw renameError;
          }
          return fs.renameSync(source, destination);
        };
      }

      var value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  return { fs: proxy, calls: calls };
}

describe('RuntimeConfig', function() {
  var tmpDir;
  var unitDir;
  var envDir;

  beforeEach(function() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm2-runtime-config-'));
    unitDir = path.join(tmpDir, 'units');
    envDir = path.join(tmpDir, 'env');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.mkdirSync(envDir, { recursive: true });
  });

  afterEach(function() {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      /* ignore cleanup errors */
    }
  });

  function buildUnit(opts) {
    var instances = opts.instances || 1;
    var conf = {
      name: opts.name,
      pm_exec_path: opts.script || '/srv/app/main.js',
      exec_interpreter: opts.executable || '/usr/bin/node',
      pm_cwd: '/srv/app',
      user: 'deploy',
      restart_delay: 5000,
      max_memory_restart: '256M',
      args: opts.args || ['--message', '"hello world"']
    };
    if (opts.instanceVar) conf.instance_var = opts.instanceVar;

    var unit = UnitGenerator.generate(conf, { isTemplate: instances > 1 });
    unit = unit.replace('[Service]\n', '[Service]\n# preserve this comment\n');
    unit = unit.replace('[Install]\n', '# preserve install comment\n[Install]\n');
    unit = unit.replace('After=network.target\n', 'After=network.target\nWants=zm2-' + opts.name + '-cron.timer\n');
    unit = unit.replace(
      'EnvironmentFile=-/etc/zm2/env/zm2-' + opts.name + '.env',
      'EnvironmentFile=-' + opts.envPath
    );
    return unit;
  }

  function regularFixture(opts) {
    opts = opts || {};
    var name = opts.name || 'app';
    var serviceName = 'zm2-' + name;
    var unitPath = path.join(unitDir, serviceName + '.service');
    var envPath = path.join(envDir, serviceName + '.env');
    var executable = opts.executable || '/usr/bin/node';
    var unitContent = opts.unitContent;

    if (unitContent === undefined) {
      unitContent = buildUnit({
        name: name,
        envPath: envPath,
        executable: executable,
        args: opts.args
      });
    } else {
      unitContent = unitContent.replace(
        /\/etc\/zm2\/env\/zm2-[A-Za-z0-9_-]+\.env/g,
        envPath
      );
    }

    writeFile(unitPath, unitContent, opts.unitMode);
    if (opts.envContent !== undefined) {
      writeFile(envPath, opts.envContent, opts.envMode);
    }

    var properties = makeProps({
      unitPath: unitPath,
      envPath: envPath,
      executable: executable
    });
    if (opts.props) Object.assign(properties, opts.props);

    var systemd = fakeSystemd({});
    systemd.getRuntimeProperties = (function(original) {
      return function(unitName) {
        if (unitName !== serviceName) return original(unitName);
        systemd.calls.push(unitName);
        return Object.assign({}, properties);
      };
    })(systemd.getRuntimeProperties);

    var config = new RuntimeConfig({
      fs: opts.fs || fs,
      systemd: systemd,
      unitDir: unitDir,
      envDir: envDir
    });

    return {
      entry: { serviceName: serviceName, name: name, instances: 1, script: '/srv/app/main.js' },
      config: config,
      systemd: systemd,
      unitPath: unitPath,
      envPath: envPath,
      unitContent: unitContent,
      executable: executable,
      properties: properties
    };
  }

  function templateFixture(opts) {
    opts = opts || {};
    var name = opts.name || 'worker';
    var instances = opts.instances || 2;
    var serviceName = 'zm2-' + name;
    var templatePath = path.join(unitDir, serviceName + '@.service');
    var envPath = path.join(envDir, serviceName + '.env');
    var executable = opts.executable || '/usr/bin/node';
    var instanceVar = opts.instanceVar || 'NODE_APP_INSTANCE';
    var unitContent = opts.unitContent;

    if (unitContent === undefined) {
      unitContent = buildUnit({
        name: name,
        envPath: envPath,
        executable: executable,
        instances: instances,
        instanceVar: opts.instanceVar,
        args: opts.args
      });
    }

    writeFile(templatePath, unitContent, opts.unitMode);
    if (opts.envContent !== undefined) {
      writeFile(envPath, opts.envContent, opts.envMode);
    }

    var properties = {};
    for (var i = 0; i < instances; i++) {
      var instanceName = serviceName + '@' + i;
      var props = makeProps({
        unitPath: templatePath,
        envPath: envPath,
        executable: executable,
        instanceVar: instanceVar,
        instance: i
      });
      if (opts.instanceProps && opts.instanceProps[i]) {
        Object.assign(props, opts.instanceProps[i]);
      }
      properties[instanceName] = props;
    }
    if (opts.extraProps) Object.assign(properties, opts.extraProps);

    var systemd = fakeSystemd(properties);
    var config = new RuntimeConfig({
      fs: opts.fs || fs,
      systemd: systemd,
      unitDir: unitDir,
      envDir: envDir
    });

    return {
      entry: { serviceName: serviceName, name: name, instances: instances, script: '/srv/app/main.js' },
      config: config,
      systemd: systemd,
      unitPath: templatePath,
      envPath: envPath,
      unitContent: unitContent,
      executable: executable,
      instanceVar: instanceVar,
      properties: properties
    };
  }

  function runtime(overrides) {
    return Object.assign({
      version: '20.0.0',
      executable: '/opt/zm2-node/bin/node',
      binDir: '/opt/zm2-node/bin'
    }, overrides || {});
  }

  describe('inspect', function() {
    it('captures regular unit and env snapshots with metadata and prior executable', function() {
      var fixture = regularFixture({
        envContent: 'FOO=bar\n',
        unitMode: 0o640,
        envMode: 0o600
      });

      var snapshot = fixture.config.inspect(fixture.entry);

      snapshot.serviceName.should.equal('zm2-app');
      snapshot.isTemplate.should.be.false();
      snapshot.instances.should.equal(1);
      snapshot.unit.path.should.equal(fixture.unitPath);
      snapshot.unit.exists.should.be.true();
      snapshot.unit.content.should.equal(fixture.unitContent);
      snapshot.unit.mode.should.equal(0o640);
      snapshot.unit.uid.should.be.a.Number();
      snapshot.unit.gid.should.be.a.Number();
      snapshot.env.path.should.equal(fixture.envPath);
      snapshot.env.exists.should.be.true();
      snapshot.env.content.should.equal('FOO=bar\n');
      snapshot.env.mode.should.equal(0o600);
      snapshot.env.uid.should.be.a.Number();
      snapshot.env.gid.should.be.a.Number();
      snapshot.executable.should.equal('/usr/bin/node');
      snapshot.previousExecutable.should.equal('/usr/bin/node');
      should(snapshot.instanceVar).be.null();
      snapshot.metadata.should.have.property('serviceName', 'zm2-app');
      snapshot.metadata.should.have.property('instances', 1);
      fixture.systemd.calls.should.deepEqual(['zm2-app']);
    });

    it('returns a frozen snapshot with cloned metadata', function() {
      var fixture = regularFixture({ envContent: 'FOO=bar\n' });
      var snapshot = fixture.config.inspect(fixture.entry);

      Object.isFrozen(snapshot).should.be.true();
      Object.isFrozen(snapshot.unit).should.be.true();
      Object.isFrozen(snapshot.env).should.be.true();
      Object.isFrozen(snapshot.metadata).should.be.true();
      snapshot.metadata.should.not.equal(fixture.entry);
    });

    it('captures each template instance and never queries the bare base unit', function() {
      var fixture = templateFixture({ envContent: 'FOO=bar\n' });
      var snapshot = fixture.config.inspect(fixture.entry);

      snapshot.isTemplate.should.be.true();
      snapshot.instances.should.equal(2);
      snapshot.unit.path.should.equal(fixture.unitPath);
      snapshot.executable.should.equal('/usr/bin/node');
      snapshot.previousExecutable.should.equal('/usr/bin/node');
      snapshot.instanceVar.should.equal('NODE_APP_INSTANCE');
      fixture.systemd.calls.should.deepEqual(['zm2-worker@0', 'zm2-worker@1']);
      fixture.systemd.calls.should.not.containEql('zm2-worker');
    });

    it('accepts a generated custom template instance variable', function() {
      var fixture = templateFixture({
        instanceVar: 'WORKER_ID',
        envContent: 'FOO=bar\nPATH=/usr/bin:/bin\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);

      snapshot.instanceVar.should.equal('WORKER_ID');
      var plan = fixture.config.plan(snapshot, runtime());
      plan.unitContent.should.containEql('Environment=WORKER_ID=%i');
      plan.unitContent.should.not.containEql('NODE_APP_INSTANCE');
      plan.envContent.should.equal('FOO=bar\nPATH=/opt/zm2-node/bin:/usr/bin:/bin\n');
    });

    it('rejects effective template environment that overrides the declared variable', function() {
      var instanceProps = {};
      instanceProps[1] = { Environment: 'WORKER_ID=0' };
      var fixture = templateFixture({
        instanceVar: 'WORKER_ID',
        envContent: 'FOO=bar\n',
        instanceProps: instanceProps
      });

      assert.throws(function() {
        fixture.config.inspect(fixture.entry);
      }, /Environment=|WORKER_ID/i);
    });

    it('rejects invalid template instance variable names', function() {
      var envPath = path.join(envDir, 'zm2-worker.env');
      var fixture = templateFixture({
        envContent: 'FOO=bar\n',
        unitContent: '[Service]\nExecStart=/usr/bin/node /srv/app/main.js\n' +
          'Environment=WORKER-ID=%i\nEnvironmentFile=-' + envPath + '\n'
      });

      assert.throws(function() {
        fixture.config.inspect(fixture.entry);
      }, /template Environment|invalid/i);
    });

    it('rejects a missing unit', function() {
      var fixture = regularFixture({ envContent: 'FOO=bar\n' });
      fs.unlinkSync(fixture.unitPath);

      assert.throws(function() {
        fixture.config.inspect(fixture.entry);
      }, /unit|missing|ENOENT/i);
    });

    it('rejects unsafe service names and path traversal', function() {
      var config = new RuntimeConfig({
        systemd: fakeSystemd({}),
        unitDir: unitDir,
        envDir: envDir
      });
      var names = ['../evil', 'zm2-a/b', 'zm2-a..b', 'evil', 'zm2-', 'zm2-a b', 'zm2-a\n'];

      names.forEach(function(serviceName) {
        assert.throws(function() {
          config.inspect({ serviceName: serviceName, instances: 1 });
        }, /unsafe|invalid/i, 'expected rejection for ' + JSON.stringify(serviceName));
      });
    });

    it('rejects symlinked unit and environment files', function() {
      var fixture = regularFixture({ envContent: 'FOO=bar\n' });
      var outsideUnit = path.join(tmpDir, 'outside.service');
      var outsideEnv = path.join(tmpDir, 'outside.env');
      fs.writeFileSync(outsideUnit, fixture.unitContent);
      fs.writeFileSync(outsideEnv, 'FOO=bar\n');

      fs.unlinkSync(fixture.unitPath);
      fs.symlinkSync(outsideUnit, fixture.unitPath);
      assert.throws(function() {
        fixture.config.inspect(fixture.entry);
      }, /symlink/i);

      fs.unlinkSync(fixture.unitPath);
      fs.writeFileSync(fixture.unitPath, fixture.unitContent);
      fs.unlinkSync(fixture.envPath);
      fs.symlinkSync(outsideEnv, fixture.envPath);
      assert.throws(function() {
        fixture.config.inspect(fixture.entry);
      }, /symlink/i);
    });

    it('rejects non-regular unit and environment paths', function() {
      var fixture = regularFixture({ envContent: 'FOO=bar\n' });
      fs.unlinkSync(fixture.unitPath);
      fs.mkdirSync(fixture.unitPath);

      assert.throws(function() {
        fixture.config.inspect(fixture.entry);
      }, /non-regular|regular file/i);
    });

    it('rejects a FragmentPath outside the managed unit directory', function() {
      var fixture = regularFixture({
        envContent: 'FOO=bar\n',
        props: { FragmentPath: '/tmp/elsewhere.service' }
      });

      assert.throws(function() {
        fixture.config.inspect(fixture.entry);
      }, /FragmentPath/i);
    });

    it('rejects drop-in overrides', function() {
      var fixture = regularFixture({
        envContent: 'FOO=bar\n',
        props: { DropInPaths: '/etc/systemd/system/zm2-app.service.d/override.conf' }
      });

      assert.throws(function() {
        fixture.config.inspect(fixture.entry);
      }, /drop-in/i);
    });

    it('rejects multiple effective ExecStart commands', function() {
      var fixture = regularFixture({
        envContent: 'FOO=bar\n',
        props: {
          ExecStart: execProperty('/usr/bin/node') + ' ' + execProperty('/usr/bin/node')
        }
      });

      assert.throws(function() {
        fixture.config.inspect(fixture.entry);
      }, /multiple ExecStart/i);
    });

    it('rejects wrappers and non-Node ExecStart executables', function() {
      var fixture = regularFixture({
        executable: '/bin/sh',
        envContent: 'FOO=bar\n'
      });

      assert.throws(function() {
        fixture.config.inspect(fixture.entry);
      }, /Node executable/i);
    });

    it('rejects effective ExecStart that does not match the source unit', function() {
      var fixture = regularFixture({
        envContent: 'FOO=bar\n',
        props: { ExecStart: execProperty('/usr/local/bin/node') }
      });

      assert.throws(function() {
        fixture.config.inspect(fixture.entry);
      }, /does not match/i);
    });

    it('rejects unknown or multiple environment files', function() {
      var fixture = regularFixture({
        envContent: 'FOO=bar\n',
        props: {
          EnvironmentFiles: '/etc/zm2/env/other.env (ignore_errors=yes)'
        }
      });

      assert.throws(function() {
        fixture.config.inspect(fixture.entry);
      }, /EnvironmentFiles/i);
    });

    it('rejects explicit Environment overrides', function() {
      var fixture = regularFixture({
        envContent: 'FOO=bar\n',
        props: { Environment: 'PATH=/evil/bin' }
      });

      assert.throws(function() {
        fixture.config.inspect(fixture.entry);
      }, /Environment=/i);
    });

    it('rejects advanced environment directives that change precedence', function() {
      ['PassEnvironment=PATH', 'UnsetEnvironment=PATH'].forEach(function(directive) {
        var envPath = path.join(envDir, 'zm2-app.env');
        var fixture = regularFixture({
          envContent: 'FOO=bar\n',
          unitContent: '[Service]\nExecStart=/usr/bin/node /srv/app/main.js\n' +
            directive + '\nEnvironmentFile=-' + envPath + '\n'
        });

        assert.throws(function() {
          fixture.config.inspect(fixture.entry);
        }, /PassEnvironment|UnsetEnvironment|unsupported/i);
      });
    });

    it('rejects per-instance template overrides', function() {
      var overrides = [
        { FragmentPath: '/etc/systemd/system/other@.service' },
        { EnvironmentFiles: '/etc/zm2/env/other.env (ignore_errors=yes)' },
        { ExecStart: execProperty('/opt/other/bin/node') }
      ];

      overrides.forEach(function(override) {
        var instanceProps = {};
        instanceProps[1] = override;
        var fixture = templateFixture({
          envContent: 'FOO=bar\n',
          instanceProps: instanceProps
        });

        assert.throws(function() {
          fixture.config.inspect(fixture.entry);
        }, /FragmentPath|EnvironmentFiles|does not match/i);
      });
    });

    it('rejects a template whose bare base unit exists instead of the template', function() {
      var serviceName = 'zm2-worker';
      var basePath = path.join(unitDir, serviceName + '.service');
      var baseContent = buildUnit({
        name: 'worker',
        envPath: path.join(envDir, serviceName + '.env'),
        executable: '/usr/bin/node'
      });
      writeFile(basePath, baseContent);

      var systemd = fakeSystemd({
        'zm2-worker@0': makeProps({
          unitPath: basePath,
          envPath: path.join(envDir, serviceName + '.env'),
          executable: '/usr/bin/node',
          instance: 0
        })
      });
      var config = new RuntimeConfig({ systemd: systemd, unitDir: unitDir, envDir: envDir });

      assert.throws(function() {
        config.inspect({ serviceName: serviceName, instances: 2 });
      }, /template|missing|unit/i);
      systemd.calls.length.should.equal(0);
    });

    it('rejects unsupported ExecStart prefixes and line continuations', function() {
      var prefixFixture = regularFixture({
        envContent: 'FOO=bar\n',
        unitContent: '[Service]\nExecStart=-/usr/bin/node /srv/app/main.js\nEnvironmentFile=-/etc/zm2/env/zm2-app.env\n'
      });
      assert.throws(function() {
        prefixFixture.config.inspect(prefixFixture.entry);
      }, /prefix/i);

      var continuedFixture = regularFixture({
        envContent: 'FOO=bar\n',
        unitContent: '[Service]\nExecStart=/usr/bin/node /srv/app/main.js \\\n  --flag\nEnvironmentFile=-/etc/zm2/env/zm2-app.env\n'
      });
      assert.throws(function() {
        continuedFixture.config.inspect(continuedFixture.entry);
      }, /continuation/i);
    });

    it('rejects relative existing Node executables', function() {
      var fixture = regularFixture({
        envContent: 'FOO=bar\n',
        unitContent: '[Service]\nExecStart=node /srv/app/main.js\nEnvironmentFile=-/etc/zm2/env/zm2-app.env\n',
        props: { ExecStart: execProperty('node') }
      });

      assert.throws(function() {
        fixture.config.inspect(fixture.entry);
      }, /absolute/i);
    });
  });

  describe('plan', function() {
    it('replaces only the initial executable and preserves every other byte', function() {
      var fixture = regularFixture({
        envContent: 'FOO=bar\nPATH=/usr/bin:/bin\nBAZ="qux quux"\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      plan.changed.should.be.true();
      plan.unitContent.should.containEql('ExecStart=/opt/zm2-node/bin/node /srv/app/main.js --message "hello world"');
      plan.unitContent.should.not.containEql('/usr/bin/node');
      plan.unitContent.should.containEql('# preserve this comment');
      plan.unitContent.should.containEql('# preserve install comment');
      plan.unitContent.should.containEql('User=deploy');
      plan.unitContent.should.containEql('WorkingDirectory=/srv/app');
      plan.unitContent.should.containEql('MemoryMax=256M');
      plan.unitContent.should.containEql('Wants=zm2-app-cron.timer');
      plan.unitContent.should.containEql('EnvironmentFile=-' + fixture.envPath);

      var originalLines = fixture.unitContent.split('\n').filter(function(line) {
        return line.indexOf('ExecStart=') !== 0;
      });
      var plannedLines = plan.unitContent.split('\n').filter(function(line) {
        return line.indexOf('ExecStart=') !== 0;
      });
      plannedLines.should.deepEqual(originalLines);

      plan.envContent.should.equal('FOO=bar\nPATH=/opt/zm2-node/bin:/usr/bin:/bin\nBAZ="qux quux"\n');
    });

    it('escapes whitespace, percent, quotes and backslashes in the runtime executable', function() {
      var fixture = regularFixture({
        envContent: 'FOO=bar\nPATH=/usr/bin:/bin\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var executable = '/opt/node 20%/bin\\special"dir/node';
      var binDir = '/opt/node 20%/bin\\special"dir';
      var plan = fixture.config.plan(snapshot, runtime({
        executable: executable,
        binDir: binDir
      }));

      var expectedToken = '"/opt/node 20%%/bin\\\\special\\"dir/node"';
      plan.unitContent.should.containEql(
        'ExecStart=' + expectedToken + ' /srv/app/main.js --message "hello world"'
      );

      var expectedEnvValue = '"' +
        binDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"') +
        ':/usr/bin:/bin"';
      plan.envContent.should.equal('FOO=bar\nPATH=' + expectedEnvValue + '\n');
    });

    it('round-trips a runtime executable with literal percent and spaces', function() {
      var executable = '/opt/node 20%/bin/node';
      var binDir = '/opt/node 20%/bin';
      var fixture = regularFixture({
        envContent: 'FOO=bar\nPATH=/usr/bin:/bin\n'
      });
      var firstSnapshot = fixture.config.inspect(fixture.entry);
      var firstPlan = fixture.config.plan(firstSnapshot, runtime({
        executable: executable,
        binDir: binDir
      }));

      firstPlan.unitContent.should.containEql(
        'ExecStart="/opt/node 20%%/bin/node" /srv/app/main.js'
      );

      fixture.config.apply(firstSnapshot, firstPlan);
      fixture.properties.ExecStart = execProperty(executable);

      var secondSnapshot = fixture.config.inspect(fixture.entry);
      secondSnapshot.executable.should.equal(executable);

      var secondPlan = fixture.config.plan(secondSnapshot, runtime({
        executable: executable,
        binDir: binDir
      }));
      secondPlan.changed.should.be.false();
      secondPlan.unitContent.should.equal(firstPlan.unitContent);
      secondPlan.envContent.should.equal(firstPlan.envContent);
    });

    it('rejects unsupported single-percent specifiers in the source executable', function() {
      var envPath = path.join(envDir, 'zm2-app.env');
      var fixture = regularFixture({
        envContent: 'FOO=bar\n',
        unitContent: '[Service]\nExecStart=/usr/bin/%i/node /srv/app/main.js\n' +
          'EnvironmentFile=-' + envPath + '\n'
      });

      assert.throws(function() {
        fixture.config.inspect(fixture.entry);
      }, /specifier|percent|unsupported/i);
    });

    it('does not decode percent escapes in ExecStart arguments', function() {
      var envPath = path.join(envDir, 'zm2-app.env');
      var fixture = regularFixture({
        envContent: 'FOO=bar\n',
        unitContent: '[Service]\nExecStart=/usr/bin/node /srv/app/%i.js --literal=%%\n' +
          'EnvironmentFile=-' + envPath + '\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      plan.unitContent.should.containEql('/srv/app/%i.js --literal=%%');
    });

    it('rejects unsupported or relative runtime executables before writing', function() {
      var fixture = regularFixture({ envContent: 'FOO=bar\n' });
      var snapshot = fixture.config.inspect(fixture.entry);

      assert.throws(function() {
        fixture.config.plan(snapshot, runtime({
          executable: '/opt/$node/bin/node',
          binDir: '/opt/$node/bin'
        }));
      }, /\$|unsupported/i);

      assert.throws(function() {
        fixture.config.plan(snapshot, runtime({
          executable: 'relative/bin/node',
          binDir: 'relative/bin'
        }));
      }, /absolute/i);
    });

    it('is pure and does not modify the snapshot or files', function() {
      var fixture = regularFixture({ envContent: 'FOO=bar\nPATH=/usr/bin:/bin\n' });
      var snapshot = fixture.config.inspect(fixture.entry);
      var beforeUnit = fs.readFileSync(fixture.unitPath, 'utf8');
      var beforeEnv = fs.readFileSync(fixture.envPath, 'utf8');
      var beforeSnapshot = JSON.stringify(snapshot);
      var beforeCalls = fixture.systemd.calls.length;

      fixture.config.plan(snapshot, runtime());

      fs.readFileSync(fixture.unitPath, 'utf8').should.equal(beforeUnit);
      fs.readFileSync(fixture.envPath, 'utf8').should.equal(beforeEnv);
      JSON.stringify(snapshot).should.equal(beforeSnapshot);
      fixture.systemd.calls.length.should.equal(beforeCalls);
    });

    it('returns changed false when the executable and PATH are already configured', function() {
      var fixture = regularFixture({
        executable: '/opt/zm2-node/bin/node',
        envContent: 'PATH=/opt/zm2-node/bin:/usr/bin:/bin\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      plan.changed.should.be.false();
      plan.unitContent.should.equal(fixture.unitContent);
      plan.envContent.should.equal('PATH=/opt/zm2-node/bin:/usr/bin:/bin\n');
    });

    it('adds PATH to an existing env file when absent', function() {
      var fixture = regularFixture({
        envContent: 'FOO=bar\nBAZ="qux quux"\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      plan.envContent.should.equal(
        'FOO=bar\nBAZ="qux quux"\nPATH=/opt/zm2-node/bin:' + DEFAULT_PATH + '\n'
      );
    });

    it('creates env content when the env file is absent', function() {
      var fixture = regularFixture({});
      var snapshot = fixture.config.inspect(fixture.entry);

      snapshot.env.exists.should.be.false();
      should(snapshot.env.content).be.null();

      var plan = fixture.config.plan(snapshot, runtime());
      plan.envContent.should.equal('PATH=/opt/zm2-node/bin:' + DEFAULT_PATH + '\n');
    });

    it('prepends binDir to an existing PATH', function() {
      var fixture = regularFixture({
        envContent: 'FOO=bar\nPATH=/usr/bin:/bin\nBAZ=qux\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      plan.envContent.should.equal(
        'FOO=bar\nPATH=/opt/zm2-node/bin:/usr/bin:/bin\nBAZ=qux\n'
      );
    });

    it('uses the fixed base when PATH is explicitly empty', function() {
      var fixture = regularFixture({
        envContent: 'PATH=\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      plan.envContent.should.equal(
        'PATH=/opt/zm2-node/bin:' + DEFAULT_PATH + '\n'
      );
    });

    it('preserves bytes when binDir is already first without duplicates', function() {
      var fixture = regularFixture({
        executable: '/opt/zm2-node/bin/node',
        envContent: 'PATH=/opt/zm2-node/bin/:/usr/bin:/bin\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      plan.changed.should.be.false();
      plan.envContent.should.equal('PATH=/opt/zm2-node/bin/:/usr/bin:/bin\n');
    });

    it('moves a later binDir to the front preserving other entries', function() {
      var fixture = regularFixture({
        envContent: 'PATH=/old/bin:/usr/bin:/new/bin\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime({
        executable: '/new/bin/node',
        binDir: '/new/bin'
      }));

      plan.envContent.should.equal('PATH=/new/bin:/old/bin:/usr/bin\n');
    });

    it('removes all equivalent trailing-slash duplicates of the target', function() {
      var fixture = regularFixture({
        envContent: 'PATH=/old/bin:/new/bin:/usr/bin:/new/bin/:/tail\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime({
        executable: '/new/bin/node',
        binDir: '/new/bin'
      }));

      plan.envContent.should.equal('PATH=/new/bin:/old/bin:/usr/bin:/tail\n');
    });

    it('canonicalizes a first target when equivalent duplicates exist', function() {
      var fixture = regularFixture({
        envContent: 'PATH=/new/bin/:/old:/new/bin\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime({
        executable: '/new/bin/node',
        binDir: '/new/bin'
      }));

      plan.envContent.should.equal('PATH=/new/bin:/old\n');
    });

    it('preserves duplicate PATH assignments and updates the effective last one', function() {
      var fixture = regularFixture({
        envContent: 'PATH=/first/bin\nOTHER=1\nPATH=/usr/bin:/bin\nTAIL=yes\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      plan.envContent.should.equal(
        'PATH=/first/bin\nOTHER=1\nPATH=/opt/zm2-node/bin:/usr/bin:/bin\nTAIL=yes\n'
      );
    });

    it('preserves quoted PATH style and literal $PATH text', function() {
      var fixture = regularFixture({
        envContent: 'PATH="/usr/bin:$PATH"\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      plan.envContent.should.equal('PATH="/opt/zm2-node/bin:/usr/bin:$PATH"\n');
    });

    it('preserves literal backslash escapes in double-quoted PATH values', function() {
      var fixture = regularFixture({
        envContent: 'PATH="C:\\tools\\q\\nbin:/usr/bin"\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      plan.envContent.should.equal(
        'PATH="/opt/zm2-node/bin:C:\\tools\\q\\nbin:/usr/bin"\n'
      );
    });

    it('rejects unsupported backslash escapes in unquoted PATH values', function() {
      var fixture = regularFixture({
        envContent: 'PATH=C:\\tools\\bin:/usr/bin\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);

      assert.throws(function() {
        fixture.config.plan(snapshot, runtime());
      }, /backslash|unsupported/i);
    });

    it('rejects unsupported environment file shapes', function() {
      var continuedFixture = regularFixture({
        envContent: 'FOO=bar\\\nBAZ=qux\n'
      });
      var continuedSnapshot = continuedFixture.config.inspect(continuedFixture.entry);
      assert.throws(function() {
        continuedFixture.config.plan(continuedSnapshot, runtime());
      }, /continuation|unsupported/i);

      var invalidFixture = regularFixture({
        envContent: 'THIS_IS_NOT_AN_ASSIGNMENT\n'
      });
      var invalidSnapshot = invalidFixture.config.inspect(invalidFixture.entry);
      assert.throws(function() {
        invalidFixture.config.plan(invalidSnapshot, runtime());
      }, /environment|unsupported/i);
    });

    it('updates a template without losing its instance environment directive', function() {
      var fixture = templateFixture({
        envContent: 'FOO=bar\nPATH=/usr/bin:/bin\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      plan.unitContent.should.containEql('ExecStart=/opt/zm2-node/bin/node /srv/app/main.js --message "hello world"');
      plan.unitContent.should.containEql('Environment=NODE_APP_INSTANCE=%i');
      plan.unitContent.should.containEql('EnvironmentFile=-' + fixture.envPath);
      plan.envContent.should.equal('FOO=bar\nPATH=/opt/zm2-node/bin:/usr/bin:/bin\n');
    });
  });

  describe('apply', function() {
    it('writes unit and env while preserving mode and owner', function() {
      var fixture = regularFixture({
        envContent: 'FOO=bar\nPATH=/usr/bin:/bin\n',
        unitMode: 0o640,
        envMode: 0o600
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      fixture.config.apply(snapshot, plan);

      fs.readFileSync(fixture.unitPath, 'utf8').should.equal(plan.unitContent);
      fs.readFileSync(fixture.envPath, 'utf8').should.equal(plan.envContent);

      var unitStat = fs.statSync(fixture.unitPath);
      var envStat = fs.statSync(fixture.envPath);
      (unitStat.mode & 0o777).should.equal(0o640);
      (envStat.mode & 0o777).should.equal(0o600);
      unitStat.uid.should.equal(snapshot.unit.uid);
      unitStat.gid.should.equal(snapshot.unit.gid);
      envStat.uid.should.equal(snapshot.env.uid);
      envStat.gid.should.equal(snapshot.env.gid);
    });

    it('uses the injected fs to preserve ownership', function() {
      var recording = proxyFs();
      var fixture = regularFixture({
        fs: recording.fs,
        envContent: 'FOO=bar\nPATH=/usr/bin:/bin\n',
        unitMode: 0o640,
        envMode: 0o600
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      fixture.config.apply(snapshot, plan);

      var chowns = recording.calls.filter(function(call) {
        return call.method === 'chownSync';
      });
      chowns.length.should.equal(2);
      chowns.forEach(function(call) {
        call.uid.should.equal(snapshot.unit.uid);
        call.gid.should.equal(snapshot.unit.gid);
      });
    });

    it('does not write when the plan is unchanged', function() {
      var recording = proxyFs();
      var fixture = regularFixture({
        fs: recording.fs,
        executable: '/opt/zm2-node/bin/node',
        envContent: 'PATH=/opt/zm2-node/bin:/usr/bin:/bin\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      plan.changed.should.be.false();
      fixture.config.apply(snapshot, plan);

      recording.calls.length.should.equal(0);
    });

    it('throws on the second write and leaves the first write for restore', function() {
      var recording = proxyFs({ failRenameAt: 2 });
      var fixture = regularFixture({
        fs: recording.fs,
        unitMode: 0o640
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      assert.throws(function() {
        fixture.config.apply(snapshot, plan);
      }, /simulated rename failure|Failed to write/i);

      fs.readFileSync(fixture.unitPath, 'utf8').should.equal(plan.unitContent);
      fs.existsSync(fixture.envPath).should.be.false();

      var leftovers = fs.readdirSync(unitDir).concat(fs.readdirSync(envDir)).filter(function(file) {
        return file.indexOf('.zm2-') !== -1;
      });
      leftovers.length.should.equal(0);
    });

    it('does not delete a preexisting temp file when exclusive create fails', function() {
      var createdTemp;
      var recording = proxyFs({
        writeFileSync: function(realFs, file, content, options) {
          if (options && options.flag === 'wx' && !createdTemp) {
            createdTemp = file;
            realFs.writeFileSync(file, 'preexisting', { encoding: 'utf8', flag: 'wx' });
            var existsError = new Error('EEXIST: file already exists');
            existsError.code = 'EEXIST';
            throw existsError;
          }
          return realFs.writeFileSync(file, content, options);
        }
      });
      var fixture = regularFixture({
        fs: recording.fs,
        envContent: 'FOO=bar\nPATH=/usr/bin:/bin\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      assert.throws(function() {
        fixture.config.apply(snapshot, plan);
      }, /EEXIST|Failed to write/i);

      should(createdTemp).be.a.String();
      fs.existsSync(createdTemp).should.be.true();
      fs.readFileSync(createdTemp, 'utf8').should.equal('preexisting');
      fs.readFileSync(fixture.unitPath, 'utf8').should.equal(fixture.unitContent);
    });

    it('fails without touching the target when ownership cannot be preserved', function() {
      var recording = proxyFs({ failChown: true });
      var fixture = regularFixture({
        fs: recording.fs,
        envContent: 'FOO=bar\nPATH=/usr/bin:/bin\n',
        unitMode: 0o640
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      assert.throws(function() {
        fixture.config.apply(snapshot, plan);
      }, /chown denied|Failed to write/i);

      fs.readFileSync(fixture.unitPath, 'utf8').should.equal(fixture.unitContent);
      fs.readFileSync(fixture.envPath, 'utf8').should.equal('FOO=bar\nPATH=/usr/bin:/bin\n');
    });
  });

  describe('restore', function() {
    it('restores original contents, modes, owners and a previously absent env file', function() {
      var recording = proxyFs({ failRenameAt: 2 });
      var fixture = regularFixture({
        fs: recording.fs,
        unitMode: 0o640
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      assert.throws(function() {
        fixture.config.apply(snapshot, plan);
      });

      fixture.config.restore(snapshot);

      fs.readFileSync(fixture.unitPath, 'utf8').should.equal(fixture.unitContent);
      fs.existsSync(fixture.envPath).should.be.false();
      (fs.statSync(fixture.unitPath).mode & 0o777).should.equal(0o640);
      fs.statSync(fixture.unitPath).uid.should.equal(snapshot.unit.uid);
      fs.statSync(fixture.unitPath).gid.should.equal(snapshot.unit.gid);
    });

    it('continues restoring env when restoring the unit fails', function() {
      var fixture = regularFixture({
        envContent: 'FOO=bar\nPATH=/usr/bin:/bin\n',
        envMode: 0o600
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      fixture.config.apply(snapshot, plan);
      fs.unlinkSync(fixture.unitPath);
      fs.mkdirSync(fixture.unitPath);

      assert.throws(function() {
        fixture.config.restore(snapshot);
      }, /unit/i);

      fs.readFileSync(fixture.envPath, 'utf8').should.equal('FOO=bar\nPATH=/usr/bin:/bin\n');
      (fs.statSync(fixture.envPath).mode & 0o777).should.equal(0o600);
    });

    it('aggregates errors when both restores fail', function() {
      var fixture = regularFixture({
        envContent: 'FOO=bar\nPATH=/usr/bin:/bin\n'
      });
      var snapshot = fixture.config.inspect(fixture.entry);
      var plan = fixture.config.plan(snapshot, runtime());

      fixture.config.apply(snapshot, plan);
      fs.unlinkSync(fixture.unitPath);
      fs.mkdirSync(fixture.unitPath);
      fs.unlinkSync(fixture.envPath);
      fs.mkdirSync(fixture.envPath);

      assert.throws(function() {
        fixture.config.restore(snapshot);
      }, function(error) {
        return /unit/i.test(error.message) && /env/i.test(error.message);
      });
    });
  });

  describe('Systemd.getRuntimeProperties', function() {
    var originalSystemctl;

    beforeEach(function() {
      originalSystemctl = Systemd._systemctl;
    });

    afterEach(function() {
      Systemd._systemctl = originalSystemctl;
    });

    it('queries the required properties through an argument array', function() {
      var seenArgs;
      Systemd._systemctl = function(args) {
        seenArgs = args;
        return [
          'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /srv/app.js ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }',
          'FragmentPath=/etc/systemd/system/zm2-app.service',
          'DropInPaths=',
          'Environment=NODE_APP_INSTANCE=0',
          'EnvironmentFiles=/etc/zm2/env/zm2-app.env (ignore_errors=yes)',
          'User=deploy',
          'Group=deploy'
        ].join('\n');
      };

      var properties = Systemd.getRuntimeProperties('zm2-app');

      seenArgs.should.be.Array();
      seenArgs[0].should.equal('show');
      seenArgs.should.containEql('zm2-app.service');
      var propertyArg = seenArgs.filter(function(arg) {
        return arg.indexOf('--property=') === 0;
      })[0];
      should(propertyArg).be.a.String();
      ['ExecStart', 'FragmentPath', 'DropInPaths', 'Environment', 'EnvironmentFiles', 'User', 'Group']
        .forEach(function(property) {
          propertyArg.should.containEql(property);
        });

      properties.FragmentPath.should.equal('/etc/systemd/system/zm2-app.service');
      properties.Environment.should.equal('NODE_APP_INSTANCE=0');
      properties.EnvironmentFiles.should.equal('/etc/zm2/env/zm2-app.env (ignore_errors=yes)');
      properties.User.should.equal('deploy');
      properties.Group.should.equal('deploy');
    });

    it('rejects unsafe unit names without invoking systemctl', function() {
      var called = false;
      Systemd._systemctl = function() {
        called = true;
        return '';
      };

      assert.throws(function() {
        Systemd.getRuntimeProperties('zm2-app;reboot');
      }, /Invalid systemd unit name/i);
      assert.throws(function() {
        Systemd.getRuntimeProperties('--help');
      }, /Invalid systemd unit name/i);
      assert.throws(function() {
        Systemd.getRuntimeProperties(' zm2-app');
      }, /Invalid systemd unit name/i);
      assert.throws(function() {
        Systemd.getRuntimeProperties('zm2-app\n');
      }, /Invalid systemd unit name/i);
      called.should.be.false();
    });
  });

  describe('Systemd.getProcessExecutable', function() {
    it('resolves the real executable through /proc/<pid>/exe', function() {
      var originalRealpath = fs.realpathSync;
      var seenPath;
      fs.realpathSync = function(processPath) {
        seenPath = processPath;
        return '/opt/zm2-node/bin/node';
      };

      try {
        Systemd.getProcessExecutable(1234).should.equal('/opt/zm2-node/bin/node');
        seenPath.should.equal('/proc/1234/exe');
      } finally {
        fs.realpathSync = originalRealpath;
      }
    });

    it('rejects invalid process ids', function() {
      assert.throws(function() {
        Systemd.getProcessExecutable('not-a-pid');
      }, /Invalid process id/i);
      assert.throws(function() {
        Systemd.getProcessExecutable(0);
      }, /Invalid process id/i);
    });
  });
});
