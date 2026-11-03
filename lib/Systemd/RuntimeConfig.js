/**
 * Copyright 2024 the ZM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

'use strict';

var fs = require('fs');
var path = require('path');

var DEFAULT_UNIT_DIR = '/etc/systemd/system';
var DEFAULT_ENV_DIR = '/etc/zm2/env';
var DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
var SERVICE_NAME_RE = /^zm2-[A-Za-z0-9_-]+$/;

var tempCounter = 0;

function propertyText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(deepClone);

  var clone = {};
  Object.keys(value).forEach(function(key) {
    clone[key] = deepClone(value[key]);
  });
  return clone;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  if (Object.isFrozen(value)) return value;

  Object.freeze(value);
  Object.keys(value).forEach(function(key) {
    deepFreeze(value[key]);
  });
  return value;
}

function resolveServiceName(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Invalid service entry');
  }

  var serviceName = entry.serviceName;
  if (!serviceName && typeof entry.name === 'string') {
    serviceName = 'zm2-' + entry.name;
  }

  if (typeof serviceName !== 'string' || !SERVICE_NAME_RE.test(serviceName)) {
    throw new Error('Unsafe or invalid service name: ' + serviceName);
  }
  return serviceName;
}

function resolveInstanceCount(entry) {
  var raw = entry.instances === undefined || entry.instances === null ? 1 : entry.instances;
  if (typeof raw === 'string' && !/^\d+$/.test(raw)) {
    throw new Error('Unsafe or invalid instance count: ' + raw);
  }

  var instances = typeof raw === 'number' ? raw : parseInt(raw, 10);
  if (!Number.isInteger(instances) || instances < 1 || instances > 1000) {
    throw new Error('Unsafe or invalid instance count: ' + raw);
  }
  return instances;
}

function isWhitespace(character) {
  return character === ' ' || character === '\t' ||
    character === '\r' || character === '\n' ||
    character === '\f' || character === '\v';
}

function decodeEscape(character) {
  switch (character) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case 's': return ' ';
    default: return character;
  }
}

/**
 * Parse one systemd word, returning its decoded value and raw span.
 * Only the syntax needed to locate the first ExecStart token is supported.
 */
function parseWord(text, start) {
  var index = start;
  var value = '';
  var sawCharacter = false;

  while (index < text.length) {
    var character = text.charAt(index);
    if (isWhitespace(character)) break;
    sawCharacter = true;

    if (character === '\\') {
      index++;
      if (index >= text.length) {
        throw new Error('Unsupported dangling backslash in ExecStart');
      }
      value += decodeEscape(text.charAt(index));
      index++;
      continue;
    }

    if (character === '"') {
      index++;
      var closedDouble = false;
      while (index < text.length) {
        var doubleCharacter = text.charAt(index);
        if (doubleCharacter === '\\') {
          index++;
          if (index >= text.length) {
            throw new Error('Unsupported dangling escape in ExecStart');
          }
          value += decodeEscape(text.charAt(index));
          index++;
          continue;
        }
        if (doubleCharacter === '"') {
          closedDouble = true;
          index++;
          break;
        }
        value += doubleCharacter;
        index++;
      }
      if (!closedDouble) {
        throw new Error('Unsupported unterminated double quote in ExecStart');
      }
      continue;
    }

    if (character === "'") {
      index++;
      var closedSingle = false;
      while (index < text.length) {
        var singleCharacter = text.charAt(index);
        if (singleCharacter === "'") {
          closedSingle = true;
          index++;
          break;
        }
        value += singleCharacter;
        index++;
      }
      if (!closedSingle) {
        throw new Error('Unsupported unterminated single quote in ExecStart');
      }
      continue;
    }

    value += character;
    index++;
  }

  if (!sawCharacter) {
    throw new Error('Unsupported empty ExecStart executable');
  }

  return { value: value, start: start, end: index };
}

function hasLineContinuation(line) {
  var count = 0;
  for (var index = line.length - 1; index >= 0 && line.charAt(index) === '\\'; index--) {
    count++;
  }
  return count % 2 === 1;
}

