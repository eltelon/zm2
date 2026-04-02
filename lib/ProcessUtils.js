'use strict'

module.exports = {
  isESModule(exec_path) {
    var fs = require('fs')
    var path = require('path')
    var semver = require('semver')
    var data

    var findPackageJson = function(directory) {
      var file = path.join(directory, 'package.json')
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        return file;
      }
      var parent = path.resolve(directory, '..')
      if (parent === directory) {
        return null;
      }
      return findPackageJson(parent)
    }

    if (semver.satisfies(process.version, '< 13.3.0'))
      return false

    if (path.extname(exec_path) === '.mjs')
      return true

    try {
      data = JSON.parse(fs.readFileSync(findPackageJson(path.dirname(exec_path))))
      if (data.type === 'module')
        return true
      else
        return false
    } catch(e) {
    }
  }
}
