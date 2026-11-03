var should = require('should');
var fs = require('fs');
var os = require('os');
var path = require('path');
var Nvm = require('../../lib/tools/Nvm');

var tempRoots = [];

function createRoot(prefix) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeFileWithMode(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== undefined) {
    fs.chmodSync(file, mode);
  }
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function setupNvmDir(nvmDir, options) {
  options = options || {};
  fs.mkdirSync(nvmDir, { recursive: true });

  if (options.nvmSh !== false) {
    fs.writeFileSync(path.join(nvmDir, 'nvm.sh'), '# fake nvm.sh\n');
  }

  if (options.aliasDir !== false) {
    fs.mkdirSync(path.join(nvmDir, 'alias'), { recursive: true });
  }

  if (options.defaultAlias !== undefined) {
    writeFileWithMode(aliasPath(nvmDir), options.defaultAlias, options.defaultMode);
  }

  return nvmDir;
}

function aliasPath(nvmDir) {
  return path.join(nvmDir, 'alias', 'default');
}

function runtimePath(nvmDir, version) {
  return path.join(nvmDir, 'versions', 'node', 'v' + version, 'bin', 'node');
}

function createRuntime(nvmDir, version, mode) {
  var executable = runtimePath(nvmDir, version);
  writeFileWithMode(executable, '#!/bin/sh\nexit 0\n', mode === undefined ? 0o755 : mode);
  return executable;
}

function makeRunner(handler) {
  var calls = [];

  function run(command, args, options) {
    var call = { command: command, args: args, options: options };
    calls.push(call);
    return Promise.resolve(handler(call));
  }

  run.calls = calls;
  return run;
}

function nvmArgs(call) {
  return call.args.slice(-2);
}

function callLabel(call) {
  if (call.command === '/bin/bash') {
    return nvmArgs(call).join(' ');
  }
  return call.command;
}

function assertBounded(call) {
  Number.isFinite(call.options.timeout).should.equal(true);
  call.options.timeout.should.be.above(0);
  Number.isFinite(call.options.maxBuffer).should.equal(true);
  call.options.maxBuffer.should.be.above(0);
  call.options.shell.should.equal(false);
}

function assertNvmShellCall(call, nvmDir) {
  call.command.should.equal('/bin/bash');
  call.args[0].should.equal('--noprofile');
  call.args[1].should.equal('--norc');
  call.args[2].should.equal('-c');
  call.args[4].should.equal('zm2-nvm');
  call.args[5].should.equal(path.join(nvmDir, 'nvm.sh'));
  call.args.should.not.containEql('-i');

  var script = call.args[3];
  script.should.match(/\.\s+"\$1"/);
  script.should.not.containEql(nvmDir);
}

async function expectReject(promise, pattern) {
  var error = null;

  try {
    await promise;
  } catch (err) {
    error = err;
  }

  should.exist(error);
  if (pattern) {
    error.message.should.match(pattern);
  }
  return error;
}

afterEach(function() {
  tempRoots.forEach(function(root) {
    fs.rmSync(root, { recursive: true, force: true });
  });
  tempRoots = [];
});

