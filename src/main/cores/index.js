'use strict';
// Core registry + executable resolution (plan.md §3.2). Pure of Electron; all I/O is injectable.
const fs = require('fs');
const os = require('os');
const nodePath = require('path');

const mgba = require('./mgba');
const pyboy = require('./pyboy');
const project64 = require('./project64');
const azahar = require('./azahar');
const ryujinx = require('./ryujinx');
const rpcs3 = require('./rpcs3');

const CORES = Object.freeze([mgba, pyboy, project64, azahar, ryujinx, rpcs3]);
const DEFAULT_BIN_DIR = nodePath.resolve(__dirname, '..', '..', '..', 'bin');

function getCore(id) {
  return CORES.find((c) => c.id === id) || null;
}

function listCores() {
  return CORES.slice();
}

/** True when `p` is a regular file (and executable on POSIX). Real-fs default for deps.existsSync. */
function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when `p` is a regular file (no executable bit needed). Used for wine-run .exe files. */
function isRegularFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Find `name` on PATH. Returns an absolute path or null. */
function defaultWhich(name, deps = {}) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const exists = deps.existsSync || isExecutableFile;
  const P = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  if (typeof name !== 'string' || !name || /[\\/]/.test(name)) return null;
  const dirs = String(env.PATH || env.Path || '').split(P.delimiter).filter(Boolean);
  const exts = platform === 'win32'
    ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = P.join(dir, name + ext);
      if (P.isAbsolute(full) && exists(full)) return full;
    }
  }
  return null;
}

function isInside(dir, file, P) {
  if (!dir) return false;
  const rel = P.relative(P.resolve(dir), P.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !P.isAbsolute(rel);
}

/**
 * Resolve a core's executable: override -> candidates -> PATH.
 * @param {object} core adapter
 * @param {{corePaths?: Record<string,string|null>}} settings
 * @param {{existsSync?:Function, statSync?:Function, platform?:string, which?:Function, binDir?:string, homedir?:string, env?:object}} deps
 * @returns {{status:'ready'|'missing'|'unsupported', exe:string|null, source:'override'|'built'|'system'|'path'|null}}
 */
function resolveExecutable(core, settings = {}, deps = {}) {
  const platform = deps.platform || process.platform;
  const existsSync = deps.existsSync || isExecutableFile;
  const env = deps.env || process.env;
  const binDir = deps.binDir === undefined ? DEFAULT_BIN_DIR : deps.binDir;
  const homedir = deps.homedir === undefined ? os.homedir() : deps.homedir;
  // Wine-run .exe files are never chmod +x: only require a regular file (not X_OK).
  const isRegular = typeof deps.statSync === 'function'
    ? (p) => { try { return !!deps.statSync(p).isFile(); } catch { return false; } }
    : (deps.existsSync ? (p) => !!deps.existsSync(p) : isRegularFile);
  const which = deps.which || ((name) => defaultWhich(name, { platform, env, existsSync }));
  const P = platform === 'win32' ? nodePath.win32 : nodePath.posix;

  const override = settings && settings.corePaths ? settings.corePaths[core.id] : null;
  const hasOverride = typeof override === 'string' && override.length > 0;

  if (!core.platforms.includes(platform)) {
    // Windows-only core: allow wine on other hosts when a Project64.exe has been configured.
    if (core.wine && hasOverride && /\.exe$/i.test(override) && isRegular(override) && which('wine')) {
      return { status: 'ready', exe: override, source: 'override' };
    }
    return { status: 'unsupported', exe: null, source: null };
  }

  if (hasOverride && existsSync(override)) {
    return { status: 'ready', exe: override, source: 'override' };
  }

  for (const candidate of core.candidates({ platform, binDir, homedir, env })) {
    if (existsSync(candidate)) {
      return { status: 'ready', exe: candidate, source: isInside(binDir, candidate, P) ? 'built' : 'system' };
    }
  }

  for (const name of core.pathNames || []) {
    const found = which(name);
    if (found) return { status: 'ready', exe: found, source: 'path' };
  }

  return { status: 'missing', exe: null, source: null };
}

/** Renderer-facing description of a core (plan.md §3.3 `cores:list`). */
function describeCore(core, settings, deps) {
  const r = resolveExecutable(core, settings, deps);
  return {
    id: core.id,
    name: core.name,
    systems: core.systems.slice(),
    status: r.status,
    exe: r.exe,
    source: r.source,
    homepage: core.homepage,
    license: core.license,
  };
}

module.exports = { CORES, DEFAULT_BIN_DIR, getCore, listCores, resolveExecutable, describeCore, defaultWhich, isExecutableFile };
