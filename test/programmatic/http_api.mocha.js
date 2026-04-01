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
});
