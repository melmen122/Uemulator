'use strict';
// Azahar adapter. Verified against cores/azahar/src/citra_qt/citra_qt.cpp (argument loop, lines
// ~283-405): "-f/--fullscreen" (line 302); the ROM must be the LAST argument (line 403).
// Executable name: cores/azahar/src/citra_meta/CMakeLists.txt line 7 sets OUTPUT_NAME "azahar";
// on macOS it is an app bundle (azahar.app/Contents/MacOS/azahar), written to
// <build>/bin/<config>/ (cores/azahar/CMakeLists.txt line 390).
const nodePath = require('path');
const { windowsInstallCandidates } = require('./winpaths');

function pathFor(platform) { return platform === 'win32' ? nodePath.win32 : nodePath.posix; }

module.exports = {
  id: 'azahar',
  name: 'Azahar',
  systems: ['3ds'],
  platforms: ['darwin', 'win32', 'linux'],
  homepage: 'https://azahar-emu.org',
  license: 'GPL-2.0',
  pathNames: ['azahar'],
  bundleExecutables: ['azahar'],

  candidates(ctx) {
    const { platform, binDir, homedir = '', env = {} } = ctx;
    const P = pathFor(platform);
    const out = [];
    if (binDir) {
      if (platform === 'darwin') out.push(P.join(binDir, 'azahar', 'azahar.app', 'Contents', 'MacOS', 'azahar'));
      out.push(P.join(binDir, 'azahar', platform === 'win32' ? 'azahar.exe' : 'azahar'));
    }
    if (platform === 'darwin') {
      out.push(
        '/Applications/Azahar.app/Contents/MacOS/azahar',
        P.join(homedir, 'Applications', 'Azahar.app', 'Contents', 'MacOS', 'azahar'),
        '/opt/homebrew/bin/azahar', '/usr/local/bin/azahar'
      );
    } else if (platform === 'win32') {
      out.push(...windowsInstallCandidates({ env, homedir }, ['Azahar', 'azahar'], 'azahar.exe'));
    } else {
      out.push('/usr/bin/azahar', '/usr/local/bin/azahar', '/opt/azahar/azahar');
    }
    return out;
  },

  buildArgs(romPath, opts = {}) {
    if (typeof romPath !== 'string' || romPath.length === 0 || romPath.includes('\0')) {
      throw new Error('Invalid ROM path');
    }
    const exe = opts.exe;
    if (!exe) throw new Error('Azahar executable not resolved');
    const args = [];
    if (opts.fullscreen) args.push('-f');
    args.push(romPath); // must be last
    return { command: exe, args };
  },
};
