'use strict';

process.env.ZM2_USAGE = 'CLI';

var cst          = require('../../constants.js');

var commander    = require('commander');
var chalk        = require('ansis');
var forEachLimit = require('async/forEachLimit');

var debug        = require('debug')('pm2:cli');
var PM2          = require('../API.js');
var pkg          = require('../../package.json');
var tabtab       = require('../completion.js');
var Common       = require('../Common.js');
Common.determineSilentCLI();
Common.printVersion();

var pm2 = new PM2();

commander.version(pkg.version)
  .option('-v --version', 'print zm2 version')
  .option('-s --silent', 'hide all messages', false)
  .option('-n --name <name>', 'set a name for the process in the process list')
  .option('-m --mini-list', 'display a compacted list without formatting')
  .option('--interpreter <interpreter>', 'set a specific interpreter to use for executing app, default: node')
  .option('--interpreter-args <arguments>', 'set arguments to pass to the interpreter (alias of --node-args)')
  .option('--node-args <node_args>', 'space delimited arguments to pass to node')
  .option('--filter-env [envs]', 'filter out outgoing global values that contain provided strings', function(v, m) { m.push(v); return m;}, [])
  .option('--env <environment_name>', 'specify which set of environment variables from ecosystem file must be injected')
  .option('-a --update-env', 'force an update of the environment with restart/reload (-a <=> apply)')
  .option('-f --force', 'force actions')
  .option('-i --instances <number>', 'launch [number] instances (for networked app)(load balanced)')
  .option('--parallel <number>', 'number of parallel actions (for restart/reload)')
  .option('--shutdown-with-message', 'shutdown an application with process.send(\'shutdown\') instead of process.kill(pid, SIGINT)')
  .option('-p --pid <pid>', 'specify pid file')
  .option('-k --kill-timeout <delay>', 'delay before sending final SIGKILL signal to process')
  .option('--listen-timeout <delay>', 'listen timeout on application reload')
  .option('--max-memory-restart <memory>', 'Restart the app if an amount of memory is exceeded (in bytes)')
  .option('--restart-delay <delay>', 'specify a delay between restarts (in milliseconds)')
  .option('--exp-backoff-restart-delay <delay>', 'specify a delay between restarts (in milliseconds)')
  .option('-x --execute-command', 'execute a program using fork system')
  .option('--max-restarts [count]', 'only restart the script COUNT times')
  .option('-u --user <username>', 'define user when generating startup script')
  .option('--uid <uid>', 'run target script with <uid> rights')
  .option('--gid <gid>', 'run target script with <gid> rights')
  .option('--namespace <ns>', 'start application within specified namespace')
  .option('--cwd <path>', 'run target script from path <cwd>')
  .option('--hp <home path>', 'define home path when generating startup script')
  .option('--wait-ip', 'override systemd script to wait for full internet connectivity to launch zm2')
  .option('--service-name <name>', 'define service name when generating startup script')
  .option('-c --cron <cron_pattern>', 'restart a running process based on a cron pattern')
  .option('-c --cron-restart <cron_pattern>', '(alias) restart a running process based on a cron pattern')
  .option('-w --write', 'write configuration in local folder')
  .option('--source-map-support', 'force source map support')
  .option('--only <application-name>', 'with json declaration, allow to only act on one application')
  .option('--disable-source-map-support', 'force source map support')
  .option('--wait-ready', 'ask zm2 to wait for ready event from your app')
  .option('--merge-logs', 'merge logs from different instances but keep error and out separated')
  .option('--no-color', 'skip colors')
  .option('--no-autostart', 'add an app without automatic start')
  .option('--no-autorestart', 'start an app without automatic restart')
  .option('--stop-exit-codes <exit_codes...>', 'specify a list of exit codes that should skip automatic restart')
  .option('--sort <field_name:sort>', 'sort process according to field\'s name')
  .option('--attach', 'attach logging after your start/restart/stop/reload')
  .usage('[cmd] app');

function displayUsage() {
  console.log('usage: zm2 [options] <command>')
  console.log('');
  console.log('zm2 -h, --help             all available commands and options');
  console.log('zm2 examples               display zm2 usage examples');
  console.log('zm2 <command> -h           help on a specific command');
  console.log('');
  console.log('Access zm2 files in ~/.zm2');
}