function splitLines(text) {
  var lines = [];
  var start = 0;

  for (var index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      lines.push({ start: start, end: index, text: text.slice(start, index) });
      start = index + 1;
    }
  }
  lines.push({ start: start, end: text.length, text: text.slice(start) });
  return lines;
}

function decodeExecStartExecutable(value) {
  var decoded = '';

  for (var index = 0; index < value.length; index++) {
    var character = value.charAt(index);
    if (character !== '%') {
      decoded += character;
      continue;
    }

    if (index + 1 < value.length && value.charAt(index + 1) === '%') {
      decoded += '%';
      index++;
      continue;
    }

    throw new Error('Unsupported ExecStart specifier: %' + (value.charAt(index + 1) || ''));
  }

  return decoded;
}

function parseExecStartValue(value) {
  var leading = 0;
  while (leading < value.length && isWhitespace(value.charAt(leading))) leading++;

  if (leading >= value.length) {
    throw new Error('Unsupported empty ExecStart directive');
  }

  if ('@-:+!'.indexOf(value.charAt(leading)) !== -1) {
    throw new Error('Unsupported ExecStart prefix: ' + value.charAt(leading));
  }

  var word = parseWord(value, leading);
  if (!word.value) {
    throw new Error('Unsupported empty ExecStart executable');
  }

  return {
    executable: decodeExecStartExecutable(word.value),
    tokenStart: word.start,
    tokenEnd: word.end
  };
}

/**
 * Parse the unit source itself. The source file is authoritative; systemctl
 * show output is only used to validate the effective configuration.
 */
function parseUnitSource(text, envPath, isTemplate) {
  var lines = splitLines(text);
  var section = null;
  var seenService = false;
  var execStart = null;
  var environmentFile = null;
  var environmentValues = [];

  lines.forEach(function(line) {
    var body = line.text.replace(/\r$/, '');
    var trimmed = body.trim();

    if (!trimmed) return;
    if (trimmed.charAt(0) === '#' || trimmed.charAt(0) === ';') return;

    if (trimmed.charAt(0) === '[') {
      if (trimmed.charAt(trimmed.length - 1) !== ']') {
        throw new Error('Unsupported malformed unit section: ' + trimmed);
      }
      section = trimmed.slice(1, -1).trim();
      if (!section) {
        throw new Error('Unsupported empty unit section');
      }
      if (section === 'Service') seenService = true;
      return;
    }

    if (hasLineContinuation(body)) {
      throw new Error('Unsupported unit line continuation');
    }

    var equals = body.indexOf('=');
    if (equals === -1) {
      throw new Error('Unsupported unit line without assignment: ' + body);
    }

    var key = body.slice(0, equals).trim();
    var value = body.slice(equals + 1);

    if (!section) {
      throw new Error('Unsupported unit directive outside a section: ' + key);
    }

    if (key === 'ExecStart') {
      if (section !== 'Service') {
        throw new Error('ExecStart outside the [Service] section is not supported');
      }
      if (execStart) {
        throw new Error('Multiple ExecStart directives are not supported');
      }

      var parsedValue = parseExecStartValue(value);
      var valueStart = line.start + equals + 1;
      execStart = {
        executable: parsedValue.executable,
        tokenStart: valueStart + parsedValue.tokenStart,
        tokenEnd: valueStart + parsedValue.tokenEnd
      };
      return;
    }

    if (key === 'EnvironmentFile') {
      if (section !== 'Service') {
        throw new Error('EnvironmentFile outside the [Service] section is not supported');
      }
      if (environmentFile !== null) {
        throw new Error('Multiple EnvironmentFile directives are not supported');
      }
      environmentFile = value.trim();
      return;
    }

    if (key === 'Environment') {
      if (section !== 'Service') {
        throw new Error('Environment outside the [Service] section is not supported');
      }
      environmentValues.push(value.trim());
      return;
    }

    if (key === 'PassEnvironment' || key === 'UnsetEnvironment') {
      if (section !== 'Service') {
        throw new Error(key + ' outside the [Service] section is not supported');
      }
      throw new Error('Unsupported ' + key + ' directive');
    }
  });

  if (!seenService) {
    throw new Error('Unsupported unit without a [Service] section');
  }
  if (!execStart) {
    throw new Error('Unsupported unit without ExecStart');
  }

  if (environmentFile === null) {
    throw new Error('Unsupported unit without a managed EnvironmentFile');
  }

  var envFileValue = environmentFile;
  if (envFileValue.charAt(0) === '-') envFileValue = envFileValue.slice(1);
  if (envFileValue !== envPath) {
    throw new Error('Unsupported EnvironmentFile: expected only ' + envPath + ', got ' + environmentFile);
  }

  var instanceVar = null;

  if (isTemplate) {
    if (environmentValues.length !== 1) {
      throw new Error('Unsupported template Environment directives');
    }

    var templateEnvironment = /^([A-Za-z_][A-Za-z0-9_]*)=%i$/.exec(environmentValues[0]);
    if (!templateEnvironment) {
      throw new Error('Unsupported template Environment directives');
    }
    instanceVar = templateEnvironment[1];
  } else if (environmentValues.length !== 0) {
    throw new Error('Unsupported Environment= override in unit');
  }

  return { execStart: execStart, instanceVar: instanceVar };
}

