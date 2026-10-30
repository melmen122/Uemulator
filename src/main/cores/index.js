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

/** Windows launches only real executables (no shell): .exe (and legacy .com). X_OK is meaningless there. */
const WIN_EXECUTABLE_RE = /\.(exe|com)$/i;

/**
 * True when `p` is a regular file that can be spawned: on POSIX it needs the X_OK bit; on Windows (where
 * X_OK always succeeds) it must be a .exe/.com. Real-fs default for deps.existsSync.
 * @param {string} p
 * @param {{fs?:object, platform?:string}} [deps] injectable for tests
 */
function isExecutableFile(p, deps = {}) {
  const fsImpl = deps.fs || fs;
  const platform = deps.platform || process.platform;
  try {
    if (!fsImpl.statSync(p).isFile()) return false;
    if (platform === 'win32') return WIN_EXECUTABLE_RE.test(String(p));
    fsImpl.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when `p` is a regular file (no executable bit needed). Used for wine-run .exe files. */
function isRegularFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * Find `name` on PATH. Returns an absolute path or null.
 * On win32 only .exe/.com hits count: the PATHEXT list is honoured but narrowed to what can be spawned without a
 * shell (a .cmd/.bat hit would fail to launch), entries may be quoted, and a bare name never matches an
 * extension-less file.
 */
function defaultWhich(name, deps = {}) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const exists = deps.existsSync || ((p) => isExecutableFile(p, { platform }));
  const P = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  if (typeof name !== 'string' || !name || /[\\/]/.test(name)) return null;
  const strip = platform === 'win32' ? (d) => d.replace(/^"(.*)"$/, '$1') : (d) => d;
  const dirs = String(env.PATH || env.Path || '').split(P.delimiter).map(strip).filter(Boolean);
  let exts = [''];
  if (platform === 'win32') {
    if (WIN_EXECUTABLE_RE.test(name)) exts = [''];
    else {
      exts = String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter((e) => /^\.(exe|com)$/i.test(e));
      if (exts.length === 0) exts = ['.EXE'];
    }
  }
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

/** Hints surfaced as `detail` when a wine-run core is not ready. */
const WINE_MISSING_DETAIL = 'Wine runtime not installed \u2014 run: npm run build:cores -- project64 (it also links the runtime into the app data folder)';
const WINE_MISSING_DETAIL_LINUX = 'Wine not found \u2014 install it with your package manager (e.g. sudo apt install wine)';
const EXE_MISSING_DETAIL = 'Set the path to Project64.exe';

/**
 * Wine-run core on darwin/linux. The .exe comes from the override (or the core's candidates) and only
 * has to be a regular file ending in .exe. A wine binary is looked up as the built runtime (binDir), the
 * userData runtime link, then PATH.
 * @returns {{status:'ready'|'missing', exe:string|null, source:string|null, wine:string|null, wineSource:'built'|'runtime'|'path'|null, detail?:string}}
 */
function resolveWineCore(core, c) {
  let exe = null;
  let source = null;
  if (c.hasOverride && /\.exe$/i.test(c.override) && c.isRegular(c.override)) {
    exe = c.override;
    source = 'override';
  } else {
    for (const candidate of core.candidates({ platform: c.platform, binDir: c.binDir, homedir: c.homedir, env: c.env })) {
      if (/\.exe$/i.test(candidate) && c.isRegular(candidate)) {
        exe = candidate;
        source = isInside(c.binDir, candidate, c.P) ? 'built' : 'system';
        break;
      }
    }
  }

  let wine = null;
  let wineSource = null;
  const wineCandidates = typeof core.wineCandidates === 'function'
    ? core.wineCandidates({ platform: c.platform, binDir: c.binDir, userDataDir: c.userDataDir, homedir: c.homedir, env: c.env }) : [];
  for (const candidate of wineCandidates) {
    if (c.existsSync(candidate)) {
      wine = candidate;
      wineSource = isInside(c.binDir, candidate, c.P) ? 'built' : 'runtime';
      break;
    }
  }
  if (!wine) {
    for (const name of core.winePathNames || ['wine', 'wine64']) {
      const found = c.which(name);
      if (found) { wine = found; wineSource = 'path'; break; }
    }
  }

  const ready = !!exe && !!wine;
  const out = { status: ready ? 'ready' : 'missing', exe, source, wine, wineSource };
  if (!ready) out.detail = [wine ? null : (c.platform === 'linux' ? WINE_MISSING_DETAIL_LINUX : WINE_MISSING_DETAIL), exe ? null : EXE_MISSING_DETAIL].filter(Boolean).join('. ');
  return out;
}

/**
 * Resolve a core's executable: override -> candidates -> PATH.
 * @param {object} core adapter
 * @param {{corePaths?: Record<string,string|null>}} settings
 * @param {{existsSync?:Function, statSync?:Function, platform?:string, which?:Function, binDir?:string, userDataDir?:string, homedir?:string, env?:object}} deps
 * @returns {{status:'ready'|'missing'|'unsupported', exe:string|null, source:'override'|'built'|'system'|'path'|null, wine?:string|null, wineSource?:'built'|'runtime'|'path'|null, detail?:string}}
 *   `wine`/`wineSource`/`detail` are only present for wine-run cores (Project64 on darwin/linux).
 */
function resolveExecutable(core, settings = {}, deps = {}) {
  const platform = deps.platform || process.platform;
  const existsSync = deps.existsSync || ((p) => isExecutableFile(p, { platform }));
  const env = deps.env || process.env;
  const binDir = deps.binDir === undefined ? DEFAULT_BIN_DIR : deps.binDir;
  const homedir = deps.homedir === undefined ? os.homedir() : deps.homedir;
  const userDataDir = typeof deps.userDataDir === 'string' && deps.userDataDir.length > 0 ? deps.userDataDir : undefined;
  // Wine-run .exe files are never chmod +x: only require a regular file (not X_OK).
  const isRegular = typeof deps.statSync === 'function'
    ? (p) => { try { return !!deps.statSync(p).isFile(); } catch { return false; } }
    : (deps.existsSync ? (p) => !!deps.existsSync(p) : isRegularFile);
  const which = deps.which || ((name) => defaultWhich(name, { platform, env, existsSync }));
  const P = platform === 'win32' ? nodePath.win32 : nodePath.posix;

  const override = settings && settings.corePaths ? settings.corePaths[core.id] : null;
  const hasOverride = typeof override === 'string' && override.length > 0;

  // Wine-run cores (Project64): on darwin/linux the .exe is user-supplied and a wine binary is also required.
  if (core.wine && platform !== 'win32') {
    if (platform !== 'darwin' && platform !== 'linux') return { status: 'unsupported', exe: null, source: null };
    return resolveWineCore(core, { hasOverride, override, isRegular, existsSync, which, platform, binDir, userDataDir, homedir, env, P });
  }

  if (!core.platforms.includes(platform)) {
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
  const view = {
    id: core.id,
    name: core.name,
    systems: core.systems.slice(),
    status: r.status,
    exe: r.exe,
    source: r.source,
    homepage: core.homepage,
    license: core.license,
  };
  if (r.detail) view.detail = r.detail;
  return view;
}

module.exports = { CORES, DEFAULT_BIN_DIR, getCore, listCores, resolveExecutable, describeCore, defaultWhich, isExecutableFile, WIN_EXECUTABLE_RE };