function displayExamples() {
  console.log('- Start and add a process to the zm2 process list:')
  console.log('');
  console.log(chalk.cyan('  $ zm2 start app.js --name app'));
  console.log('');
  console.log('- Show the process list:');
  console.log('');
  console.log(chalk.cyan('  $ zm2 ls'));
  console.log('');
  console.log('- Stop and delete a process from the zm2 process list:');
  console.log('');
  console.log(chalk.cyan('  $ zm2 delete app'));
  console.log('');
  console.log('- Stop, start and restart a process from the process list:');
  console.log('');
  console.log(chalk.cyan('  $ zm2 stop app'));
  console.log(chalk.cyan('  $ zm2 start app'));
  console.log(chalk.cyan('  $ zm2 restart app'));
  console.log('');
  console.log('- Clusterize an app to all CPU cores available:');
  console.log('');
  console.log(chalk.cyan('  $ zm2 start -i max'));
  console.log('');
  console.log('- Update zm2 :');
  console.log('');
  console.log(chalk.cyan('  $ npm install zm2 -g && zm2 update'));
  console.log('');
  console.log('- Install zm2 auto completion:')
  console.log('');
  console.log(chalk.cyan('  $ zm2 completion install'))
  console.log('');
  console.log('Check the full documentation on https://pm2.keymetrics.io/');
  console.log('');
}

function beginCommandProcessing() {
  pm2.getVersion(function(err, remote_version) {
    if (!err && (pkg.version != remote_version)) {
      console.log('');
      console.log(chalk.red.bold('>>>> In-memory ZM2 is out-of-date, do:\n>>>> $ zm2 update'));
      console.log('In memory ZM2 version:', chalk.blue.bold(remote_version));
      console.log('Local ZM2 version:', chalk.blue.bold(pkg.version));
      console.log('');
    }
  });
  commander.parse(process.argv);
}

function checkCompletion(){
  return tabtab.complete('zm2', function(err, data) {
    if(err || !data) return;
    if(/^--\w?/.test(data.last)) return tabtab.log(commander.options.map(function (data) {
      return data.long;
    }), data);
    if(/^-\w?/.test(data.last)) return tabtab.log(commander.options.map(function (data) {
      return data.short;
    }), data);
    // array containing commands after which process name should be listed
    var cmdProcess = ['stop', 'restart', 'scale', 'reload', 'delete', 'reset', 'pull', 'forward', 'backward', 'logs', 'describe', 'desc', 'show'];

    if (cmdProcess.indexOf(data.prev) > -1) {
      pm2.list(function(err, list){
        tabtab.log(list.map(function(el){ return el.name }), data);
        pm2.disconnect();
      });
    }
    else if (data.prev == 'zm2') {
      tabtab.log(commander.commands.map(function (data) {
        return data._name;
      }), data);
      pm2.disconnect();
    }
    else
      pm2.disconnect();
  });
};

var _arr = process.argv.indexOf('--') > -1 ? process.argv.slice(0, process.argv.indexOf('--')) : process.argv;

if (_arr.indexOf('log') > -1) {
  process.argv[_arr.indexOf('log')] = 'logs';
}

if (_arr.indexOf('startup') > -1 || _arr.indexOf('unstartup') > -1) {
  setTimeout(function() {
    commander.parse(process.argv);
  }, 100);
}
else {
  // HERE we instanciate the Client object
  pm2.connect(function() {
    debug('Now connected to daemon');
    if (process.argv.slice(2)[0] === 'completion') {
      checkCompletion();
      //Close client if completion related installation
      var third = process.argv.slice(3)[0];
      if ( third == null || third === 'install' || third === 'uninstall')
        pm2.disconnect();
    }
    else {
      beginCommandProcessing();
    }
  });
}

//
// Helper function to fail when unknown command arguments are passed
//
function failOnUnknown(fn) {
  return function(arg) {
    if (arguments.length > 1) {
      console.log(cst.PREFIX_MSG + '\nUnknown command argument: ' + arg);
      commander.outputHelp();
      process.exit(cst.ERROR_EXIT);
    }
    return fn.apply(this, arguments);
  };
}

/**
 * @todo to remove at some point once it's fixed in official commander.js
 * https://github.com/tj/commander.js/issues/475
 *
 * Patch Commander.js Variadic feature
 */
function patchCommanderArg(cmd) {
  var argsIndex;
  if ((argsIndex = commander.rawArgs.indexOf('--')) >= 0) {
    var optargs = commander.rawArgs.slice(argsIndex + 1);
    cmd = cmd.slice(0, cmd.indexOf(optargs[0]));
  }
  return cmd;
}

