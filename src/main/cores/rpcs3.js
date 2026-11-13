'use strict';
// RPCS3 (PlayStation 3) adapter. Verified against cores/rpcs3/rpcs3/rpcs3.cpp:
//  - positional arguments (line 811): the first is the boot target ("(S)ELF"), any further ones are
//    passed to the emulated executable (lines 1251-1285). The boot target may be an .iso, a game
//    folder, or an EBOOT.BIN (cores/rpcs3/rpcs3/Emu/System.cpp ~1050, 1600).
//  - "--no-gui" (line 817): boot straight into the game without the main window; the app quits
//    when the game closes (rpcs3qt/gui_application.cpp ~756).
//  - "--fullscreen" (line 818): only valid together with --no-gui (lines 960-966, otherwise a
//    fatal error), so it is only ever emitted after --no-gui, which is always passed.
// Uemulator therefore passes: --no-gui [--fullscreen] <path>, with the path LAST and as the only
// positional argument.
// Executable name: cores/rpcs3/rpcs3/CMakeLists.txt line 100 (add_executable(rpcs3 WIN32 MACOSX_BUNDLE));
// macOS bundle executable is "rpcs3" (rpcs3/rpcs3.plist.in CFBundleExecutable). Output goes to
// <build>/bin (cores/rpcs3/CMakeLists.txt lines 131-133), i.e. bin/rpcs3/rpcs3.app on macOS.
const nodePath = require('path');
const { windowsInstallCandidates } = require('./winpaths');

function pathFor(platform) { return platform === 'win32' ? nodePath.win32 : nodePath.posix; }

module.exports = {
  id: 'rpcs3',
  name: 'RPCS3',
  systems: ['ps3'],
  platforms: ['darwin', 'win32', 'linux'],
  homepage: 'https://rpcs3.net',
  license: 'GPL-2.0',
  pathNames: ['rpcs3'],
  bundleExecutables: ['rpcs3'],

  candidates(ctx) {
    const { platform, binDir, homedir = '', env = {} } = ctx;
    const P = pathFor(platform);
    const out = [];
    if (binDir) {
      if (platform === 'darwin') out.push(P.join(binDir, 'rpcs3', 'rpcs3.app', 'Contents', 'MacOS', 'rpcs3'));
      out.push(P.join(binDir, 'rpcs3', platform === 'win32' ? 'rpcs3.exe' : 'rpcs3'));
    }
    if (platform === 'darwin') {
      out.push(
        '/Applications/RPCS3.app/Contents/MacOS/rpcs3',
        P.join(homedir, 'Applications', 'RPCS3.app', 'Contents', 'MacOS', 'rpcs3'),
        '/opt/homebrew/bin/rpcs3', '/usr/local/bin/rpcs3'
      );
    } else if (platform === 'win32') {
      // RPCS3 ships as a portable archive (rpcs3.exe next to its config); no installer.
      out.push(...windowsInstallCandidates({ env, homedir }, ['RPCS3', 'rpcs3'], 'rpcs3.exe'));
    } else {
      out.push('/usr/bin/rpcs3', '/usr/local/bin/rpcs3', '/opt/rpcs3/rpcs3');
      if (homedir) {
        // Upstream ships a self-contained AppImage ("rpcs3-v0.0.x-<build>_linux64.AppImage"; a bare
        // "rpcs3.AppImage" is also common). Probing a fixed name is all we can do without globbing.
        out.push(P.join(homedir, 'Applications', 'rpcs3.AppImage'), P.join(homedir, '.local', 'bin', 'rpcs3.AppImage'), P.join(homedir, 'rpcs3', 'rpcs3.AppImage'));
      }
    }
    return out;
  },

  buildArgs(romPath, opts = {}) {
    if (typeof romPath !== 'string' || romPath.length === 0 || romPath.includes('\0')) {
      throw new Error('Invalid ROM path');
    }
    const exe = opts.exe;
    if (!exe) throw new Error('RPCS3 executable not resolved');
    const args = ['--no-gui'];
    if (opts.fullscreen) args.push('--fullscreen'); // valid only with --no-gui
    args.push(romPath); // must be last (and the only positional argument)
    return { command: exe, args };
  },

  // RPCS3 firmware marker: vsh.self in dev_flash. Windows: portable layout, dev_flash next to rpcs3.exe.
  // macOS/Linux: the config dir (~/Library/Application Support/rpcs3 or $XDG_CONFIG_HOME|~/.config/rpcs3) -
  // not verified against upstream, so preflight only enforces it on Windows.
  firmwareMarker(ctx = {}) {
    const { platform, homedir = '', env = {}, exe } = ctx;
    const P = pathFor(platform);
    const rel = ['dev_flash', 'vsh', 'module', 'vsh.self'];
    if (platform === 'win32') {
      return typeof exe === 'string' && exe ? P.join(P.dirname(exe), ...rel) : null;
    }
    if (platform === 'darwin') return P.join(homedir, 'Library', 'Application Support', 'rpcs3', ...rel);
    return P.join(env.XDG_CONFIG_HOME || P.join(homedir, '.config'), 'rpcs3', ...rel);
  },

  // Returns an error string when PS3 firmware is missing, otherwise null. Never throws.
  preflight(game, ctx = {}) {
    try {
      if (!game || game.system !== 'ps3') return null;
      if (ctx.platform !== 'win32') return null;
      const marker = this.firmwareMarker(ctx);
      if (!marker) return null;
      const fs = ctx.fs || require('fs');
      try { if (fs.statSync(marker).isFile()) return null; } catch { /* missing */ }
      return `PS3 firmware is not installed (missing ${marker}). Install it in RPCS3 via File > Install Firmware, using PS3UPDAT.PUP from playstation.com (the official Sony download).`;
    } catch {
      return null;
    }
  },
};
