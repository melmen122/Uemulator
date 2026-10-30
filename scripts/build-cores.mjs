#!/usr/bin/env node
// Build emulator cores from the git submodules in cores/ into bin/<id>/.
//   node scripts/build-cores.mjs [--check] [--jobs N] [coreId...]      (default: all cores)
// Nothing under cores/ is edited by hand; out-of-tree build dirs live in bin/.build/ (gitignored).
// Exception: azahar/project64 need their nested submodules initialised inside cores/<id>.
// All processes are started with spawnSync(cmd, [args]) and no shell.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORES_DIR = path.join(ROOT, 'cores');
const BIN_DIR = path.join(ROOT, 'bin');
const BUILD_DIR = path.join(BIN_DIR, '.build');
const PLATFORM = process.platform; // darwin | linux | win32
const ALL_CORES = ['mgba', 'pyboy', 'project64', 'azahar', 'ryujinx'];

const USAGE = `Usage: node scripts/build-cores.mjs [options] [coreId...]

Builds emulator cores from cores/<id> into bin/<id>/. With no core ids, all cores are attempted.
A missing toolchain prints install hints and skips that core; the others still build.

Cores: ${ALL_CORES.join(', ')}

Options:
  --check        only check toolchains (dry run); build nothing
  --jobs N       parallel build jobs (default: CPU count)
  -h, --help     show this help

Examples:
  node scripts/build-cores.mjs --check
  node scripts/build-cores.mjs mgba pyboy
`;

// ---------- install hints ----------
const HINTS = {
  git: { darwin: 'xcode-select --install   (or: brew install git)', linux: 'sudo apt install git', win32: 'winget install Git.Git' },
  cmake: { darwin: 'brew install cmake', linux: 'sudo apt install cmake build-essential', win32: 'winget install Kitware.CMake' },
  dotnet: {
    darwin: 'brew install --cask dotnet-sdk',
    linux: 'sudo apt install dotnet-sdk-10.0   (or see https://dotnet.microsoft.com/download)',
    win32: 'winget install Microsoft.DotNet.SDK.10',
  },
  python3: {
    darwin: 'brew install python',
    linux: 'sudo apt install python3 python3-venv python3-dev build-essential',
    win32: 'winget install Python.Python.3.12',
  },
  compiler: {
    darwin: 'xcode-select --install',
    linux: 'sudo apt install build-essential python3-dev',
    win32: 'winget install Microsoft.VisualStudio.2022.BuildTools   (workload: Desktop development with C++)',
  },
  msbuild: {
    darwin: 'Project64 builds on Windows only.',
    linux: 'Project64 builds on Windows only.',
    win32: 'winget install Microsoft.VisualStudio.2022.BuildTools   (workload: Desktop development with C++), then run from a "Developer Command Prompt"',
  },
  mgbaLibs: {
    darwin: 'brew install cmake qt sdl2 libzip libpng sqlite ffmpeg lua',
    linux: 'sudo apt install build-essential cmake qt6-base-dev qt6-multimedia-dev qt6-l10n-tools libsdl2-dev libzip-dev libpng-dev libsqlite3-dev libedit-dev libelf-dev',
    win32: 'Install Qt + SDL2 (e.g. via vcpkg or MSYS2) and pass them to CMake; see cores/mgba/README.md',
  },
  azaharLibs: {
    darwin: 'brew install cmake qt sdl2 ffmpeg ninja',
    linux: 'sudo apt install build-essential cmake ninja-build qt6-base-dev qt6-multimedia-dev libsdl2-dev libssl-dev libavcodec-dev libavformat-dev libavutil-dev libswscale-dev libswresample-dev libgl-dev libxext-dev',
    win32: 'Install Qt 6 and Visual Studio Build Tools; see cores/azahar/README.md and the Azahar wiki',
  },
};
const hint = (key) => HINTS[key][PLATFORM] ?? HINTS[key].linux;

// ---------- helpers ----------
function exists(cmd, versionArgs = ['--version']) {
  const r = spawnSync(cmd, versionArgs, { stdio: 'ignore' });
  return !r.error;
}

function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return r.error || r.status !== 0 ? null : (r.stdout || '').trim();
}