//
// Start command
//
commander.command('start [name|namespace|file|ecosystem|id...]')
  .option('--watch', 'Watch folder for changes')
  .option('--fresh', 'Rebuild Dockerfile')
  .option('--daemon', 'Run container in Daemon mode (debug purposes)')
  .description('start and daemonize an app')
  .action(function(cmd, opts) {

    if (cmd == "-") {
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', function (cmd) {
        process.stdin.pause();
        pm2._startJson(cmd, commander, 'restartProcessId', 'pipe');
      });
    }
    else {
      // Commander.js patch
      cmd = patchCommanderArg(cmd);
      if (cmd.length === 0) {
        cmd = [cst.APP_CONF_DEFAULT_FILE];
      }
      let acc = []
      forEachLimit(cmd, 1, function(script, next) {
        pm2.start(script, commander, (err, apps) => {
          acc = acc.concat(apps)
          next(err)
        });
      }, function(err, dt) {
        if (err && err.message &&
            (err.message.includes('Script not found') === true ||
             err.message.includes('NOT AVAILABLE IN PATH') === true)) {
          pm2.exitCli(1)
        }
        else
          pm2.speedList(err ? 1 : 0, acc);
      });
    }
  });

commander.command('trigger <id|proc_name|namespace|all> <action_name> [params]')
  .description('trigger process action')
  .action(function(pm_id, action_name, params) {
    pm2.trigger(pm_id, action_name, params);
  });

commander.command('deploy <file|environment>')
  .description('deploy your json')
  .action(function(cmd) {
    pm2.deploy(cmd, commander);
  });

commander.command('startOrRestart <json>')
  .description('start or restart JSON file')
  .action(function(file) {
    pm2._startJson(file, commander, 'restartProcessId');
  });

commander.command('startOrReload <json>')
  .description('start or gracefully reload JSON file')
  .action(function(file) {
    pm2._startJson(file, commander, 'reloadProcessId');
  });

commander.command('pid [app_name]')
  .description('return pid of [app_name] or all')
  .action(function(app) {
    pm2.getPID(app);
  });

commander.command('create')
  .description('return pid of [app_name] or all')
  .action(function() {
    pm2.boilerplate()
  });

commander.command('startOrGracefulReload <json>')
  .description('start or gracefully reload JSON file')
  .action(function(file) {
    pm2._startJson(file, commander, 'reloadProcessId');
  });

//
// Stop specific id
//
commander.command('stop <id|name|namespace|all|json|stdin...>')
  .option('--watch', 'Stop watching folder for changes')
  .description('stop a process')
  .action(function(param) {
    forEachLimit(param, 1, function(script, next) {
      pm2.stop(script, next);
    }, function(err) {
      pm2.speedList(err ? 1 : 0);
    });
  });

//
// Stop All processes
//
commander.command('restart <id|name|namespace|all|json|stdin...>')
  .option('--watch', 'Toggle watching folder for changes')
  .description('restart a process')
  .action(function(param) {
    // Commander.js patch
    param = patchCommanderArg(param);
    let acc = []
    forEachLimit(param, 1, function(script, next) {
      pm2.restart(script, commander, (err, apps) => {
        acc = acc.concat(apps)
        next(err)
      });
    }, function(err) {
      pm2.speedList(err ? 1 : 0, acc);
    });
  });

//
// Scale up/down a process in cluster mode
//
commander.command('scale <app_name> <number>')
  .description('scale up/down a process in cluster mode depending on total_number param')
  .action(function(app_name, number) {
    pm2.scale(app_name, number);
  });

//
// snapshot ZM2
//
commander.command('profile:mem [time]')
  .description('Sample ZM2 heap memory')
  .action(function(time) {
    pm2.profile('mem', time);
  });

//
// snapshot ZM2
//
commander.command('profile:cpu [time]')
  .description('Profile ZM2 cpu')
  .action(function(time) {
    pm2.profile('cpu', time);
  });

//
// Reload process(es)
//
commander.command('reload <id|name|namespace|all>')
  .description('reload processes (note that its for app using HTTP/HTTPS)')
  .action(function(pm2_id) {
    pm2.reload(pm2_id, commander);
  });

commander.command('id <name>')
  .description('get process id by name')
  .action(function(name) {
    pm2.getProcessIdByName(name);
  });

// Inspect a process
commander.command('inspect <name>')
  .description('inspect a process')
  .action(function(cmd) {
    pm2.inspect(cmd, commander);
  });

