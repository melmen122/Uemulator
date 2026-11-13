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
      if (binDir) out.push(P.join(binDir, 'lichii', 'lichii.app', 'Contents', 'MacOS', 'lichii'));
      out.push(
        '/Applications/lichii.app/Contents/MacOS/lichii',
        P.join(homedir, 'Applications', 'lichii.app', 'Contents', 'MacOS', 'lichii')
      );
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
    const out = { command: exe, args };
    // macOS: SDL's GameController ("MFi") backend swallows generic Bluetooth pads that report VID/PID 0
    // (e.g. Switch Pro clones such as the "Lic3 Pro Controller"), so they vanish from Lichii's
    // Settings > Controls. SDL reads this hint from the environment; turning it off lists them via IOKit.
    if (opts.platform === 'darwin') out.env = { SDL_JOYSTICK_MFI: '0' };
    return out;
  },

  // Directories where Lichii (Eden/yuzu fork) looks for prod.keys, highest priority first.
  // Upstream (src/common/fs/fs_paths.h, path_util.cpp): user root is "lichii" (EDEN_DIR), keys live in <root>/keys,
  // the old "eden" root (EDEN_LEGACY_DIR) is only a legacy/import source, and on Windows a "user" folder next to
  // the exe (PORTABLE_DIR) overrides %APPDATA%. On other platforms upstream resolves $XDG_DATA_HOME/lichii (also on
  // macOS, i.e. ~/.local/share/lichii) and its portable "user" dir is relative to the current directory.
  keysDirs(ctx = {}) {
    const { platform, homedir = '', env = {}, exe, fs } = ctx;
    const P = pathFor(platform);
    const out = [];
    const portable = () => {
      if (typeof exe !== 'string' || !exe || !fs) return null;
      const userDir = P.join(P.dirname(exe), 'user');
      let isDir = false;
      try { isDir = fs.statSync(userDir).isDirectory(); } catch { isDir = false; }
      return isDir ? P.join(userDir, 'keys') : null;
    };
    if (platform === 'win32') {
      const portableKeys = portable();
      if (portableKeys) out.push(portableKeys);
      const roaming = env.APPDATA || P.join(homedir, 'AppData', 'Roaming');
      out.push(P.join(roaming, 'lichii', 'keys'), P.join(roaming, 'eden', 'keys'));
    } else {
      const data = env.XDG_DATA_HOME || P.join(homedir, '.local', 'share');
      out.push(P.join(data, 'lichii', 'keys'), P.join(data, 'eden', 'keys'));
      const portableKeys = portable();
      if (portableKeys) out.push(portableKeys);
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
