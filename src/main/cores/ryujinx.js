'use strict';
// Ryujinx (Ryubing) adapter. Verified against cores/ryujinx/src/Ryujinx/Utilities/CommandLineState.cs
// ParseArguments(): "-f/--fullscreen" (line ~104); any unrecognised arg is the launch path
// (`default: LaunchPathArg = arg`, line 213). Executable is named "Ryujinx"
// (cores/ryujinx/distribution/macos/create_app_bundle.sh copies it to Ryujinx.app/Contents/MacOS/Ryujinx).
const nodePath = require('path');
const { windowsInstallCandidates } = require('./winpaths');

function pathFor(platform) { return platform === 'win32' ? nodePath.win32 : nodePath.posix; }

module.exports = {
  id: 'ryujinx',
  name: 'Ryujinx',
  systems: ['switch'],
  platforms: ['darwin', 'win32', 'linux'],
  homepage: 'https://ryujinx.app',
  license: 'MIT',
  pathNames: ['Ryujinx', 'ryujinx'],
  bundleExecutables: ['Ryujinx'],

  candidates(ctx) {
    const { platform, binDir, homedir = '', env = {} } = ctx;
    const P = pathFor(platform);
    const out = [];
    if (binDir) out.push(P.join(binDir, 'ryujinx', platform === 'win32' ? 'Ryujinx.exe' : 'Ryujinx'));
    if (platform === 'darwin') {
      out.push(
        '/Applications/Ryujinx.app/Contents/MacOS/Ryujinx',
        P.join(homedir, 'Applications', 'Ryujinx.app', 'Contents', 'MacOS', 'Ryujinx')
      );
    } else if (platform === 'win32') {
      // The official Windows build is a zip (Ryujinx\Ryujinx.exe, or Ryujinx\publish\Ryujinx.exe as built from source).
      out.push(...windowsInstallCandidates({ env, homedir }, ['Ryujinx', 'Ryujinx\\publish'], 'Ryujinx.exe'));
    } else {
      out.push('/opt/ryujinx/Ryujinx', '/usr/bin/Ryujinx', '/usr/local/bin/Ryujinx', '/usr/bin/ryujinx', '/usr/local/bin/ryujinx');
    }
    return out;
  },

  buildArgs(romPath, opts = {}) {
    if (typeof romPath !== 'string' || romPath.length === 0 || romPath.includes('\0')) {
      throw new Error('Invalid ROM path');
    }
    const exe = opts.exe;
    if (!exe) throw new Error('Ryujinx executable not resolved');
    const args = [];
    if (opts.fullscreen) args.push('--fullscreen');
    args.push(romPath);
    return { command: exe, args };
  },

  // Directories where Ryujinx/Ryubing keeps prod.keys, highest priority first. From upstream AppDataManager
  // (unverified this session: upstream source was unreachable): a "portable" folder next to the exe is the
  // data root when it exists; otherwise %APPDATA%Ryujinx (Windows), ~/Library/Application Support/Ryujinx
  // (macOS) or $XDG_CONFIG_HOME|~/.config/Ryujinx (Linux). Keys live in <root>/system; the per-user ~/.switch (KeysDirPathUser) is also read, so it is listed last.
  keysDirs(ctx = {}) {
    const { platform, homedir = '', env = {}, exe, fs } = ctx;
    const P = pathFor(platform);
    const out = [];
    if (platform === 'win32') {
      if (typeof exe === 'string' && exe && fs) {
        const portable = P.join(P.dirname(exe), 'portable');
        let isDir = false;
        try { isDir = fs.statSync(portable).isDirectory(); } catch { isDir = false; }
        if (isDir) out.push(P.join(portable, 'system'));
      }
      out.push(P.join(env.APPDATA || P.join(homedir, 'AppData', 'Roaming'), 'Ryujinx', 'system'));
      out.push(P.join(homedir, '.switch'));
    } else if (platform === 'darwin') {
      out.push(P.join(homedir, 'Library', 'Application Support', 'Ryujinx', 'system'));
      out.push(P.join(homedir, '.switch'));
    } else {
      out.push(P.join(env.XDG_CONFIG_HOME || P.join(homedir, '.config'), 'Ryujinx', 'system'));
      out.push(P.join(homedir, '.switch'));
    }
    return out;
  },

  // Returns an error string when the game cannot be decrypted, otherwise null. Never throws.
  preflight(game, ctx = {}) {
    try {
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
      return `Ryujinx can't decrypt this game: prod.keys was not found. Copy prod.keys (and title.keys) dumped from your own Switch into ${dirs[0]}, then install firmware in Ryujinx via Actions > Install Firmware. (If you already use Lichii, the same files from its keys folder, e.g. %APPDATA%\\lichii\\keys, can be copied.)`;
    } catch {
      return null;
    }
  },
};