//
// Stop and delete a process by name from database
//
commander.command('delete <name|id|namespace|script|all|json|stdin...>')
  .alias('del')
  .description('stop and delete a process from zm2 process list')
  .action(function(name) {
    if (name == "-") {
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', function (param) {
        process.stdin.pause();
        pm2.delete(param, 'pipe');
      });
    } else
      forEachLimit(name, 1, function(script, next) {
        pm2.delete(script,'', next);
      }, function(err) {
        pm2.speedList(err ? 1 : 0);
      });
  });

//
// Ping — always alive in systemd mode
//
commander.command('ping')
  .description('ping zm2 — always returns OK in systemd mode')
  .action(function() {
    console.log(cst.PREFIX_MSG + 'ZM2 is running in systemd mode — always available');
    pm2.disconnect();
  });

/**
 * Module specifics
 */
commander.command('install <module|git:// url>')
  .alias('module:install')
  .option('--tarball', 'is local tarball')
  .option('--install', 'run yarn install before starting module')
  .option('--docker', 'is docker container')
  .option('--v1', 'install module in v1 manner (do not use it)')
  .option('--safe [time]', 'keep module backup, if new module fail = restore with previous')
  .description('install or update a module and run it forever')
  .action(function(plugin_name, opts) {
    require('util')._extend(commander, opts);
    pm2.install(plugin_name, commander);
  });

commander.command('module:update <module|git:// url>')
  .option('--tarball', 'is local tarball')
  .description('update a module and run it forever')
  .action(function(plugin_name, opts) {
    require('util')._extend(commander, opts);
    pm2.install(plugin_name, commander);
  });


commander.command('module:generate [app_name]')
  .description('Generate a sample module in current folder')
  .action(function(app_name) {
    pm2.generateModuleSample(app_name);
  });

commander.command('uninstall <module>')
  .alias('module:uninstall')
  .description('stop and uninstall a module')
  .action(function(plugin_name) {
    pm2.uninstall(plugin_name);
  });

commander.command('package [target]')
  .description('Check & Package TAR type module')
  .action(function(target) {
    pm2.package(target);
  });

commander.command('publish [folder]')
  .option('--npm', 'publish on npm')
  .alias('module:publish')
  .description('Publish the module you are currently on')
  .action(function(folder, opts) {
    pm2.publish(folder, opts);
  });

commander.command('set [key] [value]')
  .description('sets the specified config <key> <value>')
  .action(function(key, value) {
    pm2.set(key, value);
  });

commander.command('multiset <value>')
  .description('multiset eg "key1 val1 key2 val2')
  .action(function(str) {
    pm2.multiset(str);
  });

commander.command('get [key]')
  .description('get value for <key>')
  .action(function(key) {
    pm2.get(key);
  });

commander.command('conf [key] [value]')
  .description('get / set module config values')
  .action(function(key, value) {
    pm2.get()
  });

commander.command('config <key> [value]')
  .description('get / set module config values')
  .action(function(key, value) {
    pm2.conf(key, value);
  });

commander.command('unset <key>')
  .description('clears the specified config <key>')
  .action(function(key) {
    pm2.unset(key);
  });

commander.command('report')
  .description('give a full zm2 report for https://github.com/Unitech/pm2/issues')
  .action(function(key) {
    pm2.report();
  });

// PM2-plus commands removed — ZM2 uses systemd mode

//
// Save processes to file
//
commander.command('dump')
  .alias('save')
  .option('--force', 'force deletion of dump file, even if empty')
  .description('dump all processes for resurrecting them later')
  .action(failOnUnknown(function(opts) {
    pm2.dump(commander.force)
  }));

//
// Delete dump file
//
commander.command('cleardump')
  .description('Create empty dump file')
  .action(failOnUnknown(function() {
    pm2.clearDump();
  }));

// send/attach commands removed — no direct IPC in systemd mode

//
// Migrate from PM2 to ZM2 (systemd)
//
commander.command('migrate [app_name]')
  .description('migrate processes from PM2 to ZM2 systemd services')
  .option('--dry-run', 'show what would be migrated without making changes')
  .action(function(app_name, opts) {
    app_name = app_name || 'all';
    pm2.migrate(app_name, opts);
  });

//
// Resurrect
//
commander.command('resurrect')
  .description('resurrect previously dumped processes')
  .action(failOnUnknown(function() {
    console.log(cst.PREFIX_MSG + 'Resurrecting');
    pm2.resurrect();
  }));

//
// Set zm2 to startup
//
commander.command('unstartup [platform]')
  .description('disable the zm2 startup hook')
  .action(function(platform) {
    pm2.uninstallStartup(platform, commander);
  });

