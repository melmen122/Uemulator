'use strict';
// PyBoy adapter. Verified against cores/pyboy/pyboy/__main__.py:
//   parser.add_argument("ROM", ...) positional (line 58), "-s/--scale" (line 107),
//   "-w/--window" choices SDL2|OpenGL|GLFW|null (line 100). There is NO fullscreen CLI flag
//   (F11 toggles it in-window, see the controls table printed by __main__.py), so
//   opts.fullscreen is intentionally ignored.
// Entry point: `python -m pyboy ROM` (pyboy/__main__.py) or the `pyboy` console script
// ([project.scripts] in cores/pyboy/pyproject.toml).
const nodePath = require('path');

function pathFor(platform) { return platform === 'win32' ? nodePath.win32 : nodePath.posix; }

function isPyboyScript(exe) {
  const base = nodePath.basename(String(exe).replace(/\\/g, '/')).toLowerCase();
  return base === 'pyboy' || base === 'pyboy.exe';
}

module.exports = {
  id: 'pyboy',
  name: 'PyBoy',
  systems: ['gb', 'gbc'],
  platforms: ['darwin', 'win32', 'linux'],
  homepage: 'https://github.com/Baekalfen/PyBoy',
  license: 'LGPL-3.0',
  pathNames: ['pyboy'],
  bundleExecutables: [],

  candidates(ctx) {
    const { platform, binDir } = ctx;
    const P = pathFor(platform);
    if (!binDir) return [];
    return platform === 'win32'
      ? [P.join(binDir, 'pyboy', 'venv', 'Scripts', 'python.exe')]
      : [P.join(binDir, 'pyboy', 'venv', 'bin', 'python')];
  },

  buildArgs(romPath, opts = {}) {
    if (typeof romPath !== 'string' || romPath.length === 0 || romPath.includes('\0')) {
      throw new Error('Invalid ROM path');
    }
    const exe = opts.exe;
    if (!exe) throw new Error('PyBoy executable not resolved');
    const args = isPyboyScript(exe) ? [] : ['-m', 'pyboy'];
    const scale = opts.extra && opts.extra.scale;
    if (Number.isInteger(scale) && scale >= 1 && scale <= 8) args.push('--scale', String(scale));
    args.push(romPath);
    return { command: exe, args };
  },
};
