'use strict';
// Lichii adapter (Nintendo Switch + Switch 2; Eden/yuzu fork). CLI: "-f/--fullscreen", "-g/--game <path>".
// The macOS release ships lichii.app/Contents/MacOS/lichii; the Windows release is a folder with lichii.exe + Qt DLLs.
const nodePath = require('path');
const { windowsInstallCandidates } = require('./winpaths');

function pathFor(platform) { return platform === 'win32' ? nodePath.win32 : nodePath.posix; }

module.exports = {
  id: 'lichii',
  name: 'Lichii',
  systems: ['switch'],
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
    return { command: exe, args };
  },
};
