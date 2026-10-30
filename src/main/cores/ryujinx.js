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
};