describe('Nvm', function() {
  describe('validateVersion', function() {
    it('accepts an exact major.minor.patch version', function() {
      var nvm = new Nvm({});
      nvm.validateVersion('26.12.1').should.equal('26.12.1');
    });

    it('normalizes a leading v prefix', function() {
      var nvm = new Nvm({});
      nvm.validateVersion('v26.12.1').should.equal('26.12.1');
    });

    it('rejects aliases and semver ranges', function() {
      var nvm = new Nvm({});
      [
        'lts',
        'lts/*',
        'node',
        'stable',
        '>=26.12.1',
        '^26.12.1',
        '~26.12.1',
        '26.x',
        '26.12',
        '26.12.1 || 24.0.0'
      ].forEach(function(input) {
        should.throws(function() {
          nvm.validateVersion(input);
        }, /exact/);
      });
    });

    it('rejects prerelease and build metadata versions', function() {
      var nvm = new Nvm({});
      ['26.12.1-rc.1', '26.12.1+build.1', 'v26.12.1-0'].forEach(function(input) {
        should.throws(function() {
          nvm.validateVersion(input);
        }, /exact/);
      });
    });

    it('rejects surrounding and embedded whitespace', function() {
      var nvm = new Nvm({});
      [' 26.12.1', '26.12.1 ', '26.12.1\n', '26.12.1\t', '26. 12.1'].forEach(function(input) {
        should.throws(function() {
          nvm.validateVersion(input);
        }, /exact/);
      });
    });

    it('rejects invalid leading zeros', function() {
      var nvm = new Nvm({});
      ['026.12.1', '26.012.1', '26.12.01', '00.1.1'].forEach(function(input) {
        should.throws(function() {
          nvm.validateVersion(input);
        }, /exact/);
      });
    });

    it('rejects shell metacharacters and path separators', function() {
      var nvm = new Nvm({});
      [
        '26.12.1; touch /tmp/zm2-nvm-pwned',
        '26.12.1$(id)',
        '26.12.1|cat',
        '26.12.1&&id',
        '26.12.1\nid',
        '26.12.1`id`',
        '26.12.1/../x'
      ].forEach(function(input) {
        should.throws(function() {
          nvm.validateVersion(input);
        }, /exact/);
      });
    });

    it('rejects non-string input', function() {
      var nvm = new Nvm({});
      [26.12, null, undefined, {}].forEach(function(input) {
        should.throws(function() {
          nvm.validateVersion(input);
        }, /exact/);
      });
    });
  });

  describe('prepare', function() {
    it('resolves and verifies an existing runtime without installing it', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir with spaces'), {
        defaultAlias: 'v20.1.0\n',
        defaultMode: 0o640
      });
      var executable = createRuntime(nvmDir, '26.12.1');
      var env = {
        NVM_DIR: nvmDir,
        HOME: path.join(root, 'home dir without nvm'),
        PATH: '/usr/bin:/bin'
      };
      var envSnapshot = Object.assign({}, env);

      var runner = makeRunner(function(call) {
        if (call.command === '/bin/bash') {
          nvmArgs(call).should.eql(['which', '26.12.1']);
          return { code: 0, stdout: executable + '\n', stderr: '' };
        }

        if (call.command === executable) {
          call.args.should.eql(['--version']);
          return { code: 0, stdout: 'v26.12.1\n', stderr: '' };
        }

        throw new Error('unexpected command: ' + call.command);
      });

      var nvm = new Nvm({ env: env, fs: fs, run: runner });
      var result = await nvm.prepare('v26.12.1');

      result.should.eql({
        version: '26.12.1',
        executable: executable,
        binDir: path.dirname(executable)
      });

      runner.calls.map(callLabel).should.eql(['which 26.12.1', executable]);
      runner.calls.forEach(assertBounded);

      var shellCall = runner.calls[0];
      assertNvmShellCall(shellCall, nvmDir);
      shellCall.args[3].should.not.containEql('26.12.1');
      shellCall.options.env.NVM_DIR.should.equal(nvmDir);
      shellCall.options.env.should.not.equal(env);

      env.should.eql(envSnapshot);
      Buffer.compare(fs.readFileSync(aliasPath(nvmDir)), Buffer.from('v20.1.0\n')).should.equal(0);
      (fs.statSync(aliasPath(nvmDir)).mode & 0o7777).should.equal(0o640);
    });

    it('falls back to HOME/.nvm when NVM_DIR is not set', async function() {
      var root = createRoot('zm2-nvm-');
      var home = path.join(root, 'home dir with spaces');
      var nvmDir = setupNvmDir(path.join(home, '.nvm'), {
        defaultAlias: 'v18.0.0\n'
      });
      var executable = createRuntime(nvmDir, '26.12.1');
      var env = {
        HOME: home,
        PATH: '/usr/bin:/bin'
      };

      var runner = makeRunner(function(call) {
        if (call.command === '/bin/bash') {
          nvmArgs(call).should.eql(['which', '26.12.1']);
          return { code: 0, stdout: executable + '\n', stderr: '' };
        }

        if (call.command === executable) {
          return { code: 0, stdout: 'v26.12.1\n', stderr: '' };
        }

        throw new Error('unexpected command: ' + call.command);
      });

      var nvm = new Nvm({ env: env, fs: fs, run: runner });
      var result = await nvm.prepare('26.12.1');

      result.executable.should.equal(executable);
      should.not.exist(env.NVM_DIR);
      runner.calls[0].options.env.NVM_DIR.should.equal(nvmDir);
      assertNvmShellCall(runner.calls[0], nvmDir);
    });

    it('fails when neither NVM_DIR nor HOME is available', async function() {
      var runner = makeRunner(function() {
        throw new Error('runner should not be called');
      });
      var nvm = new Nvm({ env: {}, fs: fs, run: runner });

      await expectReject(nvm.prepare('26.12.1'), /NVM_DIR|HOME/);
      runner.calls.length.should.equal(0);
    });

    it('fails when nvm.sh is missing', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir'), { nvmSh: false });
      var runner = makeRunner(function() {
        throw new Error('runner should not be called');
      });
      var nvm = new Nvm({
        env: { NVM_DIR: nvmDir, HOME: path.join(root, 'home') },
        fs: fs,
        run: runner
      });

      await expectReject(nvm.prepare('26.12.1'), /nvm\.sh/);
      runner.calls.length.should.equal(0);
    });

    it('normalizes nonnumeric spawn errors to a numeric exit code', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir with spaces'));
      createRuntime(nvmDir, '26.12.1');
      var missingShell = path.join(root, 'missing shell');
      var nvm = new Nvm({
        env: { NVM_DIR: nvmDir, HOME: path.join(root, 'home') },
        fs: fs,
        shell: missingShell
      });

      var error = await expectReject(nvm.prepare('26.12.1'), /ENOENT/);

      error.code.should.equal(1);
      error.message.should.match(/missing shell/);
      error.message.should.match(/spawn/i);
    });

    it('rejects an invalid version before invoking any process', async function() {
      var runner = makeRunner(function() {
        throw new Error('runner should not be called');
      });
      var nvm = new Nvm({ env: { NVM_DIR: '/unused' }, fs: fs, run: runner });

      await expectReject(nvm.prepare('26.12.1; touch /tmp/zm2-nvm-pwned'), /exact/);
      runner.calls.length.should.equal(0);
    });

    it('installs an absent runtime and preserves the existing default alias bytes and mode', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir with spaces'), {
        defaultAlias: 'v20.1.0\n',
        defaultMode: 0o640
      });
      var executable = runtimePath(nvmDir, '26.12.1');
      var aliasFile = aliasPath(nvmDir);

      var runner = makeRunner(function(call) {
        if (call.command === '/bin/bash') {
          var args = nvmArgs(call);

          if (args[0] === 'install') {
            args.should.eql(['install', '26.12.1']);
            fs.writeFileSync(aliasFile, 'v26.12.1\n');
            fs.chmodSync(aliasFile, 0o644);
            createRuntime(nvmDir, '26.12.1');
            return { code: 0, stdout: 'installed\n', stderr: '' };
          }

          if (args[0] === 'which') {
            args.should.eql(['which', '26.12.1']);
            return { code: 0, stdout: executable + '\n', stderr: '' };
          }
        }

        if (call.command === executable) {
          call.args.should.eql(['--version']);
          return { code: 0, stdout: 'v26.12.1\n', stderr: '' };
        }

        throw new Error('unexpected command: ' + call.command);
      });

      var nvm = new Nvm({
        env: { NVM_DIR: nvmDir, HOME: path.join(root, 'home') },
        fs: fs,
        run: runner
      });
      var result = await nvm.prepare('26.12.1');

      result.should.eql({
        version: '26.12.1',
        executable: executable,
        binDir: path.dirname(executable)
      });
      runner.calls.map(callLabel).should.eql([
        'install 26.12.1',
        'which 26.12.1',
        executable
      ]);
      runner.calls.forEach(assertBounded);
      assertNvmShellCall(runner.calls[0], nvmDir);
      runner.calls[0].args[3].should.not.containEql('26.12.1');

      Buffer.compare(fs.readFileSync(aliasFile), Buffer.from('v20.1.0\n')).should.equal(0);
      (fs.statSync(aliasFile).mode & 0o7777).should.equal(0o640);
    });

    it('preserves the original absence of the default alias after a successful install', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir'));
      var executable = runtimePath(nvmDir, '26.12.1');
      var aliasFile = aliasPath(nvmDir);

      var runner = makeRunner(function(call) {
        if (call.command === '/bin/bash') {
          var args = nvmArgs(call);

          if (args[0] === 'install') {
            fs.writeFileSync(aliasFile, 'v26.12.1\n');
            createRuntime(nvmDir, '26.12.1');
            return { code: 0, stdout: 'installed\n', stderr: '' };
          }

          if (args[0] === 'which') {
            return { code: 0, stdout: executable + '\n', stderr: '' };
          }
        }

        if (call.command === executable) {
          return { code: 0, stdout: 'v26.12.1\n', stderr: '' };
        }

        throw new Error('unexpected command: ' + call.command);
      });

      var nvm = new Nvm({
        env: { NVM_DIR: nvmDir, HOME: path.join(root, 'home') },
        fs: fs,
        run: runner
      });
      await nvm.prepare('26.12.1');

      fs.existsSync(aliasFile).should.equal(false);
      runner.calls.map(callLabel).should.eql([
        'install 26.12.1',
        'which 26.12.1',
        executable
      ]);
    });

    it('preserves an existing default alias when install fails', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir'), {
        defaultAlias: 'v20.1.0\n',
        defaultMode: 0o640
      });
      var aliasFile = aliasPath(nvmDir);

      var runner = makeRunner(function(call) {
        if (call.command === '/bin/bash') {
          nvmArgs(call).should.eql(['install', '26.12.1']);
          fs.writeFileSync(aliasFile, 'v26.12.1\n');
          fs.chmodSync(aliasFile, 0o644);
          return { code: 1, stdout: '', stderr: 'install exploded' };
        }

        throw new Error('unexpected command: ' + call.command);
      });

      var nvm = new Nvm({
        env: { NVM_DIR: nvmDir, HOME: path.join(root, 'home') },
        fs: fs,
        run: runner
      });

      await expectReject(nvm.prepare('26.12.1'), /install exploded/);
      runner.calls.length.should.equal(1);
      runner.calls.map(callLabel).should.eql(['install 26.12.1']);

      Buffer.compare(fs.readFileSync(aliasFile), Buffer.from('v20.1.0\n')).should.equal(0);
      (fs.statSync(aliasFile).mode & 0o7777).should.equal(0o640);
    });

    it('preserves the original absence of the default alias when install fails', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir'));
      var aliasFile = aliasPath(nvmDir);

      var runner = makeRunner(function(call) {
        if (call.command === '/bin/bash') {
          nvmArgs(call).should.eql(['install', '26.12.1']);
          fs.writeFileSync(aliasFile, 'v26.12.1\n');
          return { code: 1, stdout: '', stderr: 'install exploded' };
        }

        throw new Error('unexpected command: ' + call.command);
      });

      var nvm = new Nvm({
        env: { NVM_DIR: nvmDir, HOME: path.join(root, 'home') },
        fs: fs,
        run: runner
      });

      await expectReject(nvm.prepare('26.12.1'), /install exploded/);
      runner.calls.length.should.equal(1);
      fs.existsSync(aliasFile).should.equal(false);
    });

    it('reports alias restoration failures alongside install failures', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir'), {
        defaultAlias: 'v20.1.0\n',
        defaultMode: 0o640
      });
      var aliasFile = aliasPath(nvmDir);
      var realWriteFileSync = fs.writeFileSync;
      var failingFs = {
        constants: fs.constants,
        existsSync: fs.existsSync,
        statSync: fs.statSync,
        lstatSync: fs.lstatSync,
        readFileSync: fs.readFileSync,
        accessSync: fs.accessSync,
        unlinkSync: fs.unlinkSync,
        chmodSync: fs.chmodSync,
        writeFileSync: function(file, data, options) {
          if (file === aliasFile) {
            throw new Error('alias write denied');
          }
          return realWriteFileSync(file, data, options);
        }
      };

      var runner = makeRunner(function(call) {
        if (call.command === '/bin/bash') {
          nvmArgs(call).should.eql(['install', '26.12.1']);
          fs.writeFileSync(aliasFile, 'v26.12.1\n');
          return { code: 1, stdout: '', stderr: 'install exploded' };
        }

        throw new Error('unexpected command: ' + call.command);
      });

      var nvm = new Nvm({
        env: { NVM_DIR: nvmDir, HOME: path.join(root, 'home') },
        fs: failingFs,
        run: runner
      });

      var error = await expectReject(nvm.prepare('26.12.1'), /install exploded/);
      error.message.should.match(/alias write denied/);
      runner.calls.length.should.equal(1);
    });

    it('does not inherit shell startup files from the parent environment', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir'));
      var executable = createRuntime(nvmDir, '26.12.1');
      var env = {
        NVM_DIR: nvmDir,
        HOME: path.join(root, 'home'),
        BASH_ENV: path.join(root, 'evil-bash-env'),
        ENV: path.join(root, 'evil-env'),
        CDPATH: path.join(root, 'evil-cdpath'),
        SHELLOPTS: 'xtrace',
        BASHOPTS: 'extglob',
        NODE_OPTIONS: '--require /tmp/evil.js',
        NODE_V8_COVERAGE: path.join(root, 'coverage')
      };
      var envSnapshot = Object.assign({}, env);

      var runner = makeRunner(function(call) {
        if (call.command === '/bin/bash') {
          return { code: 0, stdout: executable + '\n', stderr: '' };
        }

        if (call.command === executable) {
          return { code: 0, stdout: 'v26.12.1\n', stderr: '' };
        }

        throw new Error('unexpected command: ' + call.command);
      });

      var nvm = new Nvm({ env: env, fs: fs, run: runner });
      await nvm.prepare('26.12.1');

      var childEnv = runner.calls[0].options.env;
      should.not.exist(childEnv.BASH_ENV);
      should.not.exist(childEnv.ENV);
      should.not.exist(childEnv.CDPATH);
      should.not.exist(childEnv.SHELLOPTS);
      should.not.exist(childEnv.BASHOPTS);
      should.not.exist(childEnv.NODE_OPTIONS);
      should.not.exist(childEnv.NODE_V8_COVERAGE);
      env.should.eql(envSnapshot);
    });

    it('uses the real /bin/bash with a local nvm stub and the default runner', async function() {
      try {
        fs.accessSync('/bin/bash', fs.constants.X_OK);
        fs.statSync('/bin/bash').isFile().should.equal(true);
      } catch (err) {
        this.skip();
      }

      var root = createRoot('zm2 nvm real bash ');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir with spaces'), {
        nvmSh: false,
        defaultAlias: 'v20.0.0\n',
        defaultMode: 0o640
      });
      var version = '26.12.1';
      var executable = runtimePath(nvmDir, version);
      var aliasFile = aliasPath(nvmDir);
      var marker = path.join(root, 'bash env was sourced');
      var bashEnv = path.join(root, 'injected bash env');

      writeFileWithMode(
        executable,
        '#!/bin/bash\nprintf \'%s\\n\' \'v26.12.1\'\n',
        0o755
      );
      fs.writeFileSync(
        bashEnv,
        'printf "%s\\n" sourced > ' + shellQuote(marker) + '\n'
      );
      fs.writeFileSync(path.join(nvmDir, 'nvm.sh'), [
        'nvm() {',
        '  if [ "$#" -ne 2 ] || [ "$1" != "which" ] || [ "$2" != "26.12.1" ]; then',
        '    printf "unexpected nvm args (%s): %s\\n" "$#" "$*" >&2',
        '    return 64',
        '  fi',
        '  printf "%s\\n" "$NVM_DIR/versions/node/v26.12.1/bin/node"',
        '}',
        ''
      ].join('\n'));

      var env = {
        NVM_DIR: nvmDir,
        HOME: path.join(root, 'home dir with spaces'),
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        BASH_ENV: bashEnv
      };
      var envSnapshot = Object.assign({}, env);

      var nvm = new Nvm({ env: env, fs: fs });
      var result = await nvm.prepare('v' + version);

      result.should.eql({
        version: version,
        executable: executable,
        binDir: path.dirname(executable)
      });
      fs.existsSync(marker).should.equal(false);
      env.should.eql(envSnapshot);
      Buffer.compare(fs.readFileSync(aliasFile), Buffer.from('v20.0.0\n')).should.equal(0);
      (fs.statSync(aliasFile).mode & 0o7777).should.equal(0o640);
    });

    it('fails before installing when the default alias is a symlink', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir'));
      var target = path.join(root, 'outside-default');
      fs.writeFileSync(target, 'v20.1.0\n');
      fs.symlinkSync(target, aliasPath(nvmDir));

      var runner = makeRunner(function() {
        throw new Error('runner should not be called');
      });
      var nvm = new Nvm({
        env: { NVM_DIR: nvmDir, HOME: path.join(root, 'home') },
        fs: fs,
        run: runner
      });

      await expectReject(nvm.prepare('26.12.1'), /alias|regular file/i);
      runner.calls.length.should.equal(0);
      fs.readFileSync(target, 'utf8').should.equal('v20.1.0\n');
    });

    it('fails before installing when the default alias is a broken symlink', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir'));
      fs.symlinkSync(path.join(root, 'missing-default'), aliasPath(nvmDir));

      var runner = makeRunner(function() {
        throw new Error('runner should not be called');
      });
      var nvm = new Nvm({
        env: { NVM_DIR: nvmDir, HOME: path.join(root, 'home') },
        fs: fs,
        run: runner
      });

      await expectReject(nvm.prepare('26.12.1'), /alias|regular file/i);
      runner.calls.length.should.equal(0);
    });

    it('installs when the alias directory is missing and preserves the original absence', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir'), { aliasDir: false });
      var executable = runtimePath(nvmDir, '26.12.1');
      var aliasFile = aliasPath(nvmDir);

      var runner = makeRunner(function(call) {
        if (call.command === '/bin/bash') {
          var args = nvmArgs(call);

          if (args[0] === 'install') {
            fs.mkdirSync(path.join(nvmDir, 'alias'), { recursive: true });
            fs.writeFileSync(aliasFile, 'v26.12.1\n');
            createRuntime(nvmDir, '26.12.1');
            return { code: 0, stdout: 'installed\n', stderr: '' };
          }

          if (args[0] === 'which') {
            return { code: 0, stdout: executable + '\n', stderr: '' };
          }
        }

        if (call.command === executable) {
          return { code: 0, stdout: 'v26.12.1\n', stderr: '' };
        }

        throw new Error('unexpected command: ' + call.command);
      });

      var nvm = new Nvm({
        env: { NVM_DIR: nvmDir, HOME: path.join(root, 'home') },
        fs: fs,
        run: runner
      });
      await nvm.prepare('26.12.1');

      fs.existsSync(aliasFile).should.equal(false);
      runner.calls.map(callLabel).should.eql([
        'install 26.12.1',
        'which 26.12.1',
        executable
      ]);
    });

    it('fails before installing when the default alias cannot be preserved', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir'), { aliasDir: false });
      fs.writeFileSync(path.join(nvmDir, 'alias'), 'not a directory\n');

      var runner = makeRunner(function() {
        throw new Error('runner should not be called');
      });
      var nvm = new Nvm({
        env: { NVM_DIR: nvmDir, HOME: path.join(root, 'home') },
        fs: fs,
        run: runner
      });

      await expectReject(nvm.prepare('26.12.1'), /alias/i);
      runner.calls.length.should.equal(0);
    });

    it('does not install when an existing runtime cannot be resolved by nvm', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir'));
      createRuntime(nvmDir, '26.12.1');

      var runner = makeRunner(function(call) {
        if (call.command === '/bin/bash') {
          nvmArgs(call).should.eql(['which', '26.12.1']);
          return { code: 1, stdout: '', stderr: 'nvm which failed' };
        }

        throw new Error('unexpected command: ' + call.command);
      });

      var nvm = new Nvm({
        env: { NVM_DIR: nvmDir, HOME: path.join(root, 'home') },
        fs: fs,
        run: runner
      });

      await expectReject(nvm.prepare('26.12.1'), /nvm which failed/);
      runner.calls.map(callLabel).should.eql(['which 26.12.1']);
    });

    it('rejects a relative executable path returned by nvm', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir'));
      var executable = createRuntime(nvmDir, '26.12.1');
      var relative = path.relative(process.cwd(), executable);

      var runner = makeRunner(function(call) {
        if (call.command === '/bin/bash') {
          return { code: 0, stdout: relative + '\n', stderr: '' };
        }

        throw new Error('unexpected command: ' + call.command);
      });

      var nvm = new Nvm({
        env: { NVM_DIR: nvmDir, HOME: path.join(root, 'home') },
        fs: fs,
        run: runner
      });

      await expectReject(nvm.prepare('26.12.1'), /absolute/);
      runner.calls.map(callLabel).should.eql(['which 26.12.1']);
    });

    it('rejects a runtime executable without executable access', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir'));
      var executable = createRuntime(nvmDir, '26.12.1', 0o644);

      var runner = makeRunner(function(call) {
        if (call.command === '/bin/bash') {
          return { code: 0, stdout: executable + '\n', stderr: '' };
        }

        throw new Error('unexpected command: ' + call.command);
      });

      var nvm = new Nvm({
        env: { NVM_DIR: nvmDir, HOME: path.join(root, 'home') },
        fs: fs,
        run: runner
      });

      await expectReject(nvm.prepare('26.12.1'), /executable/i);
      runner.calls.map(callLabel).should.eql(['which 26.12.1']);
    });

    it('rejects a node --version mismatch', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir'));
      var executable = createRuntime(nvmDir, '26.12.1');

      var runner = makeRunner(function(call) {
        if (call.command === '/bin/bash') {
          return { code: 0, stdout: executable + '\n', stderr: '' };
        }

        if (call.command === executable) {
          return { code: 0, stdout: 'v26.12.2\n', stderr: '' };
        }

        throw new Error('unexpected command: ' + call.command);
      });

      var nvm = new Nvm({
        env: { NVM_DIR: nvmDir, HOME: path.join(root, 'home') },
        fs: fs,
        run: runner
      });

      await expectReject(nvm.prepare('26.12.1'), /mismatch/);
      runner.calls.map(callLabel).should.eql(['which 26.12.1', executable]);
    });

    it('requires node --version output to include the exact v-prefixed version', async function() {
      var root = createRoot('zm2-nvm-');
      var nvmDir = setupNvmDir(path.join(root, 'nvm dir'));
      var executable = createRuntime(nvmDir, '26.12.1');

      var runner = makeRunner(function(call) {
        if (call.command === '/bin/bash') {
          return { code: 0, stdout: executable + '\n', stderr: '' };
        }

        if (call.command === executable) {
          return { code: 0, stdout: '26.12.1\n', stderr: '' };
        }

        throw new Error('unexpected command: ' + call.command);
      });

      var nvm = new Nvm({
        env: { NVM_DIR: nvmDir, HOME: path.join(root, 'home') },
        fs: fs,
        run: runner
      });

      await expectReject(nvm.prepare('26.12.1'), /mismatch/);
      runner.calls.map(callLabel).should.eql(['which 26.12.1', executable]);
    });
  });
});
