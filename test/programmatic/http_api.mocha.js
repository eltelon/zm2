var should = require('should');
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
});
