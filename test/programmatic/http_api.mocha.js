var should = require('should');
var path = require('path');
var fs = require('fs');
var http = require('http');
var HttpApi = require('../../lib/API/HttpApi');

describe('HttpApi', function() {
  describe('formatPrometheusMetrics', function() {
    it('should format process data as Prometheus text', function() {
      var processes = [
        {
          pid: 1234,
          name: 'myapp',
          pm_id: 0,
          pm2_env: {
            name: 'myapp',
            status: 'online',
            pm_uptime: Date.now() - 3600000,
            restart_time: 2
          },
          monit: { memory: 52428800, cpu: 12.5 }
        }
      ];

      var output = HttpApi.formatPrometheusMetrics(processes);

      output.should.containEql('# HELP zm2_process_cpu_percent CPU usage percentage');
      output.should.containEql('# TYPE zm2_process_cpu_percent gauge');
      output.should.containEql('zm2_process_cpu_percent{name="myapp"} 12.5');
      output.should.containEql('zm2_process_memory_bytes{name="myapp"} 52428800');
      output.should.containEql('zm2_process_restart_count{name="myapp"} 2');
      output.should.containEql('zm2_process_status{name="myapp",status="online"} 1');
      output.should.containEql('zm2_process_status{name="myapp",status="stopped"} 0');
      output.should.containEql('zm2_process_status{name="myapp",status="errored"} 0');
      // Uptime should be approximately 3600 seconds
      output.should.match(/zm2_process_uptime_seconds\{name="myapp"\} 3[56]\d\d/);
    });

    it('should handle multiple processes', function() {
      var processes = [
        {
          pid: 1234, name: 'app1', pm_id: 0,
          pm2_env: { name: 'app1', status: 'online', pm_uptime: Date.now() - 1000, restart_time: 0 },
          monit: { memory: 100, cpu: 1.0 }
        },
        {
          pid: 5678, name: 'app2', pm_id: 1,
          pm2_env: { name: 'app2', status: 'stopped', pm_uptime: 0, restart_time: 5 },
          monit: { memory: 0, cpu: 0 }
        }
      ];

      var output = HttpApi.formatPrometheusMetrics(processes);
      output.should.containEql('zm2_process_cpu_percent{name="app1"} 1');
      output.should.containEql('zm2_process_cpu_percent{name="app2"} 0');
      output.should.containEql('zm2_process_status{name="app2",status="stopped"} 1');
      output.should.containEql('zm2_process_status{name="app2",status="online"} 0');
    });

    it('should return empty string for no processes', function() {
      var output = HttpApi.formatPrometheusMetrics([]);
      output.should.equal('');
    });
  });

  describe('formatProcessList', function() {
    it('should format processes as JSON-ready object', function() {
      var processes = [
        {
          pid: 1234, name: 'myapp', pm_id: 0,
          pm2_env: { name: 'myapp', status: 'online', pm_uptime: Date.now() - 3600000, restart_time: 2 },
          monit: { memory: 52428800, cpu: 12.5 }
        }
      ];

      var result = HttpApi.formatProcessList(processes);
      result.processes.should.be.an.Array();
      result.processes.length.should.equal(1);
      var p = result.processes[0];
      p.name.should.equal('myapp');
      p.pm_id.should.equal(0);
      p.pid.should.equal(1234);
      p.status.should.equal('online');
      p.cpu.should.equal(12.5);
      p.memory.should.equal(52428800);
      p.restarts.should.equal(2);
      p.should.have.property('uptime');
    });
  });

  describe('parseRoute', function() {
    it('should parse GET /metrics', function() {
      var route = HttpApi.parseRoute('GET', '/metrics');
      route.handler.should.equal('metrics');
    });

    it('should parse GET /api/processes', function() {
      var route = HttpApi.parseRoute('GET', '/api/processes');
      route.handler.should.equal('listProcesses');
    });

    it('should parse POST /api/processes', function() {
      var route = HttpApi.parseRoute('POST', '/api/processes');
      route.handler.should.equal('createProcess');
    });

    it('should parse POST /api/processes/:name/start', function() {
      var route = HttpApi.parseRoute('POST', '/api/processes/myapp/start');
      route.handler.should.equal('startProcess');
      route.name.should.equal('myapp');
    });

    it('should parse POST /api/processes/:name/stop', function() {
      var route = HttpApi.parseRoute('POST', '/api/processes/myapp/stop');
      route.handler.should.equal('stopProcess');
      route.name.should.equal('myapp');
    });

    it('should parse POST /api/processes/:name/restart', function() {
      var route = HttpApi.parseRoute('POST', '/api/processes/worker/restart');
      route.handler.should.equal('restartProcess');
      route.name.should.equal('worker');
    });

    it('should return 404 for unknown routes', function() {
      var route = HttpApi.parseRoute('GET', '/unknown');
      route.handler.should.equal('notFound');
    });

    it('should return 405 for wrong method', function() {
      var route = HttpApi.parseRoute('DELETE', '/api/processes/myapp/stop');
      route.handler.should.equal('methodNotAllowed');
    });

    it('should return 405 for GET on action routes', function() {
      var route = HttpApi.parseRoute('GET', '/api/processes/myapp/stop');
      route.handler.should.equal('methodNotAllowed');
    });
  });

  describe('loadOrCreateApiKey', function() {
    var tmpDir = path.join(__dirname, '..', 'tmp_api_key_test');
    var keyPath;

    beforeEach(function() {
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      keyPath = path.join(tmpDir, 'api-key');
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    });

    afterEach(function() {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
      if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir);
    });

    it('should generate a new key if none exists', function() {
      var key = HttpApi.loadOrCreateApiKey(keyPath);
      key.should.be.a.String();
      key.length.should.equal(64);
      fs.existsSync(keyPath).should.be.true();
      fs.readFileSync(keyPath, 'utf8').should.equal(key);
    });

    it('should reuse existing key', function() {
      fs.writeFileSync(keyPath, 'existingtoken123');
      var key = HttpApi.loadOrCreateApiKey(keyPath);
      key.should.equal('existingtoken123');
    });
  });

  describe('checkAuth', function() {
    it('should return true for valid bearer token', function() {
      HttpApi.checkAuth('Bearer abc123', 'abc123').should.be.true();
    });

    it('should return false for invalid token', function() {
      HttpApi.checkAuth('Bearer wrong', 'abc123').should.be.false();
    });

    it('should return false for missing header', function() {
      HttpApi.checkAuth(undefined, 'abc123').should.be.false();
    });

    it('should return false for malformed header', function() {
      HttpApi.checkAuth('Basic abc123', 'abc123').should.be.false();
    });
  });

  describe('HTTP server', function() {
    var server;
    var port = 19615;
    var apiKey = 'testtoken123';
    var mockApi;

    before(function(done) {
      mockApi = {
        Client: {
          executeRemote: function(method, data, cb) {
            if (method === 'getMonitorData') {
              return cb(null, [
                {
                  pid: 1234, name: 'testapp', pm_id: 0,
                  pm2_env: { name: 'testapp', status: 'online', pm_uptime: Date.now() - 60000, restart_time: 1 },
                  monit: { memory: 1024, cpu: 5.5 }
                }
              ]);
            }
            if (method === 'startProcessId') {
              return cb(null, { pm_id: data.id, status: 'online' });
            }
            if (method === 'stopProcessId') {
              return cb(null, { pm_id: data.id, status: 'stopped' });
            }
            if (method === 'restartProcessId') {
              return cb(null, { pm_id: data.id, status: 'online' });
            }
            return cb(new Error('Unknown method: ' + method));
          }
        },
        start: function(script, opts, cb) {
          cb(null, [{ pm2_env: { name: opts.name || 'app', status: 'online' } }]);
        }
      };

      server = HttpApi.createServer(mockApi, apiKey);
      server.listen(port, done);
    });

    after(function(done) {
      server.close(done);
    });

    it('GET /metrics should return prometheus text without auth', function(done) {
      http.get('http://127.0.0.1:' + port + '/metrics', function(res) {
        res.statusCode.should.equal(200);
        res.headers['content-type'].should.startWith('text/plain');
        var body = '';
        res.on('data', function(chunk) { body += chunk; });
        res.on('end', function() {
          body.should.containEql('zm2_process_cpu_percent{name="testapp"} 5.5');
          done();
        });
      });
    });

    it('GET /api/processes should require auth', function(done) {
      http.get('http://127.0.0.1:' + port + '/api/processes', function(res) {
        res.statusCode.should.equal(401);
        done();
      });
    });

    it('GET /api/processes should return JSON with valid auth', function(done) {
      var opts = {
        hostname: '127.0.0.1', port: port, path: '/api/processes',
        headers: { 'Authorization': 'Bearer ' + apiKey }
      };
      http.get(opts, function(res) {
        res.statusCode.should.equal(200);
        var body = '';
        res.on('data', function(chunk) { body += chunk; });
        res.on('end', function() {
          var data = JSON.parse(body);
          data.processes.should.be.an.Array();
          data.processes[0].name.should.equal('testapp');
          done();
        });
      });
    });

    it('POST /api/processes/:name/stop should stop process', function(done) {
      var opts = {
        hostname: '127.0.0.1', port: port, path: '/api/processes/testapp/stop',
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey }
      };
      var req = http.request(opts, function(res) {
        res.statusCode.should.equal(200);
        var body = '';
        res.on('data', function(chunk) { body += chunk; });
        res.on('end', function() {
          var data = JSON.parse(body);
          data.success.should.be.true();
          done();
        });
      });
      req.end();
    });

    it('POST /api/processes/:name/restart should restart process', function(done) {
      var opts = {
        hostname: '127.0.0.1', port: port, path: '/api/processes/testapp/restart',
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey }
      };
      var req = http.request(opts, function(res) {
        res.statusCode.should.equal(200);
        var body = '';
        res.on('data', function(chunk) { body += chunk; });
        res.on('end', function() {
          var data = JSON.parse(body);
          data.success.should.be.true();
          done();
        });
      });
      req.end();
    });

    it('POST /api/processes should create a new process', function(done) {
      var postData = JSON.stringify({ script: '/tmp/app.js', name: 'newapp' });
      var opts = {
        hostname: '127.0.0.1', port: port, path: '/api/processes',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      var req = http.request(opts, function(res) {
        res.statusCode.should.equal(200);
        var body = '';
        res.on('data', function(chunk) { body += chunk; });
        res.on('end', function() {
          var data = JSON.parse(body);
          data.success.should.be.true();
          done();
        });
      });
      req.write(postData);
      req.end();
    });

    it('POST /api/processes should return 400 without script', function(done) {
      var postData = JSON.stringify({ name: 'noapp' });
      var opts = {
        hostname: '127.0.0.1', port: port, path: '/api/processes',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      var req = http.request(opts, function(res) {
        res.statusCode.should.equal(400);
        done();
      });
      req.write(postData);
      req.end();
    });

    it('GET /unknown should return 404', function(done) {
      var opts = {
        hostname: '127.0.0.1', port: port, path: '/unknown',
        headers: { 'Authorization': 'Bearer ' + apiKey }
      };
      http.get(opts, function(res) {
        res.statusCode.should.equal(404);
        done();
      });
    });

    it('DELETE /api/processes/myapp/stop should return 405', function(done) {
      var opts = {
        hostname: '127.0.0.1', port: port, path: '/api/processes/myapp/stop',
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + apiKey }
      };
      var req = http.request(opts, function(res) {
        res.statusCode.should.equal(405);
        done();
      });
      req.end();
    });
  });
});