//
// Set zm2 to startup
//
commander.command('startup [platform]')
  .description('enable the zm2 startup hook')
  .action(function(platform) {
    pm2.startup(platform, commander);
  });

//
// Logrotate
//
commander.command('logrotate')
  .description('copy default logrotate configuration')
  .action(function(cmd) {
    pm2.logrotate(commander);
  });

//
// Sample generate
//

commander.command('ecosystem [mode]')
  .alias('init')
  .description('generate a process conf file. (mode = null or simple)')
  .action(function(mode) {
    pm2.generateSample(mode);
  });

commander.command('reset <name|id|all>')
  .description('reset counters for process')
  .action(function(proc_id) {
    pm2.reset(proc_id);
  });

commander.command('describe <name|id>')
  .description('describe all parameters of a process')
  .action(function(proc_id) {
    pm2.describe(proc_id);
  });

commander.command('desc <name|id>')
  .description('(alias) describe all parameters of a process')
  .action(function(proc_id) {
    pm2.describe(proc_id);
  });

commander.command('info <name|id>')
  .description('(alias) describe all parameters of a process')
  .action(function(proc_id) {
    pm2.describe(proc_id);
  });

commander.command('show <name|id>')
  .description('(alias) describe all parameters of a process')
  .action(function(proc_id) {
    pm2.describe(proc_id);
  });

commander.command('env <id>')
  .description('list all environment variables of a process id')
  .action(function(proc_id) {
    pm2.env(proc_id);
  });

//
// List command
//
commander
  .command('list')
  .alias('ls')
  .description('list all processes')
  .action(function() {
    pm2.list(commander)
  });

commander.command('l')
  .description('(alias) list all processes')
  .action(function() {
    pm2.list()
  });

commander.command('ps')
  .description('(alias) list all processes')
  .action(function() {
    pm2.list()
  });

commander.command('status')
  .description('(alias) list all processes')
  .action(function() {
    pm2.list()
  });


// List in raw json
commander.command('jlist')
  .description('list all processes in JSON format')
  .action(function() {
    pm2.jlist()
  });

commander.command('sysmonit')
  .description('start system monitoring daemon')
  .action(function() {
    pm2.launchSysMonitoring()
  })

// List in prettified Json
commander.command('prettylist')
  .description('print json in a prettified JSON')
  .action(failOnUnknown(function() {
    pm2.jlist(true);
  }));

//
// Dashboard command
//
commander.command('monit')
  .description('launch termcaps monitoring')
  .action(function() {
    pm2.dashboard();
  });

commander.command('imonit')
  .description('launch legacy termcaps monitoring')
  .action(function() {
    pm2.monit();
  });

commander.command('dashboard')
  .alias('dash')
  .description('launch dashboard with monitoring and logs')
  .action(function() {
    pm2.dashboard();
  });


//
// Flushing command
//

commander.command('flush [api]')
.description('flush logs')
.action(function(api) {
  pm2.flush(api);
});

/* old version
commander.command('flush')
  .description('flush logs')
  .action(failOnUnknown(function() {
    pm2.flush();
  }));
*/
//
// Reload all logs
//
commander.command('reloadLogs')
  .description('reload all logs')
  .action(function() {
    pm2.reloadLogs();
  });

//
// Log streaming
//
commander.command('logs [id|name|namespace]')
  .option('--json', 'json log output')
  .option('--format', 'formated log output')
  .option('--raw', 'raw output')
  .option('--err', 'only shows error output')
  .option('--out', 'only shows standard output')
  .option('--lines <n>', 'output the last N lines, instead of the last 15 by default')
  .option('--timestamp [format]', 'add timestamps (default format YYYY-MM-DD-HH:mm:ss)')
  .option('--nostream', 'print logs without launching the log stream')
  .option('--highlight [value]', 'highlights the given value')
  .description('stream logs file. Default stream all logs')
  .action(function(id, cmd) {
    var Logs = require('../API/Log.js');

    if (!id) id = 'all';

    var line = 15;
    var raw  = false;
    var exclusive = false;
    var timestamp = false;
    var highlight = false;

    if(!isNaN(parseInt(cmd.lines))) {
      line = parseInt(cmd.lines);
    }

    if (cmd.parent.rawArgs.indexOf('--raw') !== -1)
      raw = true;

    if (cmd.timestamp)
      timestamp = typeof cmd.timestamp === 'string' ? cmd.timestamp : 'YYYY-MM-DD-HH:mm:ss';

    if (cmd.highlight)
      highlight = typeof cmd.highlight === 'string' ? cmd.highlight : false;

    if (cmd.out === true)
      exclusive = 'out';

    if (cmd.err === true)
      exclusive = 'err';

    if (cmd.nostream === true)
      pm2.printLogs(id, line, raw, timestamp, exclusive);
    else if (cmd.json === true)
      Logs.jsonStream(pm2.Client, id);
    else if (cmd.format === true)
      Logs.formatStream(pm2.Client, id, false, 'YYYY-MM-DD-HH:mm:ssZZ', exclusive, highlight);
    else
      pm2.streamLogs(id, line, raw, timestamp, exclusive, highlight);
  });


