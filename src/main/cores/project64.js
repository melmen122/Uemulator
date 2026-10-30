'use strict';
// Project64 adapter. Verified against cores/project64/Source/Project64-core/AppInit.cpp
// ParseCommand() (line ~174): accepts only --help, --combo <file> and the ROM path as the LAST
// positional argument. There is no fullscreen flag, so opts.fullscreen is ignored.
// Windows build output: Bin/<Platform>/<Configuration>/Project64.exe (PropertySheets/Platform.props).
// Windows only; on other platforms the exe is run through `wine` when a .exe is configured.
const nodePath = require('path');

function pathFor(platform) { return platform === 'win32' ? nodePath.win32 : nodePath.posix; }

module.exports = {
  id: 'project64',
  name: 'Project64',
  systems: ['n64'],
  platforms: ['win32'],
  // Non-win32 hosts may run Project64.exe via wine (see cores/index.js resolveExecutable).
  wine: true,
  homepage: 'https://www.pj64-emu.com',
  license: 'GPL-2.0',
  pathNames: [],
  bundleExecutables: [],

  candidates(ctx) {
    const { platform, binDir, env = {} } = ctx;
    if (platform !== 'win32') return [];
    const P = pathFor(platform);
    const out = [];
    if (binDir) out.push(P.join(binDir, 'project64', 'Project64.exe'));
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (base) out.push(P.join(base, 'Project64 3.0', 'Project64.exe'), P.join(base, 'Project64', 'Project64.exe'));
    }
    if (env.LOCALAPPDATA) out.push(P.join(env.LOCALAPPDATA, 'Project64', 'Project64.exe'));
    return out;
  },

  /** opts: { exe, platform? (default process.platform) } */
  buildArgs(romPath, opts = {}) {
    if (typeof romPath !== 'string' || romPath.length === 0 || romPath.includes('\0')) {
      throw new Error('Invalid ROM path');
    }
    const exe = opts.exe;
    if (!exe) throw new Error('Project64 executable not resolved');
    const platform = opts.platform || process.platform;
    if (platform !== 'win32') {
      if (!/\.exe$/i.test(exe)) throw new Error('Project64 is only supported on Windows (or via wine with a Project64.exe)');
      return { command: 'wine', args: [exe, romPath] };
    }
    return { command: exe, args: [romPath] };
  },
};
