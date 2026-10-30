'use strict';
// Project64 adapter. Verified against cores/project64/Source/Project64-core/AppInit.cpp
// ParseCommand() (line ~174): accepts only --help, --combo <file> and the ROM path as the LAST
// positional argument. There is no fullscreen flag, so opts.fullscreen is ignored.
// Windows build output: Bin/<Platform>/<Configuration>/Project64.exe (PropertySheets/Platform.props).
// Windows: runs the exe directly. macOS/Linux: Project64.exe (user-supplied) is run through a Wine
// runtime (bundled at bin/wine/bin/wine by `npm run build:cores -- project64` on macOS, also linked at
// <userData>/runtime/wine for the packaged app, else `wine` on PATH).
const nodePath = require('path');
const { windowsInstallCandidates } = require('./winpaths');

// Env the launcher may set for the wine process; processes.js enforces the same allowlist.
const WINE_ENV = Object.freeze({ WINEDEBUG: '-all', WINEDLLOVERRIDES: 'mscoree,mshtml=' });

function pathFor(platform) { return platform === 'win32' ? nodePath.win32 : nodePath.posix; }

module.exports = {
  id: 'project64',
  name: 'Project64',
  systems: ['n64'],
  platforms: ['win32', 'darwin'],
  // darwin/linux run Project64.exe via wine (see cores/index.js resolveExecutable).
  wine: true,
  // Wine binary lookup (non-win32): built runtime first, then these names on PATH.
  winePathNames: ['wine', 'wine64'],
  homepage: 'https://www.pj64-emu.com',
  license: 'GPL-2.0',
  pathNames: [],
  bundleExecutables: [],

  candidates(ctx) {
    const { platform, binDir, homedir = '', env = {} } = ctx;
    if (platform !== 'win32') return [];
    const P = pathFor(platform);
    const out = [];
    if (binDir) out.push(P.join(binDir, 'project64', 'Project64.exe'));
    // Official installer: C:\Program Files (x86)\Project64 3.0\Project64.exe
    out.push(...windowsInstallCandidates({ env, homedir }, ['Project64 3.0', 'Project64'], 'Project64.exe'));
    return out;
  },

  /**
   * Absolute paths of a bundled wine binary (Gcenx layout: <root>/bin/wine), in priority order:
   * the built runtime under binDir (dev), then <userDataDir>/runtime/wine (stable location that also works in
   * the packaged app, where binDir sits inside app.asar; build-cores symlinks it to the repo's bin/wine).
   */
  wineCandidates(ctx) {
    const { binDir, userDataDir } = ctx;
    const out = [];
    if (binDir) out.push(nodePath.posix.join(binDir, 'wine', 'bin', 'wine'));
    if (userDataDir) out.push(nodePath.posix.join(userDataDir, 'runtime', 'wine', 'bin', 'wine'));
    return out;
  },

  /** opts: { exe, platform? (default process.platform), wine?, prefixDir? } */
  buildArgs(romPath, opts = {}) {
    if (typeof romPath !== 'string' || romPath.length === 0 || romPath.includes('\0')) {
      throw new Error('Invalid ROM path');
    }
    const exe = opts.exe;
    if (!exe) throw new Error('Project64 executable not resolved');
    const platform = opts.platform || process.platform;
    if (platform !== 'win32') {
      if (!/\.exe$/i.test(exe)) throw new Error('Project64 is only supported on Windows (or via wine with a Project64.exe)');
      const wine = opts.wine === undefined || opts.wine === null ? 'wine' : opts.wine;
      if (typeof wine !== 'string' || wine.length === 0 || wine.includes('\0')) throw new Error('Invalid wine path');
      const env = {};
      if (opts.prefixDir !== undefined && opts.prefixDir !== null) {
        if (typeof opts.prefixDir !== 'string' || opts.prefixDir.length === 0 || opts.prefixDir.includes('\0')) {
          throw new Error('Invalid wine prefix path');
        }
        env.WINEPREFIX = opts.prefixDir;
      }
      Object.assign(env, WINE_ENV);
      // exe and ROM are separate argv elements (no shell); the ROM stays the last positional argument.
      return { command: wine, args: [exe, romPath], env };
    }
    return { command: exe, args: [romPath] };
  },
};
