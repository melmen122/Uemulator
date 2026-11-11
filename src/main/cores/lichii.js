'use strict';
// Lichii adapter (Nintendo Switch + Switch 2; Eden/yuzu fork). CLI: "-f/--fullscreen", "-g/--game <path>".
// The macOS release ships lichii.app/Contents/MacOS/lichii; the Windows release is a folder with lichii.exe + Qt DLLs.
const nodePath = require('path');
const { windowsInstallCandidates } = require('./winpaths');

function pathFor(platform) { return platform === 'win32' ? nodePath.win32 : nodePath.posix; }

module.exports = {
  id: 'lichii',
  name: 'Lichii',
  systems: ['switch', 'switch2'],
  platforms: ['darwin', 'win32', 'linux'],
  homepage: 'https://github.com/zortos293/Lichii',
  license: 'GPL-3.0-or-later',
  pathNames: ['lichii'],
  bundleExecutables: ['lichii'],

  candidates(ctx) {
    const { platform, binDir, homedir = '', env = {} } = ctx;
    const P = pathFor(platform);
    const out = [];
    if (platform === 'darwin') {
      // The installed app first: it is the one the user opens by hand and configures (controllers, settings),
      // and macOS ties input permissions to the app they launched. The locally built copy is the fallback.
      out.push(
        '/Applications/lichii.app/Contents/MacOS/lichii',
        P.join(homedir, 'Applications', 'lichii.app', 'Contents', 'MacOS', 'lichii')
      );
      if (binDir) out.push(P.join(binDir, 'lichii', 'lichii.app', 'Contents', 'MacOS', 'lichii'));
    } else if (platform === 'win32') {
      if (binDir) out.push(P.join(binDir, 'lichii', 'lichii.exe'));
      out.push(...windowsInstallCandidates({ env, homedir }, ['Lichii'], 'lichii.exe'));
    } else if (binDir) {
      out.push(P.join(binDir, 'lichii', 'lichii'));
    }
    return out;
  },

  buildArgs(romPath, opts = {}) {
    if (typeof romPath !== 'string' || romPath.length === 0 || romPath.includes('\0')) {
      throw new Error('Invalid ROM path');
    }
    const exe = opts.exe;
    if (!exe) throw new Error('Lichii executable not resolved');
    const args = [];
    if (opts.fullscreen) args.push('-f');
    args.push('-g', romPath);
    return { command: exe, args };
  },

  // Directories where Lichii (Eden/yuzu fork) looks for prod.keys, most likely first.
  keysDirs(ctx = {}) {
    const { platform, homedir = '', env = {}, exe, fs } = ctx;
    const P = pathFor(platform);
    const out = [];
    if (platform === 'win32') {
      out.push(P.join(env.APPDATA || P.join(homedir, 'AppData', 'Roaming'), 'eden', 'keys'));
    } else {
      out.push(P.join(env.XDG_DATA_HOME || P.join(homedir, '.local', 'share'), 'eden', 'keys'));
    }
    // Portable mode: a "user" directory next to the executable.
    if (typeof exe === 'string' && exe && fs) {
      const userDir = P.join(P.dirname(exe), 'user');
      let isDir = false;
      try { isDir = fs.statSync(userDir).isDirectory(); } catch { isDir = false; }
      if (isDir) out.push(P.join(userDir, 'keys'));
    }
    return out;
  },

  // Returns an error string when the game cannot be decrypted, otherwise null. Never throws.
  preflight(game, ctx = {}) {
    try {
      // Switch 2 (.nup) may not need prod.keys (unverified), so only Switch 1 is enforced.
      if (!game || game.system !== 'switch') return null;
      const fs = ctx.fs || require('fs');
      const P = pathFor(ctx.platform);
      const dirs = this.keysDirs({ ...ctx, fs });
      for (const d of dirs) {
        try {
          const st = fs.statSync(P.join(d, 'prod.keys'));
          if (st.isFile() && st.size > 0) return null;
        } catch { /* not found */ }
      }
      return `Lichii can't decrypt this game: prod.keys was not found. Dump prod.keys (and firmware) from your own Switch and put prod.keys in ${dirs[0]}, then try again. (Lichii's own "NCA file has a bad header" message really means missing keys.)`;
    } catch {
      return null;
    }
  },
};
