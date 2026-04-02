
var cst    = require('../../constants.js');
var Common = require('../Common.js');

var printError = Common.printError;

var VIZION_MSG = 'Vizion (git versioning) is not supported in ZM2. Use git directly.';

module.exports = function(CLI) {

  CLI.prototype._pull = function(opts, cb) {
    printError(VIZION_MSG);
    return cb ? cb({msg: VIZION_MSG}) : this.exitCli(cst.ERROR_EXIT);
  };

  CLI.prototype.pullCommitId = function(process_name, commit_id, cb) {
    printError(VIZION_MSG);
    return cb ? cb({msg: VIZION_MSG}) : this.exitCli(cst.ERROR_EXIT);
  };

  CLI.prototype.backward = function(process_name, cb) {
    printError(VIZION_MSG);
    return cb ? cb({msg: VIZION_MSG}) : this.exitCli(cst.ERROR_EXIT);
  };

  CLI.prototype.forward = function(process_name, cb) {
    printError(VIZION_MSG);
    return cb ? cb({msg: VIZION_MSG}) : this.exitCli(cst.ERROR_EXIT);
  };

  CLI.prototype.pullAndRestart = function(process_name, cb) {
    this._pull({process_name: process_name, action: 'reload'}, cb);
  };

  CLI.prototype.pullAndReload = function(process_name, cb) {
    this._pull({process_name: process_name, action: 'reload'}, cb);
  };

  CLI.prototype._pullCommitId = function(opts, cb) {
    this.pullCommitId(opts.pm2_name, opts.commit_id, cb);
  };

}
