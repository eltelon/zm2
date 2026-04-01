
var should = require('should');
var UnitGenerator = require('../../lib/Systemd/UnitGenerator');

describe('UnitGenerator', function() {

  describe('serviceName', function() {
    it('should generate zm2- prefixed name', function() {
      var name = UnitGenerator.serviceName({ name: 'myapp' });
      name.should.equal('zm2-myapp');
    });

    it('should sanitize special characters', function() {
      var name = UnitGenerator.serviceName({ name: 'my app@v2.0' });
      name.should.equal('zm2-my-app-v2-0');
    });

    it('should fall back to script basename', function() {
      var name = UnitGenerator.serviceName({ pm_exec_path: '/home/user/server.js' });
      name.should.equal('zm2-server');
    });
  });

  describe('buildExecStart', function() {
    it('should build basic node command', function() {
      var cmd = UnitGenerator.buildExecStart({
        exec_interpreter: 'node',
        pm_exec_path: '/home/user/app.js'
      });
      cmd.should.equal('node /home/user/app.js');
    });

    it('should include node_args', function() {
      var cmd = UnitGenerator.buildExecStart({
        exec_interpreter: 'node',
        node_args: ['--max-old-space-size=4096'],
        pm_exec_path: '/home/user/app.js'
      });
      cmd.should.equal('node --max-old-space-size=4096 /home/user/app.js');
    });

    it('should include app args', function() {
      var cmd = UnitGenerator.buildExecStart({
        exec_interpreter: 'node',
        pm_exec_path: '/home/user/app.js',
        args: ['--port', '3000']
      });
      cmd.should.equal('node /home/user/app.js --port 3000');
    });

    it('should handle interpreter=none', function() {
      var cmd = UnitGenerator.buildExecStart({
        exec_interpreter: 'none',
        pm_exec_path: '/home/user/mybin'
      });
      cmd.should.equal('/home/user/mybin');
    });

    it('should handle python interpreter', function() {
      var cmd = UnitGenerator.buildExecStart({
        exec_interpreter: 'python3',
        pm_exec_path: '/home/user/script.py'
      });
      cmd.should.equal('python3 /home/user/script.py');
    });
  });

  describe('parseMemory', function() {
    it('should parse number as bytes to MB', function() {
      var mem = UnitGenerator.parseMemory(209715200); // 200MB
      mem.should.equal('200M');
    });

    it('should pass through already-formatted strings', function() {
      var mem = UnitGenerator.parseMemory('500M');
      mem.should.equal('500M');
    });

    it('should return null for falsy', function() {
      should(UnitGenerator.parseMemory(null)).be.null();
      should(UnitGenerator.parseMemory(0)).be.null();
    });
  });

  describe('generate', function() {
    it('should generate valid unit file', function() {
      var unit = UnitGenerator.generate({
        name: 'myapp',
        pm_exec_path: '/home/user/app.js',
        exec_interpreter: 'node',
        pm_cwd: '/home/user',
        user: 'deploy'
      });

      unit.should.containEql('[Unit]');
      unit.should.containEql('[Service]');
      unit.should.containEql('[Install]');
      unit.should.containEql('Type=simple');
      unit.should.containEql('WorkingDirectory=/home/user');
      unit.should.containEql('User=deploy');
      unit.should.containEql('ExecStart=node /home/user/app.js');
      unit.should.containEql('Restart=on-failure');
      unit.should.containEql('WantedBy=multi-user.target');
    });

    it('should set Restart=no when autorestart is false', function() {
      var unit = UnitGenerator.generate({
        name: 'myapp',
        pm_exec_path: '/app.js',
        autorestart: false
      });
      unit.should.containEql('Restart=no');
    });

    it('should set KillSignal', function() {
      var unit = UnitGenerator.generate({
        name: 'myapp',
        pm_exec_path: '/app.js',
        kill_signal: 'SIGTERM'
      });
      unit.should.containEql('KillSignal=SIGTERM');
    });

    it('should set MemoryMax', function() {
      var unit = UnitGenerator.generate({
        name: 'myapp',
        pm_exec_path: '/app.js',
        max_memory_restart: '500M'
      });
      unit.should.containEql('MemoryMax=500M');
    });

    it('should set RestartSec from restart_delay', function() {
      var unit = UnitGenerator.generate({
        name: 'myapp',
        pm_exec_path: '/app.js',
        restart_delay: 5000
      });
      unit.should.containEql('RestartSec=5');
    });

    it('should set StartLimitBurst from max_restarts', function() {
      var unit = UnitGenerator.generate({
        name: 'myapp',
        pm_exec_path: '/app.js',
        max_restarts: 10
      });
      unit.should.containEql('StartLimitBurst=10');
    });

    it('should set NODE_APP_INSTANCE for template units', function() {
      var unit = UnitGenerator.generate({
        name: 'myapp',
        pm_exec_path: '/app.js'
      }, { isTemplate: true });
      unit.should.containEql('Environment=NODE_APP_INSTANCE=%i');
    });

    it('should set SuccessExitStatus for stop_exit_codes', function() {
      var unit = UnitGenerator.generate({
        name: 'myapp',
        pm_exec_path: '/app.js',
        stop_exit_codes: [0, 143]
      });
      unit.should.containEql('SuccessExitStatus=0 143');
    });
  });

  describe('generateEnvFile', function() {
    it('should generate KEY=VALUE lines', function() {
      var env = UnitGenerator.generateEnvFile({
        env: { NODE_ENV: 'production', PORT: '3000' }
      });
      env.should.containEql('NODE_ENV=production');
      env.should.containEql('PORT=3000');
    });

    it('should quote values with spaces', function() {
      var env = UnitGenerator.generateEnvFile({
        env: { MSG: 'hello world' }
      });
      env.should.containEql('MSG="hello world"');
    });

    it('should skip pm_ prefixed internal vars', function() {
      var env = UnitGenerator.generateEnvFile({
        env: { NODE_ENV: 'prod', pm_id: '0', pm_cwd: '/tmp' }
      });
      env.should.containEql('NODE_ENV=prod');
      env.should.not.containEql('pm_id');
      env.should.not.containEql('pm_cwd');
    });
  });

  describe('cronToCalendar', function() {
    it('should convert daily midnight cron', function() {
      var cal = UnitGenerator.cronToCalendar('0 0 * * *');
      cal.should.equal('*-*-* 0:0:00');
    });

    it('should convert specific time cron', function() {
      var cal = UnitGenerator.cronToCalendar('30 14 * * *');
      cal.should.equal('*-*-* 14:30:00');
    });

    it('should handle day of week', function() {
      var cal = UnitGenerator.cronToCalendar('0 0 * * 1');
      cal.should.containEql('Mon');
    });

    it('should handle specific month/day', function() {
      var cal = UnitGenerator.cronToCalendar('0 6 15 1 *');
      cal.should.equal('*-1-15 6:0:00');
    });
  });

  describe('generateCronTimer', function() {
    it('should generate timer and service units', function() {
      var result = UnitGenerator.generateCronTimer('zm2-myapp', '0 0 * * *');
      result.should.have.property('timer');
      result.should.have.property('service');

      result.timer.should.containEql('[Timer]');
      result.timer.should.containEql('OnCalendar=');
      result.timer.should.containEql('[Install]');

      result.service.should.containEql('[Service]');
      result.service.should.containEql('Type=oneshot');
      result.service.should.containEql('ExecStart=/usr/bin/systemctl restart zm2-myapp.service');
    });
  });
});
