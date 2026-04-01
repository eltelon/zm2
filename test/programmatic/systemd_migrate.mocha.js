
var should = require('should');
var fs = require('fs');
var path = require('path');
var os = require('os');

// We need to test the normalizeConfig function which is not exported,
// so we test it through the UnitGenerator that consumes its output.
var UnitGenerator = require('../../lib/Systemd/UnitGenerator');

describe('Migration: PM2 config normalization', function() {

  describe('pm2 jlist format (with pm2_env wrapper)', function() {
    it('should handle standard pm2 jlist process object', function() {
      var pm2Proc = {
        pid: 12345,
        name: 'api-server',
        pm_id: 0,
        pm2_env: {
          name: 'api-server',
          pm_exec_path: '/home/deploy/api/server.js',
          pm_cwd: '/home/deploy/api',
          exec_interpreter: 'node',
          exec_mode: 'fork_mode',
          node_args: ['--max-old-space-size=4096'],
          args: ['--port', '3000'],
          instances: 1,
          autorestart: true,
          restart_delay: 5000,
          max_restarts: 10,
          kill_timeout: 3000,
          max_memory_restart: '500M',
          namespace: 'production',
          env: {
            NODE_ENV: 'production',
            PORT: '3000',
            pm_id: '0',
            PM2_HOME: '/home/deploy/.pm2'
          },
          user: 'deploy',
          version: '2.1.0'
        }
      };

      // Extract env like normalizeConfig does
      var env = pm2Proc.pm2_env;
      var svcName = UnitGenerator.serviceName({ name: env.name });
      svcName.should.equal('zm2-api-server');

      var unit = UnitGenerator.generate({
        name: env.name,
        pm_exec_path: env.pm_exec_path,
        pm_cwd: env.pm_cwd,
        exec_interpreter: env.exec_interpreter,
        node_args: env.node_args,
        args: env.args,
        autorestart: env.autorestart,
        restart_delay: env.restart_delay,
        max_restarts: env.max_restarts,
        kill_timeout: env.kill_timeout,
        max_memory_restart: env.max_memory_restart,
        user: env.user
      });

      unit.should.containEql('ExecStart=node --max-old-space-size=4096 /home/deploy/api/server.js --port 3000');
      unit.should.containEql('WorkingDirectory=/home/deploy/api');
      unit.should.containEql('User=deploy');
      unit.should.containEql('Restart=on-failure');
      unit.should.containEql('RestartSec=5');
      unit.should.containEql('StartLimitBurst=10');
      unit.should.containEql('TimeoutStopSec=3');
      unit.should.containEql('MemoryMax=500M');
    });
  });

  describe('pm2 dump format (flat config)', function() {
    it('should handle standard pm2 dump process entry', function() {
      var dumpEntry = {
        name: 'worker',
        script: '/home/deploy/worker.js',
        cwd: '/home/deploy',
        exec_interpreter: 'node',
        exec_mode: 'fork_mode',
        autorestart: true,
        max_memory_restart: 209715200,
        env: {
          NODE_ENV: 'production'
        }
      };

      var svcName = UnitGenerator.serviceName({ name: dumpEntry.name });
      svcName.should.equal('zm2-worker');

      var unit = UnitGenerator.generate({
        name: dumpEntry.name,
        pm_exec_path: dumpEntry.script,
        pm_cwd: dumpEntry.cwd,
        exec_interpreter: dumpEntry.exec_interpreter,
        autorestart: dumpEntry.autorestart,
        max_memory_restart: dumpEntry.max_memory_restart
      });

      unit.should.containEql('ExecStart=node /home/deploy/worker.js');
      unit.should.containEql('WorkingDirectory=/home/deploy');
      unit.should.containEql('MemoryMax=200M');
    });
  });

  describe('cluster mode processes', function() {
    it('should generate template unit for cluster mode with multiple instances', function() {
      var unit = UnitGenerator.generate({
        name: 'api',
        pm_exec_path: '/app/server.js',
        exec_interpreter: 'node',
        pm_cwd: '/app'
      }, { isTemplate: true });

      unit.should.containEql('Environment=NODE_APP_INSTANCE=%i');
    });
  });

  describe('env file generation from PM2 config', function() {
    it('should filter out pm_ prefixed internal vars', function() {
      var envContent = UnitGenerator.generateEnvFile({
        env: {
          NODE_ENV: 'production',
          PORT: '3000',
          pm_id: '0',
          pm_exec_path: '/app.js',
          pm2_env: 'something'
        }
      });

      envContent.should.containEql('NODE_ENV=production');
      envContent.should.containEql('PORT=3000');
      envContent.should.not.containEql('pm_id');
      envContent.should.not.containEql('pm_exec_path');
      envContent.should.not.containEql('pm2_env');
    });

    it('should include non-internal env vars', function() {
      // PM2_HOME and ZM2_HOME filtering happens in normalizeConfig,
      // not in generateEnvFile — generateEnvFile only filters pm_ prefix
      var envContent = UnitGenerator.generateEnvFile({
        env: {
          DATABASE_URL: 'postgres://localhost/mydb',
          REDIS_URL: 'redis://localhost:6379'
        }
      });

      envContent.should.containEql('DATABASE_URL=postgres://localhost/mydb');
      envContent.should.containEql('REDIS_URL=redis://localhost:6379');
    });
  });

  describe('various interpreters', function() {
    it('should handle python interpreter', function() {
      var unit = UnitGenerator.generate({
        name: 'ml-worker',
        pm_exec_path: '/app/train.py',
        exec_interpreter: 'python3',
        pm_cwd: '/app'
      });

      unit.should.containEql('ExecStart=python3 /app/train.py');
    });

    it('should handle binary (interpreter=none)', function() {
      var unit = UnitGenerator.generate({
        name: 'mybin',
        pm_exec_path: '/usr/local/bin/myapp',
        exec_interpreter: 'none',
        pm_cwd: '/'
      });

      unit.should.containEql('ExecStart=/usr/local/bin/myapp');
    });
  });

  describe('autorestart disabled', function() {
    it('should set Restart=no', function() {
      var unit = UnitGenerator.generate({
        name: 'oneshot',
        pm_exec_path: '/app/task.js',
        autorestart: false
      });

      unit.should.containEql('Restart=no');
    });
  });
});