//
// Kill
//
commander.command('kill')
  .description('stop all zm2 managed services')
  .action(failOnUnknown(function(arg) {
    pm2.killDaemon(function() {
      process.exit(cst.SUCCESS_EXIT);
    });
  }));

//
// Update repository for a given app
//

commander.command('pull <name> [commit_id]')
  .description('updates repository for a given app')
  .action(function(pm2_name, commit_id) {

    if (commit_id !== undefined) {
      pm2._pullCommitId({
        pm2_name: pm2_name,
        commit_id: commit_id
      });
    }
    else
      pm2.pullAndRestart(pm2_name);
  });

//
// Update repository to the next commit for a given app
//
commander.command('forward <name>')
  .description('updates repository to the next commit for a given app')
  .action(function(pm2_name) {
    pm2.forward(pm2_name);
  });

//
// Downgrade repository to the previous commit for a given app
//
commander.command('backward <name>')
  .description('downgrades repository to the previous commit for a given app')
  .action(function(pm2_name) {
    pm2.backward(pm2_name);
  });

//
// Perform a deep update of ZM2
//
commander.command('deepUpdate')
  .description('performs a deep update of ZM2')
  .action(function() {
    pm2.deepUpdate();
  });

//
// Launch a http server that expose a given path on given port
//
commander.command('serve [path] [port]')
  .alias('expose')
  .option('--port [port]', 'specify port to listen to')
  .option('--spa', 'always serving index.html on inexistant sub path')
  .option('--basic-auth-username [username]', 'set basic auth username')
  .option('--basic-auth-password [password]', 'set basic auth password')
  .option('--monitor [frontend-app]', 'frontend app monitoring (auto integrate snippet on html files)')
  .description('serve a directory over http via port')
  .action(function (path, port, cmd) {
    pm2.serve(path, port || cmd.port, cmd, commander);
  });

//
// HTTP API server as systemd service
//
commander.command('api [subcommand]')
  .option('--port [port]', 'specify port to listen to', parseInt)
  .option('--host [host]', 'specify host/IP to bind to')
  .description('manage ZM2 HTTP API service (subcommands: start, stop, restart, status, remove)')
  .action(function(subcommand, opts) {
    var validCmds = ['start', 'stop', 'restart', 'status', 'remove'];
    if (subcommand && validCmds.indexOf(subcommand) === -1) {
      Common.printError(cst.PREFIX_MSG_ERR + 'Unknown subcommand: ' + subcommand);
      Common.printError(cst.PREFIX_MSG_ERR + 'Usage: zm2 api [start|stop|restart|status|remove]');
      process.exit(cst.ERROR_EXIT);
    }

    pm2.api({
      subcommand: subcommand || 'start',
      port: opts.port || parseInt(process.env.ZM2_API_PORT, 10) || undefined,
      host: opts.host || process.env.ZM2_API_HOST || undefined
    });
  });

commander.command('autoinstall')
  .action(function() {
    pm2.autoinstall()
  })

commander.command('examples')
  .description('display zm2 usage examples')
  .action(() => {
    console.log(cst.PREFIX_MSG + chalk.gray('zm2 usage examples:\n'));
    displayExamples();
    process.exit(cst.SUCCESS_EXIT);
  })

//
// Catch all
//
commander.command('*')
  .action(function() {
    console.log(cst.PREFIX_MSG_ERR + chalk.bold('Command not found\n'));
    displayUsage();
    // Check if it does not forget to close fds from RPC
    process.exit(cst.ERROR_EXIT);
  });

//
// Display help if 0 arguments passed to zm2
//
if (process.argv.length == 2) {
  commander.parse(process.argv);
  displayUsage();
  // Check if it does not forget to close fds from RPC
  process.exit(cst.ERROR_EXIT);
}
