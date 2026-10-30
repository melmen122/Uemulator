'use strict';
// mGBA adapter. Flags verified against cores/mgba/src/feature/commandline.c:
//   GRAPHICS_USAGE (line ~33): "-f, --fullscreen", "--scale X"; ROM is the positional argument.
// Binary names verified in cores/mgba/src/platform/qt/CMakeLists.txt (target mgba-qt, OUTPUT_NAME
// "mGBA" on APPLE/WIN32 -> mGBA.app/Contents/MacOS/mGBA) and src/platform/sdl/CMakeLists.txt
// (SDL frontend is "mgba").
const nodePath = require('path');

function pathFor(platform) { return platform === 'win32' ? nodePath.win32 : nodePath.posix; }

function assertRom(romPath) {
  if (typeof romPath !== 'string' || romPath.length === 0 || romPath.includes('\0')) {
    throw new Error('Invalid ROM path');
  }
}

module.exports = {
  id: 'mgba',
  name: 'mGBA',
  systems: ['gba', 'gbc', 'gb'],
  platforms: ['darwin', 'win32', 'linux'],
  homepage: 'https://mgba.io',
  license: 'MPL-2.0',
  pathNames: ['mgba-qt', 'mgba'],
  // Names to look for inside a macOS .app bundle's Contents/MacOS directory.
  bundleExecutables: ['mGBA'],

  candidates(ctx) {
    const { platform, binDir, homedir = '', env = {} } = ctx;
    const P = pathFor(platform);
    const out = [];
    if (binDir) {
      if (platform === 'darwin') out.push(P.join(binDir, 'mgba', 'mGBA.app', 'Contents', 'MacOS', 'mGBA'));
      if (platform === 'win32') out.push(P.join(binDir, 'mgba', 'bin', 'mGBA.exe'), P.join(binDir, 'mgba', 'mGBA.exe'), P.join(binDir, 'mgba', 'mgba.exe'));
      // `cmake --install --prefix bin/mgba` (scripts/build-cores.mjs) puts executables in bin/mgba/bin.
      else out.push(P.join(binDir, 'mgba', 'bin', 'mgba-qt'), P.join(binDir, 'mgba', 'bin', 'mgba'), P.join(binDir, 'mgba', 'mgba-qt'), P.join(binDir, 'mgba', 'mgba'));
    }
    if (platform === 'darwin') {
      out.push(
        '/Applications/mGBA.app/Contents/MacOS/mGBA',
        P.join(homedir, 'Applications', 'mGBA.app', 'Contents', 'MacOS', 'mGBA'),
        '/opt/homebrew/bin/mgba-qt', '/opt/homebrew/bin/mgba',
        '/usr/local/bin/mgba-qt', '/usr/local/bin/mgba'
      );
    } else if (platform === 'win32') {
      for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && P.join(env.LOCALAPPDATA, 'Programs')]) {
        if (base) out.push(P.join(base, 'mGBA', 'mGBA.exe'));
      }
    } else {
      out.push('/usr/bin/mgba-qt', '/usr/bin/mgba', '/usr/local/bin/mgba-qt', '/usr/local/bin/mgba', '/snap/bin/mgba-qt');
    }
    return out;
  },

  buildArgs(romPath, opts = {}) {
    assertRom(romPath);
    const exe = opts.exe;
    if (!exe) throw new Error('mGBA executable not resolved');
    const args = [];
    if (opts.fullscreen) args.push('-f');
    const scale = opts.extra && opts.extra.scale;
    if (Number.isInteger(scale) && scale >= 1 && scale <= 8) args.push('--scale', String(scale));
    args.push(romPath);
    return { command: exe, args };
  },
};