function run(cmd, args, opts = {}) {
  console.log(`  $ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) {
    console.log(`  ! failed to run ${cmd}: ${r.error.message}`);
    return false;
  }
  return r.status === 0;
}

function findPython() {
  const names = PLATFORM === 'win32' ? ['python', 'py'] : ['python3'];
  for (const n of names) {
    const out = capture(n, ['-c', 'import sys;print("%d.%d" % sys.version_info[:2])']);
    if (out) return { cmd: n, version: out };
  }
  return null;
}

function findMsbuild() {
  if (exists('msbuild', ['-version'])) return 'msbuild';
  const pf86 = process.env['ProgramFiles(x86)'];
  if (PLATFORM === 'win32' && pf86) {
    const vswhere = path.join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (fs.existsSync(vswhere)) {
      const out = capture(vswhere, ['-latest', '-requires', 'Microsoft.Component.MSBuild', '-find', 'MSBuild\\**\\Bin\\MSBuild.exe']);
      if (out) return out.split(/\r?\n/)[0];
    }
  }
  return null;
}

function hasCCompiler() {
  if (PLATFORM === 'win32') return !!findMsbuild();
  return ['cc', 'clang', 'gcc'].some((c) => exists(c));
}

function submoduleReady(id) {
  const dir = path.join(CORES_DIR, id);
  return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
}

function findFirst(root, predicate, maxDepth = 6) {
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (predicate(e, full)) return full;
    }
    if (depth >= maxDepth) return null;
    for (const e of entries) {
      if (e.isDirectory() && !e.isSymbolicLink() && !e.name.endsWith('.app')) {
        const r = walk(path.join(dir, e.name), depth + 1);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(root, 0);
}

function cleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyTree(src, dest) {
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true, force: true });
}

function hostRid() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const os_ = PLATFORM === 'darwin' ? 'osx' : PLATFORM === 'win32' ? 'win' : 'linux';
  return `${os_}-${arch}`;
}

// ---------- per-core definitions ----------
// check(ctx) -> { missing: [{tool, hint}] }; build(ctx) -> { ok, note }
const exeSuffix = PLATFORM === 'win32' ? '.exe' : '';

const CORES = {
  mgba: {
    platforms: ['darwin', 'linux', 'win32'],
    check() {
      const missing = [];
      if (!exists('git')) missing.push({ tool: 'git', hint: hint('git') });
      if (!exists('cmake')) missing.push({ tool: 'cmake (+ Qt and/or SDL2)', hint: hint('mgbaLibs') });
      return missing;
    },
    build({ jobs }) {
      const src = path.join(CORES_DIR, 'mgba');
      const build = path.join(BUILD_DIR, 'mgba');
      const out = path.join(BIN_DIR, 'mgba');
      fs.mkdirSync(build, { recursive: true });
      // BUILD_QT falls back to OFF automatically when Qt is not found (src/platform/qt/CMakeLists.txt).
      const cfg = ['-S', src, '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_QT=ON', '-DBUILD_SDL=ON'];
      if (PLATFORM === 'darwin') {
        const qt = capture('brew', ['--prefix', 'qt']);
        if (qt) cfg.push(`-DCMAKE_PREFIX_PATH=${qt}`);
      }
      if (!run('cmake', cfg)) return { ok: false, note: `configure failed. Needed libraries: ${hint('mgbaLibs')}` };
      if (!run('cmake', ['--build', build, '--config', 'Release', '--parallel', String(jobs)])) return { ok: false, note: 'build failed' };
      cleanDir(out);
      if (!run('cmake', ['--install', build, '--config', 'Release', '--prefix', out])) return { ok: false, note: 'install failed' };
      // macOS: the Qt frontend is a bundle; make sure it sits at bin/mgba/mGBA.app for the adapter.
      if (PLATFORM === 'darwin' && !fs.existsSync(path.join(out, 'mGBA.app'))) {
        const app = findFirst(build, (e, full) => e.isDirectory() && e.name === 'mGBA.app')
          ?? findFirst(out, (e, full) => e.isDirectory() && e.name === 'mGBA.app');
        if (app) copyTree(app, path.join(out, 'mGBA.app'));
      }
      const found = findFirst(out, (e) => !e.isDirectory() && /^(mgba-qt|mgba|mGBA)(\.exe)?$/.test(e.name));
      return found ? { ok: true, note: path.relative(ROOT, found) } : { ok: false, note: `built, but no mGBA executable found under ${path.relative(ROOT, out)}` };
    },
  },

  azahar: {
    platforms: ['darwin', 'linux', 'win32'],
    check() {
      const missing = [];
      if (!exists('git')) missing.push({ tool: 'git', hint: hint('git') });
      if (!exists('cmake')) missing.push({ tool: 'cmake (+ Qt 6, SDL2, C++20 compiler)', hint: hint('azaharLibs') });
      return missing;
    },
    build({ jobs }) {
      const src = path.join(CORES_DIR, 'azahar');
      const build = path.join(BUILD_DIR, 'azahar');
      const out = path.join(BIN_DIR, 'azahar');
      // Nested submodules are only fetched when Azahar is actually built (plan.md §1).
      if (!run('git', ['-C', src, 'submodule', 'update', '--init', '--recursive', '--depth', '1'])) {
        return { ok: false, note: 'could not fetch nested submodules' };
      }
      fs.mkdirSync(build, { recursive: true });
      const cfg = ['-S', src, '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DENABLE_TESTS=OFF', '-DENABLE_QT=ON'];
      if (PLATFORM === 'darwin') {
        const qt = capture('brew', ['--prefix', 'qt']);
        if (qt) cfg.push(`-DCMAKE_PREFIX_PATH=${qt}`);
      }
      if (!run('cmake', cfg)) return { ok: false, note: `configure failed. Needed libraries: ${hint('azaharLibs')}` };
      // Target citra_meta produces the "azahar" executable (src/citra_meta/CMakeLists.txt).
      if (!run('cmake', ['--build', build, '--config', 'Release', '--target', 'citra_meta', '--parallel', String(jobs)])) {
        return { ok: false, note: 'build failed' };
      }
      // CMAKE_RUNTIME_OUTPUT_DIRECTORY is <build>/bin/<config> (cores/azahar/CMakeLists.txt).
      const produced = path.join(build, 'bin', 'Release');
      if (!fs.existsSync(produced)) return { ok: false, note: `expected output ${path.relative(ROOT, produced)} not found` };
      cleanDir(out);
      copyTree(produced, out);
      const found = findFirst(out, (e) => !e.isDirectory() && e.name === `azahar${exeSuffix}`);
      return found ? { ok: true, note: path.relative(ROOT, found) } : { ok: false, note: 'built, but no azahar executable found in output' };
    },
  },

  ryujinx: {
    platforms: ['darwin', 'linux', 'win32'],
    check() {
      const missing = [];
      if (!exists('dotnet')) {
        missing.push({ tool: 'dotnet (.NET SDK, see cores/ryujinx/global.json)', hint: hint('dotnet') });
      } else {
        const need = requiredDotnetMajor();
        const have = parseInt((capture('dotnet', ['--version']) ?? '0').split('.')[0], 10);
        if (need && have < need) missing.push({ tool: `.NET SDK >= ${need} (found ${have})`, hint: hint('dotnet') });
      }
      return missing;
    },
    build() {
      const proj = path.join(CORES_DIR, 'ryujinx', 'src', 'Ryujinx', 'Ryujinx.csproj');
      const out = path.join(BIN_DIR, 'ryujinx');
      cleanDir(out);
      const args = ['publish', proj, '-c', 'Release', '-r', hostRid(), '--self-contained', 'true', '-o', out];
      if (!run('dotnet', args)) return { ok: false, note: 'dotnet publish failed' };
      const found = path.join(out, `Ryujinx${exeSuffix}`);
      return fs.existsSync(found) ? { ok: true, note: path.relative(ROOT, found) } : { ok: false, note: 'published, but Ryujinx executable not found' };
    },
  },

  pyboy: {
    platforms: ['darwin', 'linux', 'win32'],
    check() {
      const missing = [];
      const py = findPython();
      if (!py) missing.push({ tool: 'python3 >= 3.9', hint: hint('python3') });
      else {
        const [maj, min] = py.version.split('.').map(Number);
        if (maj < 3 || (maj === 3 && min < 9)) missing.push({ tool: `python >= 3.9 (found ${py.version})`, hint: hint('python3') });
      }
      if (!hasCCompiler()) missing.push({ tool: 'C compiler (Cython extension build)', hint: hint('compiler') });
      return missing;
    },
    build() {
      const py = findPython();
      const venv = path.join(BIN_DIR, 'pyboy', 'venv');
      const buildSrc = path.join(BUILD_DIR, 'pyboy-src');
      // Build from a copy so pip's in-tree Cython build never writes into cores/pyboy.
      cleanDir(buildSrc);
      fs.cpSync(path.join(CORES_DIR, 'pyboy'), buildSrc, {
        recursive: true,
        filter: (s) => !['.git', '__pycache__', 'tests', 'docs'].includes(path.basename(s)),
      });
      fs.rmSync(venv, { recursive: true, force: true });
      if (!run(py.cmd, ['-m', 'venv', venv])) return { ok: false, note: 'venv creation failed (on Debian/Ubuntu: sudo apt install python3-venv)' };
      const vpy = path.join(venv, ...(PLATFORM === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
      if (!run(vpy, ['-m', 'pip', 'install', '--upgrade', 'pip'])) return { ok: false, note: 'pip upgrade failed' };
      if (!run(vpy, ['-m', 'pip', 'install', buildSrc])) return { ok: false, note: 'pip install failed (needs a C compiler)' };
      return { ok: true, note: path.relative(ROOT, vpy) };
    },
  },

  project64: {
    platforms: ['win32'],
    check() {
      const missing = [];
      if (PLATFORM !== 'win32') return [{ tool: 'Windows', hint: hint('msbuild') }];
      if (!exists('git')) missing.push({ tool: 'git', hint: hint('git') });
      if (!findMsbuild()) missing.push({ tool: 'msbuild (Visual Studio 2019+)', hint: hint('msbuild') });
      return missing;
    },
    build() {
      const src = path.join(CORES_DIR, 'project64');
      const out = path.join(BIN_DIR, 'project64');
      // Project64 needs GLideN64 and SDL sources from its own nested submodules.
      if (!run('git', ['-C', src, 'submodule', 'update', '--init', '--recursive', '--depth', '1'])) {
        return { ok: false, note: 'could not fetch nested submodules' };
      }
      const msbuild = findMsbuild();
      if (!run(msbuild, ['Project64.sln', '/m', '/p:Configuration=Release', '/p:Platform=x64'], { cwd: src })) {
        return { ok: false, note: 'msbuild failed' };
      }
      // Platform.props: OutDir = $(SolutionDir)bin\$(Platform)\$(Configuration)\
      const produced = path.join(src, 'Bin', 'x64', 'Release');
      if (!fs.existsSync(path.join(produced, 'Project64.exe'))) return { ok: false, note: 'Project64.exe not found in Bin/x64/Release' };
      cleanDir(out);
      copyTree(produced, out);
      return { ok: true, note: path.relative(ROOT, path.join(out, 'Project64.exe')) };
    },
  },
};

function requiredDotnetMajor() {
  try {
    const g = JSON.parse(fs.readFileSync(path.join(CORES_DIR, 'ryujinx', 'global.json'), 'utf8'));
    return parseInt(String(g.sdk.version).split('.')[0], 10) || null;
  } catch {
    return null;
  }
}

// ---------- main ----------
function parseArgs(argv) {
  const opts = { check: false, jobs: Math.max(1, os.cpus().length), ids: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--jobs') {
      const n = Number.parseInt(argv[++i], 10);
      if (!Number.isInteger(n) || n < 1 || n > 256) throw new Error('--jobs expects a positive integer');
      opts.jobs = n;
    } else if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
    else if (!ALL_CORES.includes(a)) throw new Error(`Unknown core "${a}". Known cores: ${ALL_CORES.join(', ')}`);
    else if (!opts.ids.includes(a)) opts.ids.push(a);
  }
  if (opts.ids.length === 0) opts.ids = ALL_CORES.slice();
  return opts;
}

function printTable(rows) {
  const w = [Math.max(4, ...rows.map((r) => r.id.length)), Math.max(6, ...rows.map((r) => r.status.length))];
  console.log('\nSummary');
  console.log(`${'core'.padEnd(w[0])}  ${'status'.padEnd(w[1])}  details`);
  console.log(`${'-'.repeat(w[0])}  ${'-'.repeat(w[1])}  -------`);
  for (const r of rows) console.log(`${r.id.padEnd(w[0])}  ${r.status.padEnd(w[1])}  ${r.note}`);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const rows = [];
  for (const id of opts.ids) {
    const core = CORES[id];
    console.log(`\n== ${id} ==`);
    if (!core.platforms.includes(PLATFORM)) {
      console.log(`  ${id} can only be built on: ${core.platforms.join(', ')}`);
      rows.push({ id, status: 'unsupported', note: `builds on ${core.platforms.join('/')} only` });
      continue;
    }
    if (!submoduleReady(id)) {
      console.log('  cores/' + id + ' is empty. Run: git submodule update --init --depth 1 cores/' + id);
      rows.push({ id, status: 'skipped', note: 'submodule not checked out' });
      continue;
    }
    const missing = core.check();
    if (missing.length > 0) {
      for (const m of missing) console.log(`  missing: ${m.tool}\n    install: ${m.hint}`);
      rows.push({ id, status: 'skipped', note: `missing ${missing.map((m) => m.tool.split(' ')[0]).join(', ')}` });
      continue;
    }
    if (opts.check) {
      console.log('  toolchain OK');
      rows.push({ id, status: 'ready', note: 'toolchain present (--check: not built)' });
      continue;
    }
    let result;
    try {
      result = core.build({ jobs: opts.jobs });
    } catch (err) {
      result = { ok: false, note: err.message };
    }
    console.log(result.ok ? `  built: ${result.note}` : `  FAILED: ${result.note}`);
    rows.push({ id, status: result.ok ? 'built' : 'failed', note: result.note });
  }

  printTable(rows);
  // Missing toolchains are expected and never fail the run; real build failures do.
  if (rows.some((r) => r.status === 'failed')) process.exitCode = 1;
}

main();