function parseEffectiveExecutable(value, unitName) {
  var text = propertyText(value);
  if (!text) {
    throw new Error('ExecStart is empty for ' + unitName);
  }

  text = text.replace(/^ExecStart\s*=\s*/, '');

  var paths = [];
  var bracedPath = /\{\s*path=([^;]*?)\s*;/g;
  var match;
  while ((match = bracedPath.exec(text)) !== null) {
    paths.push(match[1].trim());
  }

  if (paths.length > 1) {
    throw new Error('Multiple ExecStart commands are not supported for ' + unitName);
  }

  var executable;
  if (paths.length === 1) {
    executable = paths[0];
    if (!executable) {
      throw new Error('ExecStart path is empty for ' + unitName);
    }
    var quoted = (executable.charAt(0) === '"' && executable.charAt(executable.length - 1) === '"') ||
      (executable.charAt(0) === "'" && executable.charAt(executable.length - 1) === "'");
    if (quoted) {
      var word = parseWord(executable, 0);
      if (word.end !== executable.length) {
        throw new Error('Unsupported quoted ExecStart path for ' + unitName);
      }
      executable = word.value;
    }
  } else {
    if (/\}\s*\{/.test(text)) {
      throw new Error('Multiple ExecStart commands are not supported for ' + unitName);
    }
    var start = 0;
    while (start < text.length && isWhitespace(text.charAt(start))) start++;
    executable = parseWord(text, start).value;
  }

  if (!executable || executable.charAt(0) !== '/') {
    throw new Error('ExecStart executable is not absolute for ' + unitName + ': ' + executable);
  }
  return executable;
}

function validateEnvironmentFiles(value, envPath, unitName) {
  var text = propertyText(value);
  if (!text) {
    throw new Error('Unit ' + unitName + ' does not reference the managed EnvironmentFile ' + envPath);
  }
  if (text.indexOf('\n') !== -1) {
    throw new Error('Multiple EnvironmentFiles are not supported for ' + unitName);
  }

  text = text.replace(/^EnvironmentFiles\s*=\s*/, '');
  var cleaned = text.replace(/\s+\(ignore_errors=(?:yes|no)\)/g, '').trim();
  var candidates = [cleaned];

  if (cleaned.charAt(0) === '-') candidates.push(cleaned.slice(1));

  if (cleaned.length >= 2) {
    var first = cleaned.charAt(0);
    var last = cleaned.charAt(cleaned.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      var unquoted = cleaned.slice(1, -1);
      candidates.push(unquoted);
      if (unquoted.charAt(0) === '-') candidates.push(unquoted.slice(1));
    }
  }

  if (candidates.indexOf(envPath) === -1) {
    throw new Error(
      'Unsupported EnvironmentFiles for ' + unitName +
      ': expected only ' + envPath + ', got ' + text
    );
  }
}

function validateEnvironmentProperty(value, isTemplate, instance, instanceVar, unitName) {
  var text = propertyText(value);

  if (!text) {
    if (isTemplate) {
      throw new Error('Template instance ' + unitName + ' lacks ' + instanceVar);
    }
    return;
  }

  if (!isTemplate) {
    throw new Error('Unsupported Environment= override for ' + unitName + ': ' + text);
  }

  if (text !== instanceVar + '=' + instance) {
    throw new Error('Unsupported Environment= override for ' + unitName + ': ' + text);
  }
}

function validateNodeExecutable(executable, label) {
  if (typeof executable !== 'string' || !executable) {
    throw new Error(label + ' is empty');
  }
  if (executable.charAt(0) !== '/') {
    throw new Error(label + ' must be an absolute path: ' + executable);
  }
  if (/[\0\n\r]/.test(executable)) {
    throw new Error(label + ' contains unsupported control characters');
  }
  if (executable.indexOf('$') !== -1) {
    throw new Error(label + ' contains unsupported $ expansion');
  }
  if (!/^node(?:js)?$/.test(path.basename(executable))) {
    throw new Error(label + ' is not a Node executable: ' + executable);
  }
}

function encodeExecutable(executable) {
  validateNodeExecutable(executable, 'Runtime executable');

  if (!/[\s"'\\%;]/.test(executable)) {
    return executable;
  }

  var escaped = executable
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%');
  return '"' + escaped + '"';
}

function decodeEnvDoubleQuotedEntry(raw) {
  var decoded = '';

  for (var index = 0; index < raw.length; index++) {
    var character = raw.charAt(index);
    if (character !== '\\') {
      decoded += character;
      continue;
    }

    if (index + 1 >= raw.length) {
      throw new Error('Unsupported dangling backslash in double-quoted PATH value');
    }

    var next = raw.charAt(index + 1);
    if (next === '\\' || next === '"' || next === '$' || next === '`') {
      decoded += next;
    } else {
      decoded += '\\' + next;
    }
    index++;
  }

  return decoded;
}

function decodeEnvSingleQuotedEntry(raw) {
  if (raw.indexOf("'") !== -1) {
    throw new Error('Unsupported single quote in single-quoted PATH value');
  }
  return raw;
}

function decodeEnvPlainEntry(raw) {
  if (/[\\"']/.test(raw)) {
    throw new Error('Unsupported backslash or quote in unquoted PATH value');
  }
  return raw;
}

function decodePathEntries(rawEntries, style) {
  return rawEntries.map(function(rawEntry) {
    var decoded;
    if (style === 'double') {
      decoded = decodeEnvDoubleQuotedEntry(rawEntry);
    } else if (style === 'single') {
      decoded = decodeEnvSingleQuotedEntry(rawEntry);
    } else {
      decoded = decodeEnvPlainEntry(rawEntry);
    }

    if (/[\0\n\r]/.test(decoded)) {
      throw new Error('Unsupported control character in PATH value');
    }
    return decoded;
  });
}

function quoteStyle(raw) {
  if (raw.length >= 2 && raw.charAt(0) === '"' && raw.charAt(raw.length - 1) === '"') {
    return 'double';
  }
  if (raw.length >= 2 && raw.charAt(0) === "'" && raw.charAt(raw.length - 1) === "'") {
    return 'single';
  }
  return 'plain';
}

function encodeEnvValue(value, style) {
  if (style === 'single' && value.indexOf("'") === -1) {
    return "'" + value + "'";
  }

  if (style === 'double' || style === 'single' || /[\s"'\\]/.test(value)) {
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  return value;
}

function samePathEntry(entry, binDir) {
  var normalizedEntry = entry.replace(/\/+$/, '');
  var normalizedBinDir = binDir.replace(/\/+$/, '');
  return normalizedEntry === normalizedBinDir;
}

function updatePathValue(valueRaw, binDir, basePath) {
  var style = quoteStyle(valueRaw);

  if (style === 'plain' && valueRaw !== valueRaw.trim()) {
    throw new Error('Unsupported whitespace around PATH value');
  }

  var inner = style === 'plain' ? valueRaw : valueRaw.slice(1, -1);
  var rawEntries = inner === '' ? [''] : inner.split(':');
  var decodedEntries = decodePathEntries(rawEntries, style);
  var currentValue = decodedEntries.join(':');

  if (currentValue === '') {
    return encodeEnvValue(binDir + ':' + basePath, style === 'plain' ? 'plain' : style);
  }

  var targetIndices = [];
  decodedEntries.forEach(function(entry, index) {
    if (samePathEntry(entry, binDir)) targetIndices.push(index);
  });

  if (targetIndices.length === 1 && targetIndices[0] === 0) {
    return valueRaw;
  }

  var rawBinDir;
  var reencode = false;

  if (style === 'double') {
    rawBinDir = binDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  } else if (style === 'single') {
    if (binDir.indexOf("'") !== -1) {
      reencode = true;
    } else {
      rawBinDir = binDir;
    }
  } else if (/[\s"'\\]/.test(binDir)) {
    reencode = true;
  } else {
    rawBinDir = binDir;
  }

  if (reencode) {
    var keptDecoded = decodedEntries.filter(function(entry, index) {
      return targetIndices.indexOf(index) === -1;
    });
    return encodeEnvValue([binDir].concat(keptDecoded).join(':'), 'double');
  }

  var keptRaw = rawEntries.filter(function(entry, index) {
    return targetIndices.indexOf(index) === -1;
  });
  var newInner = [rawBinDir].concat(keptRaw).join(':');

  if (style === 'double') return '"' + newInner + '"';
  if (style === 'single') return "'" + newInner + "'";
  return newInner;
}

function buildEnvContent(content, exists, binDir, basePath) {
  if (!exists || content === null) {
    return 'PATH=' + encodeEnvValue(binDir + ':' + basePath, 'plain') + '\n';
  }

  var lines = splitLines(content);
  var pathLines = [];

  lines.forEach(function(line) {
    var body = line.text.replace(/\r$/, '');
    var trimmed = body.trim();

    if (!trimmed) return;
    if (trimmed.charAt(0) === '#' || trimmed.charAt(0) === ';') return;
    if (hasLineContinuation(body)) {
      throw new Error('Unsupported environment file line continuation');
    }

    var equals = body.indexOf('=');
    if (equals === -1) {
      throw new Error('Unsupported environment file line without assignment: ' + body);
    }

    var rawKey = body.slice(0, equals);
    var key = rawKey.trim();

    if (key.indexOf('export ') === 0) {
      throw new Error('Unsupported export in environment file');
    }
    if (key !== 'PATH') return;

    if (rawKey !== key) {
      throw new Error('Unsupported whitespace around PATH assignment');
    }

    pathLines.push({
      line: line,
      body: body,
      equals: equals,
      valueRaw: body.slice(equals + 1)
    });
  });

  var newline = content.indexOf('\r\n') !== -1 ? '\r\n' : '\n';

  if (pathLines.length === 0) {
    var separator = '';
    if (content.length > 0 && content.charAt(content.length - 1) !== '\n') {
      separator = newline;
    }
    return content + separator +
      'PATH=' + encodeEnvValue(binDir + ':' + basePath, 'plain') + newline;
  }

  var pathLine = pathLines[pathLines.length - 1];
  var newValueRaw = updatePathValue(pathLine.valueRaw, binDir, basePath);
  if (newValueRaw === pathLine.valueRaw) {
    return content;
  }

  var ending = pathLine.line.text.slice(pathLine.body.length);
  var replacement = pathLine.body.slice(0, pathLine.equals + 1) + newValueRaw + ending;
  return content.slice(0, pathLine.line.start) +
    replacement +
    content.slice(pathLine.line.start + pathLine.line.text.length);
}

function inspectFile(fsImpl, filePath, required, label) {
  var stat;
  try {
    stat = fsImpl.lstatSync(filePath);
  } catch (error) {
    if (!required && error.code === 'ENOENT') {
      return {
        path: filePath,
        exists: false,
        content: null,
        mode: null,
        uid: null,
        gid: null
      };
    }
    throw new Error('Cannot inspect ' + label + ' file ' + filePath + ': ' + error.message);
  }

  if (stat.isSymbolicLink()) {
    throw new Error('Refusing to modify symlinked ' + label + ' file: ' + filePath);
  }
  if (!stat.isFile()) {
    throw new Error('Refusing to modify non-regular ' + label + ' file: ' + filePath);
  }

  var raw = fsImpl.readFileSync(filePath);
  if (!Buffer.isBuffer(raw)) raw = Buffer.from(String(raw), 'utf8');
  var text = raw.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(raw)) {
    throw new Error('Unsupported non-UTF-8 ' + label + ' file: ' + filePath);
  }

  return {
    path: filePath,
    exists: true,
    content: text,
    mode: stat.mode & 0o7777,
    uid: stat.uid,
    gid: stat.gid
  };
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Invalid runtime snapshot');
  }
  if (typeof snapshot.serviceName !== 'string' || !snapshot.serviceName) {
    throw new Error('Invalid runtime snapshot service name');
  }
  if (typeof snapshot.isTemplate !== 'boolean') {
    throw new Error('Invalid runtime snapshot template flag');
  }
  if (!Number.isInteger(snapshot.instances) || snapshot.instances < 1) {
    throw new Error('Invalid runtime snapshot instance count');
  }
  if (!snapshot.unit || !snapshot.env) {
    throw new Error('Invalid runtime snapshot files');
  }
  if (!snapshot.unit.exists || typeof snapshot.unit.path !== 'string' ||
      typeof snapshot.unit.content !== 'string') {
    throw new Error('Invalid runtime snapshot unit file');
  }
  if (typeof snapshot.env.path !== 'string' || typeof snapshot.env.exists !== 'boolean') {
    throw new Error('Invalid runtime snapshot environment file');
  }
  if (snapshot.env.exists && typeof snapshot.env.content !== 'string') {
    throw new Error('Invalid runtime snapshot environment content');
  }
  if (!snapshot.env.exists && snapshot.env.content !== null) {
    throw new Error('Invalid runtime snapshot absent environment content');
  }
  if (typeof snapshot.executable !== 'string' || !snapshot.executable) {
    throw new Error('Invalid runtime snapshot executable');
  }
}

function writeAtomic(fsImpl, fileInfo, content, mode, uid, gid) {
  var directory = path.dirname(fileInfo.path);

  if (typeof fsImpl.mkdirSync === 'function') {
    try {
      fsImpl.mkdirSync(directory, { recursive: true });
    } catch (error) {
      throw new Error('Failed to create directory ' + directory + ': ' + error.message);
    }
  }

  var tempPath = path.join(
    directory,
    '.' + path.basename(fileInfo.path) + '.zm2-' + process.pid + '-' + (++tempCounter)
  );
  var created = false;

  try {
    fsImpl.writeFileSync(tempPath, content, {
      encoding: 'utf8',
      mode: mode,
      flag: 'wx'
    });
    created = true;

    if (typeof uid === 'number' && typeof gid === 'number' &&
        typeof fsImpl.chownSync === 'function') {
      fsImpl.chownSync(tempPath, uid, gid);
    }
    if (typeof fsImpl.chmodSync === 'function') {
      fsImpl.chmodSync(tempPath, mode);
    }

    fsImpl.renameSync(tempPath, fileInfo.path);
  } catch (error) {
    if (created) {
      try {
        fsImpl.unlinkSync(tempPath);
      } catch (cleanupError) {
        /* best-effort temp cleanup */
      }
    }
    throw new Error('Failed to write ' + fileInfo.path + ': ' + error.message);
  }
}

function restoreFile(fsImpl, fileInfo, content) {
  if (fileInfo.exists) {
    writeAtomic(fsImpl, fileInfo, content, fileInfo.mode, fileInfo.uid, fileInfo.gid);
    return;
  }

  try {
    fsImpl.unlinkSync(fileInfo.path);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error('Failed to remove ' + fileInfo.path + ': ' + error.message);
    }
  }
}

/**
 * RuntimeConfig - Inspect and rewrite only the Node executable and PATH of
 * ZM2-managed systemd units.
 *
 * @param {Object} options - { fs, systemd, unitDir, envDir, dirs, basePath }
 */
function RuntimeConfig(options) {
  options = options || {};

  this.fs = options.fs || fs;
  this.systemd = options.systemd || require('../Systemd');
  this.unitDir = options.unitDir ||
    (options.dirs && (options.dirs.unitDir || options.dirs.unit)) ||
    DEFAULT_UNIT_DIR;
  this.envDir = options.envDir ||
    (options.dirs && (options.dirs.envDir || options.dirs.env)) ||
    DEFAULT_ENV_DIR;
  this.basePath = options.basePath || DEFAULT_PATH;

  if (typeof this.unitDir !== 'string' || !this.unitDir) {
    throw new Error('Invalid systemd unit directory');
  }
  if (typeof this.envDir !== 'string' || !this.envDir) {
    throw new Error('Invalid ZM2 environment directory');
  }
  if (typeof this.basePath !== 'string' || !this.basePath) {
    throw new Error('Invalid default PATH');
  }
}

/**
 * Inspect a registered application without modifying anything.
 *
 * @param {Object} entry - StateStore entry with serviceName and instances
 * @returns {Object} Frozen snapshot
 */
RuntimeConfig.prototype.inspect = function(entry) {
  var serviceName = resolveServiceName(entry);
  var instances = resolveInstanceCount(entry);
  var isTemplate = instances > 1;
  var unitPath = path.join(
    this.unitDir,
    serviceName + (isTemplate ? '@.service' : '.service')
  );
  var envPath = path.join(this.envDir, serviceName + '.env');

  var unit = inspectFile(this.fs, unitPath, true, 'unit');
  var env = inspectFile(this.fs, envPath, false, 'environment');
  var source = parseUnitSource(unit.content, envPath, isTemplate);

  validateNodeExecutable(source.execStart.executable, 'Existing ExecStart executable');

  var firstProperties = null;

  for (var instance = 0; instance < instances; instance++) {
    var instanceName = isTemplate ? serviceName + '@' + instance : serviceName;
    var properties;

    try {
      properties = this.systemd.getRuntimeProperties(instanceName);
    } catch (error) {
      throw new Error('Cannot read effective systemd configuration for ' + instanceName + ': ' + error.message);
    }

    if (!properties || typeof properties !== 'object') {
      throw new Error('Invalid effective systemd configuration for ' + instanceName);
    }

    var fragmentPath = propertyText(properties.FragmentPath);
    if (fragmentPath !== unitPath) {
      throw new Error(
        'Unexpected FragmentPath for ' + instanceName +
        ': expected ' + unitPath + ', got ' + (fragmentPath || '(empty)')
      );
    }

    var dropIns = propertyText(properties.DropInPaths);
    if (dropIns) {
      throw new Error('Drop-in overrides are not supported for ' + instanceName + ': ' + dropIns);
    }

    var effectiveExecutable = parseEffectiveExecutable(properties.ExecStart, instanceName);
    if (effectiveExecutable !== source.execStart.executable) {
      throw new Error(
        'Effective ExecStart does not match the unit source for ' + instanceName
      );
    }

    validateEnvironmentFiles(properties.EnvironmentFiles, envPath, instanceName);
    validateEnvironmentProperty(
      properties.Environment, isTemplate, instance, source.instanceVar, instanceName
    );

    if (firstProperties) {
      if (propertyText(properties.User) !== propertyText(firstProperties.User) ||
          propertyText(properties.Group) !== propertyText(firstProperties.Group)) {
        throw new Error(
          'Template instances do not share the same User/Group configuration: ' + instanceName
        );
      }
    } else {
      firstProperties = properties;
    }
  }

  var snapshot = {
    serviceName: serviceName,
    instances: instances,
    isTemplate: isTemplate,
    unit: unit,
    env: env,
    metadata: deepClone(entry),
    executable: source.execStart.executable,
    previousExecutable: source.execStart.executable,
    instanceVar: source.instanceVar
  };

  return deepFreeze(snapshot);
};

/**
 * Build the new unit and environment contents. This method is pure: it never
 * reads or writes files and never mutates the snapshot.
 *
 * @param {Object} snapshot - Result of inspect()
 * @param {Object} runtime - { version, executable, binDir }
 * @returns {Object} { changed, unitContent, envContent }
 */
RuntimeConfig.prototype.plan = function(snapshot, runtime) {
  validateSnapshot(snapshot);

  if (!runtime || typeof runtime !== 'object') {
    throw new Error('Invalid runtime configuration');
  }

  var executable = runtime.executable;
  var binDir = runtime.binDir;

  validateNodeExecutable(executable, 'Runtime executable');

  if (typeof binDir !== 'string' || binDir.charAt(0) !== '/') {
    throw new Error('Runtime binDir must be an absolute path: ' + binDir);
  }
  if (/[\0\n\r]/.test(binDir)) {
    throw new Error('Runtime binDir contains unsupported control characters');
  }
  if (binDir.indexOf('$') !== -1) {
    throw new Error('Runtime binDir contains unsupported $ expansion');
  }
  if (binDir.indexOf(':') !== -1) {
    throw new Error('Runtime binDir must not contain a colon');
  }

  var source = parseUnitSource(snapshot.unit.content, snapshot.env.path, snapshot.isTemplate);
  if (source.execStart.executable !== snapshot.executable) {
    throw new Error('Snapshot unit content does not match its recorded executable');
  }

  var encodedExecutable = encodeExecutable(executable);
  var unitContent = snapshot.unit.content.slice(0, source.execStart.tokenStart) +
    encodedExecutable +
    snapshot.unit.content.slice(source.execStart.tokenEnd);

  var envContent = buildEnvContent(
    snapshot.env.content,
    snapshot.env.exists,
    binDir,
    this.basePath
  );

  return {
    changed: unitContent !== snapshot.unit.content || envContent !== snapshot.env.content,
    unitContent: unitContent,
    envContent: envContent
  };
};

/**
 * Apply a plan atomically per file. If a later write fails, the caller must
 * call restore(snapshot).
 *
 * @param {Object} snapshot
 * @param {Object} plan
 */
RuntimeConfig.prototype.apply = function(snapshot, plan) {
  validateSnapshot(snapshot);

  if (!plan || typeof plan !== 'object') {
    throw new Error('Invalid runtime plan');
  }
  if (!plan.changed) return;
  if (typeof plan.unitContent !== 'string' || typeof plan.envContent !== 'string') {
    throw new Error('Invalid runtime plan contents');
  }

  var unitChanged = plan.unitContent !== snapshot.unit.content;
  var envChanged = !snapshot.env.exists || plan.envContent !== snapshot.env.content;

  if (unitChanged) {
    writeAtomic(
      this.fs,
      snapshot.unit,
      plan.unitContent,
      snapshot.unit.mode,
      snapshot.unit.uid,
      snapshot.unit.gid
    );
  }

  if (envChanged) {
    writeAtomic(
      this.fs,
      snapshot.env,
      plan.envContent,
      snapshot.env.exists ? snapshot.env.mode : 0o644,
      snapshot.env.exists ? snapshot.env.uid : snapshot.unit.uid,
      snapshot.env.exists ? snapshot.env.gid : snapshot.unit.gid
    );
  }
};

/**
 * Restore every original file. All restorations are attempted even if one
 * fails, and all errors are aggregated. This method does not reload systemd.
 *
 * @param {Object} snapshot
 */
RuntimeConfig.prototype.restore = function(snapshot) {
  validateSnapshot(snapshot);

  var errors = [];

  try {
    restoreFile(this.fs, snapshot.unit, snapshot.unit.content);
  } catch (error) {
    errors.push('unit ' + snapshot.unit.path + ': ' + error.message);
  }

  try {
    restoreFile(this.fs, snapshot.env, snapshot.env.content);
  } catch (error) {
    errors.push('env ' + snapshot.env.path + ': ' + error.message);
  }

  if (errors.length) {
    throw new Error(
      'Failed to restore runtime configuration for ' + snapshot.serviceName +
      ': ' + errors.join('; ')
    );
  }
};

module.exports = RuntimeConfig;
