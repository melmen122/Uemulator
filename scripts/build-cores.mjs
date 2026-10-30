#!/usr/bin/env node
// Build emulator cores from the git submodules in cores/ into bin/<id>/.
//   node scripts/build-cores.mjs [--check] [--jobs N] [coreId...]      (default: all cores)
// Nothing under cores/ is edited by hand; out-of-tree build dirs live in bin/.build/ (gitignored).
// Exception: azahar/project64/rpcs3 need their nested submodules initialised inside cores/<id>.
// All processes are started with spawnSync(cmd, [args]) and no shell.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORES_DIR = path.join(ROOT, 'cores');
const BIN_DIR = path.join(ROOT, 'bin');
const BUILD_DIR = path.join(BIN_DIR, '.build');
const PLATFORM = process.platform; // darwin | linux | win32
const ALL_CORES = ['mgba', 'pyboy', 'project64', 'azahar', 'ryujinx', 'rpcs3'];

// Wine runtime used to run the Windows Project64.exe on macOS (Project64 has no native macOS build).
// Pinned like OmniTroid/neutron (BSD-3-Clause, https://github.com/OmniTroid/neutron, versions.env):
// prebuilt x86_64 macOS Wine from Gcenx; runs under Rosetta 2 on Apple Silicon.
const WINE_VERSION = '11.18';
const WINE_BIN_URL = 'https://github.com/Gcenx/macOS_Wine_builds/releases/download/11.18/wine-devel-11.18-osx64.tar.xz';
const WINE_BIN_SHA256 = 'aa0ea4c82e636ae7bca2076387cb0a5affa26509ad13f119ecd0d62bd7ba6f82';
const WINE_DL_DIR = path.join(BUILD_DIR, 'wine-dl');
const WINE_UNPACK_DIR = path.join(BUILD_DIR, 'wine-unpack');
const WINE_OUT_DIR = path.join(BIN_DIR, 'wine');
const ROSETTA_PATH = '/Library/Apple/usr/share/rosetta/rosetta';

const USAGE = `Usage: node scripts/build-cores.mjs [options] [coreId...]

Builds emulator cores from cores/<id> into bin/<id>/. With no core ids, all cores are attempted.
A missing toolchain prints install hints and skips that core; the others still build.

Cores: ${ALL_CORES.join(', ')}

project64 on macOS: Project64 is Windows-only, so this step installs a Wine runtime into bin/wine/
(Gcenx wine-devel ${WINE_VERSION}, x86_64, ~190 MB, SHA-256 verified; needs Rosetta on Apple Silicon).
You still supply Project64.exe yourself (https://www.pj64-emu.com) and set its path in Settings.
On Windows it builds Project64 from source with MSBuild. On Linux, install wine from your package manager.

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
  rosetta: { darwin: 'softwareupdate --install-rosetta --agree-to-license', linux: '', win32: '' },
  tar: { darwin: 'tar ships with macOS (check that /usr/bin/tar exists)', linux: 'sudo apt install tar xz-utils', win32: '' },
  curl: { darwin: 'curl ships with macOS (check that /usr/bin/curl exists)', linux: 'sudo apt install curl', win32: '' },
  msbuild: {
    darwin: 'Project64 builds on Windows only.',
    linux: 'Project64 builds on Windows only; on Linux install wine (sudo apt install wine) and set the Project64.exe path in Settings.',
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
  // RPCS3 (cores/rpcs3/BUILDING.md): CMake 3.28+, Clang 19+/GCC 13+, Qt >= 6.7 (3rdparty/qt6.cmake) with
  // Multimedia/Svg, SDL3, Vulkan, and LLVM (system LLVM on macOS/Linux; built from the submodule on Windows).
  rpcs3Libs: {
    darwin: 'brew install cmake ninja qt sdl3 llvm molten-vk vulkan-headers vulkan-loader   (RPCS3 only officially supports Windows/Linux builds; macOS is best-effort. Or install the prebuilt app from https://rpcs3.net and use Settings.)',
    linux: 'sudo apt install build-essential ninja-build cmake llvm-dev libasound2-dev libpulse-dev libopenal-dev libglew-dev zlib1g-dev libedit-dev libvulkan-dev libudev-dev libevdev-dev libsdl3-dev libjack-dev libsndio-dev libcurl4-openssl-dev qt6-base-dev qt6-base-private-dev qt6-multimedia-dev qt6-svg-dev libxkbcommon-dev   (needs GCC 13+/Clang 19+, Qt >= 6.7, SDL3; see cores/rpcs3/BUILDING.md)',
    win32: 'Install Visual Studio 2022 (Desktop development with C++), CMake 3.28+, Python 3, Qt 6 (set Qt6_ROOT, e.g. C:\\Qt\\6.x\\msvc2022_64) and the Vulkan SDK (sets VULKAN_SDK); see cores/rpcs3/BUILDING.md',
  },
  ninja: { darwin: 'brew install ninja', linux: 'sudo apt install ninja-build', win32: 'winget install Ninja-build.Ninja   (optional on Windows)' },
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

/** True when a Qt 6 install can be located (env hints, Homebrew, or qmake6/qtpaths6 on PATH). */
function hasQt6() {
  if (process.env.Qt6_ROOT || process.env.Qt6_DIR || process.env.QTDIR) return true;
  if (PLATFORM === 'darwin' && capture('brew', ['--prefix', '--installed', 'qt'])) return true;
  return exists('qmake6') || exists('qtpaths6') || exists('qmake', ['-v']);
}

/** True when LLVM can be located for a system-LLVM build (macOS/Linux). */
function hasSystemLlvm() {
  if (process.env.LLVM_DIR) return true;
  if (PLATFORM === 'darwin' && capture('brew', ['--prefix', '--installed', 'llvm'])) return true;
  return ['llvm-config', 'llvm-config-19', 'llvm-config-20', 'llvm-config-21', 'llvm-config-22'].some((c) => exists(c));
}

/** Submodule paths declared in cores/<id>/.gitmodules (relative to the core), or [] on error. */
function nestedSubmodulePaths(id) {
  const out = capture('git', ['-C', path.join(CORES_DIR, id), 'config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']);
  if (!out) return [];
  return out.split(/\r?\n/).map((l) => l.trim().split(/\s+/)[1]).filter(Boolean);
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

// ---------- wine runtime (macOS, for Project64.exe) ----------
function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function hasRosetta() {
  if (process.arch !== 'arm64') return true; // Intel Mac: no translation needed
  if (fs.existsSync(ROSETTA_PATH)) return true;
  return spawnSync('arch', ['-x86_64', '/usr/bin/true'], { stdio: 'ignore' }).status === 0;
}

/** Refuse archives that hold absolute paths or `..` segments. Lists only; extracts nothing. */
function assertSafeArchiveListing(archive) {
  const r = spawnSync('tar', ['-tJf', archive], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`could not list the archive: ${r.error ? r.error.message : (r.stderr || '').trim()}`);
  const entries = r.stdout.split('\n').filter(Boolean);
  if (entries.length === 0) throw new Error('the archive is empty');
  for (const e of entries) {
    if (e.startsWith('/') || /^[A-Za-z]:/.test(e) || e.includes('\0') || e.split(/[\\/]+/).includes('..')) {
      throw new Error(`refusing unsafe archive entry: ${JSON.stringify(e.slice(0, 200))}`);
    }
  }
  return entries.length;
}

/**
 * After extraction: every symlink must be relative, non-dangling and resolve (kernel semantics, via realpath, so
 * chained links like `a -> .` + `c -> a/../..` are caught) to a path inside `root`. `..` segments are allowed
 * only when the realpath stays inside the tree. Throws on the first offender; moves nothing.
 */
function assertSymlinksContained(root) {
  // .native = the OS realpath(3): the JS fs.realpathSync normalizes `..` lexically and would miss chained escapes.
  const realRoot = fs.realpathSync.native(root);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        const rel = path.relative(root, full);
        if (!target || target.includes('\0') || path.isAbsolute(target) || /^[A-Za-z]:/.test(target)) {
          throw new Error(`refusing symlink with an absolute or empty target: ${rel} -> ${target}`);
        }
        let real;
        try { real = fs.realpathSync.native(full); } catch {
          throw new Error(`refusing dangling or unresolvable symlink: ${rel} -> ${target}`);
        }
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          throw new Error(`refusing symlink that leaves the archive: ${rel} -> ${target}`);
        }
      } else if (e.isDirectory()) walk(full);
    }
  };
  walk(root);
}

/** Find the wine tree root: a directory D with D/bin/wine (or wine64) and D/lib. Descends into .app bundles. */
function findWineRoot(root, maxDepth = 8) {
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    const names = new Set(entries.map((e) => e.name));
    if (names.has('bin') && names.has('lib')) {
      const bin = path.join(dir, 'bin');
      if (['wine', 'wine64'].some((n) => { try { return fs.statSync(path.join(bin, n)).isFile(); } catch { return false; } })) return dir;
    }
    if (depth >= maxDepth) return null;
    for (const e of entries) {
      if (e.isDirectory() && !e.isSymbolicLink()) {
        const r = walk(path.join(dir, e.name), depth + 1);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(root, 0);
}

/** Path of the wine launcher inside a wine tree root. Prefer `wine` (handles 32/64-bit), else `wine64`. */
function wineBinaryIn(wineRoot) {
  for (const n of ['wine', 'wine64']) {
    const p = path.join(wineRoot, 'bin', n);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

function wineEnv(prefix) {
  const env = { ...process.env, WINEDEBUG: '-all', WINEDLLOVERRIDES: 'mscoree,mshtml=' };
  for (const k of Object.keys(env)) if (k === 'WINELOADER' || k.startsWith('DYLD_') || k.startsWith('LD_')) delete env[k];
  if (prefix) env.WINEPREFIX = prefix;
  return env;
}

/**
 * Installs bin/wine (idempotent: skipped when bin/wine/bin/wine --version reports the pinned wine-<WINE_VERSION>), then links it at the
 * packaged app's userData location so the installed app finds it too.
 */
function installWineRuntime() {
  let r;
  const existing = wineBinaryIn(WINE_OUT_DIR);
  const probe = existing ? spawnSync(existing, ['--version'], { encoding: 'utf8', timeout: 60000, env: wineEnv() }) : null;
  const probed = probe ? (probe.stdout || '').trim() : '';
  const probeOk = probe && !probe.error && probe.status === 0;
  if (probeOk && probed === `wine-${WINE_VERSION}`) {
    console.log(`  Wine runtime already installed (${path.relative(ROOT, existing)}: ${probed}); skipping download/extract`);
    r = { ok: true, note: `${path.relative(ROOT, existing)} (${probed}), already installed` };
  } else {
    if (probeOk && /^wine/i.test(probed)) console.log(`  installed Wine runtime (${probed}) differs from the pinned wine-${WINE_VERSION}; reinstalling`);
    r = downloadAndInstallWineRuntime();
  }
  if (r.ok) linkWineRuntimeIntoUserData();
  return r;
}

/** Electron's default macOS userData dir: ~/Library/Application Support/<package.json name>. */
function appUserDataDir() {
  let name = 'uemulator';
  try {
    const n = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name;
    if (typeof n === 'string' && /^[A-Za-z0-9._-]+$/.test(n)) name = n;
  } catch { /* keep default */ }
  return path.join(os.homedir(), 'Library', 'Application Support', name);
}

/**
 * Symlink <userData>/runtime/wine -> <repo>/bin/wine. An existing symlink is replaced; a real file or
 * directory is never touched (a notice is printed). Failure here is reported but not fatal.
 */
function linkWineRuntimeIntoUserData() {
  const link = path.join(appUserDataDir(), 'runtime', 'wine');
  try {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    let st = null;
    try { st = fs.lstatSync(link); } catch { /* absent */ }
    if (st && !st.isSymbolicLink()) {
      console.log(`  NOTICE: ${link} already exists and is not a symlink; leaving it alone. Remove it manually if the installed app should use ${WINE_OUT_DIR}.`);
      return;
    }
    if (st) fs.unlinkSync(link);
    fs.symlinkSync(WINE_OUT_DIR, link, 'dir');
    console.log(`  linked for the installed app: ${link} -> ${WINE_OUT_DIR}`);
    console.log('  (the dev profile finds bin/wine directly; if the repo moves, re-run this step to refresh the link)');
  } catch (err) {
    console.log(`  NOTICE: could not create the wine runtime link at ${link}: ${err.message}`);
  }
}

function downloadAndInstallWineRuntime() {
  fs.mkdirSync(WINE_DL_DIR, { recursive: true });
  const archive = path.join(WINE_DL_DIR, path.basename(new URL(WINE_BIN_URL).pathname));
  let have = fs.existsSync(archive) ? sha256File(archive) : null;
  if (have === WINE_BIN_SHA256) {
    console.log(`  reusing verified download: ${path.relative(ROOT, archive)}`);
  } else {
    if (have) console.log('  existing download has the wrong checksum; downloading again');
    // Download to a temp name, verify, and only then move into place.
    const part = `${archive}.part`;
    fs.rmSync(part, { force: true });
    if (!run('curl', ['-fL', '--retry', '3', '-o', part, WINE_BIN_URL])) {
      fs.rmSync(part, { force: true });
      return { ok: false, note: `download failed: ${WINE_BIN_URL}` };
    }
    have = sha256File(part);
    if (have !== WINE_BIN_SHA256) {
      fs.rmSync(part, { force: true });
      return { ok: false, note: `CHECKSUM MISMATCH, aborting (nothing extracted). expected ${WINE_BIN_SHA256}, got ${have}` };
    }
    fs.renameSync(part, archive);
  }
  console.log(`  sha256 OK (${WINE_BIN_SHA256.slice(0, 16)}...)`);

  try { console.log(`  archive listing OK (${assertSafeArchiveListing(archive)} entries, no absolute or ".." paths)`); } catch (err) {
    return { ok: false, note: err.message };
  }

  cleanDir(WINE_UNPACK_DIR);
  // Array args, no shell. -o: do not restore owners. Never -P (absolute paths stay refused by tar itself).
  if (!run('tar', ['-xJf', archive, '-C', WINE_UNPACK_DIR])) return { ok: false, note: 'extraction failed' };
  try { assertSymlinksContained(WINE_UNPACK_DIR); } catch (err) {
    fs.rmSync(WINE_UNPACK_DIR, { recursive: true, force: true });
    return { ok: false, note: err.message };
  }
  const root = findWineRoot(WINE_UNPACK_DIR);
  if (!root) return { ok: false, note: `no wine tree (bin/wine + lib) found in the archive; inspect ${path.relative(ROOT, WINE_UNPACK_DIR)}` };
  console.log(`  wine tree found at: ${path.relative(WINE_UNPACK_DIR, root)}`);

  fs.rmSync(WINE_OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.renameSync(root, WINE_OUT_DIR); // same filesystem; keeps bin/, lib/, share/ together
  fs.rmSync(WINE_UNPACK_DIR, { recursive: true, force: true });

  const wine = wineBinaryIn(WINE_OUT_DIR);
  if (!wine) return { ok: false, note: 'installed, but no bin/wine found' };
  fs.chmodSync(wine, 0o755);

  const ver = spawnSync(wine, ['--version'], { encoding: 'utf8', timeout: 60000, env: wineEnv() });
  const out = (ver.stdout || '').trim();
  if (ver.error || ver.status !== 0 || !/^wine/i.test(out)) {
    return { ok: false, note: `wine --version failed (${ver.error ? ver.error.message : `exit ${ver.status}: ${(ver.stderr || '').trim().slice(0, 300)}`})` };
  }
  console.log(`  $ ${path.relative(ROOT, wine)} --version\n  ${out}`);
  smokeTestPrefix(wine);
  return { ok: true, note: `${path.relative(ROOT, wine)} (${out})` };
}

/** Optional deeper check: `wine cmd /c ver` in a throwaway prefix. Failure is reported, not fatal. */
function smokeTestPrefix(wine) {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-wine-smoke-'));
  console.log('  smoke test: wine cmd /c ver in a throwaway prefix (first run initialises the prefix; may take a while)');
  const t0 = Date.now();
  const r = spawnSync(wine, ['cmd', '/c', 'ver'], { encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', env: wineEnv(prefix) });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.error) console.log(`  smoke test did not complete after ${secs}s: ${r.error.message}`);
  else console.log(`  smoke test exit ${r.status} in ${secs}s: ${(r.stdout || '').trim().replace(/\s+/g, ' ')}${r.stderr && r.stderr.trim() ? ` | stderr: ${r.stderr.trim().slice(0, 300)}` : ''}`);
  // Stop any wineserver left behind by the throwaway prefix, then delete it.
  spawnSync(path.join(path.dirname(wine), 'wineserver'), ['-k'], { stdio: 'ignore', timeout: 15000, env: wineEnv(prefix) });
  fs.rmSync(prefix, { recursive: true, force: true });
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

  rpcs3: {
    platforms: ['darwin', 'linux', 'win32'],
    check() {
      const missing = [];
      if (!exists('git')) missing.push({ tool: 'git', hint: hint('git') });
      if (!exists('cmake')) missing.push({ tool: 'cmake >= 3.28 (+ Qt 6.7+, SDL3, Vulkan, LLVM)', hint: hint('rpcs3Libs') });
      if (PLATFORM !== 'win32' && !exists('ninja')) missing.push({ tool: 'ninja', hint: hint('ninja') });
      if (!hasQt6()) missing.push({ tool: 'Qt 6.7+ (Widgets, Multimedia, Svg)', hint: hint('rpcs3Libs') });
      if (PLATFORM === 'win32') {
        if (!findMsbuild()) missing.push({ tool: 'Visual Studio 2022 (C++ workload)', hint: hint('compiler') });
        if (!process.env.VULKAN_SDK) missing.push({ tool: 'Vulkan SDK (VULKAN_SDK env var)', hint: hint('rpcs3Libs') });
      } else {
        if (!hasCCompiler()) missing.push({ tool: 'C/C++ compiler (Clang 19+ or GCC 13+)', hint: hint('compiler') });
        if (!hasSystemLlvm()) missing.push({ tool: 'LLVM (llvm-config / LLVM_DIR)', hint: hint('rpcs3Libs') });
      }
      return missing;
    },
    build({ jobs }) {
      const src = path.join(CORES_DIR, 'rpcs3');
      const build = path.join(BUILD_DIR, 'rpcs3');
      const out = path.join(BIN_DIR, 'rpcs3');
      // Nested submodules are only fetched when RPCS3 is actually built (plan.md §1). The LLVM
      // submodule (llvm-project, huge) is only needed on Windows (BUILD_LLVM=ON, as in CMakePresets.json
      // preset "msvc"); macOS/Linux use system LLVM. SDL3/curl/zlib/gamemode come from the system.
      const skip = PLATFORM === 'win32' ? [] : ['3rdparty/llvm/', '3rdparty/libsdl-org/', '3rdparty/curl/', '3rdparty/zlib/', '3rdparty/feralinteractive/'];
      const wanted = nestedSubmodulePaths('rpcs3').filter((p) => !skip.some((s) => p.startsWith(s)));
      const subArgs = ['-C', src, 'submodule', 'update', '--init', '--recursive', '--depth', '1'];
      if (!run('git', wanted.length > 0 ? [...subArgs, '--', ...wanted] : subArgs)) {
        return { ok: false, note: 'could not fetch nested submodules' };
      }
      fs.mkdirSync(build, { recursive: true });
      // Out-of-tree build; the preset binaryDirs (build-msvc, ...) would write inside cores/rpcs3, so
      // the preset's cache variables are passed explicitly instead.
      const cfg = ['-S', src, '-B', build];
      if (PLATFORM === 'win32') {
        cfg.push('-G', 'Visual Studio 17 2022', '-A', 'x64', '-DCMAKE_CONFIGURATION_TYPES=Debug;Release',
          '-DBUILD_LLVM=ON', '-DSTATIC_LINK_LLVM=ON', '-DUSE_FAUDIO=OFF', '-DUSE_SYSTEM_CURL=OFF',
          '-DUSE_SYSTEM_ZLIB=OFF', '-DUSE_SYSTEM_OPENAL=OFF', '-DUSE_PRECOMPILED_HEADERS=ON');
        if (process.env.Qt6_ROOT) cfg.push(`-DCMAKE_PREFIX_PATH=${process.env.Qt6_ROOT}`);
      } else {
        cfg.push('-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_LLVM=OFF', '-DUSE_SYSTEM_SDL=ON',
          '-DUSE_SYSTEM_ZLIB=ON', '-DUSE_SYSTEM_CURL=ON', '-DUSE_GAMEMODE=OFF');
        // Portable codegen on Apple/ARM builds (BUILDING.md: NEON errors with -march=native; .ci/build-mac.sh).
        if (PLATFORM === 'darwin' || process.arch === 'arm64') cfg.push('-DUSE_NATIVE_INSTRUCTIONS=OFF');
        if (PLATFORM === 'darwin') {
          cfg.push('-DUSE_SYSTEM_MVK=ON'); // as .ci/build-mac.sh; needs MoltenVK (brew molten-vk)
          const prefixes = ['qt', 'sdl3', 'llvm', 'molten-vk', 'vulkan-headers', 'vulkan-loader']
            .map((f) => capture('brew', ['--prefix', '--installed', f])).filter(Boolean);
          const llvm = capture('brew', ['--prefix', '--installed', 'llvm']);
          if (llvm && !process.env.LLVM_DIR) cfg.push(`-DLLVM_DIR=${path.join(llvm, 'lib', 'cmake', 'llvm')}`);
          if (prefixes.length > 0) cfg.push(`-DCMAKE_PREFIX_PATH=${prefixes.join(';')}`);
        }
      }
      if (!run('cmake', cfg)) return { ok: false, note: `configure failed. Needed libraries: ${hint('rpcs3Libs')}` };
      if (!run('cmake', ['--build', build, '--config', 'Release', '--target', 'rpcs3', '--parallel', String(jobs)])) {
        return { ok: false, note: 'build failed' };
      }
      // CMAKE_RUNTIME_OUTPUT_DIRECTORY_<CONFIG> is <build>/bin (cores/rpcs3/CMakeLists.txt); the
      // post-build step copies Icons/GuiConfigs and runs macdeployqt/windeployqt there.
      const produced = path.join(build, 'bin');
      if (!fs.existsSync(produced)) return { ok: false, note: `expected output ${path.relative(ROOT, produced)} not found` };
      cleanDir(out);
      copyTree(produced, out);
      // findFirst never descends into .app bundles, so the macOS executable is probed directly.
      const macExe = path.join(out, 'rpcs3.app', 'Contents', 'MacOS', 'rpcs3');
      const found = PLATFORM === 'darwin'
        ? (fs.existsSync(macExe) ? macExe : null)
        : findFirst(out, (e) => !e.isDirectory() && e.name === `rpcs3${exeSuffix}`);
      return found ? { ok: true, note: path.relative(ROOT, found) } : { ok: false, note: 'built, but no rpcs3 executable found in output' };
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
    // win32: build from source (MSBuild). darwin: install a Wine runtime (Project64.exe is user-supplied).
    // linux: not built here; install wine from the package manager.
    platforms: ['win32', 'darwin'],
    needsSubmodule: PLATFORM === 'win32',
    check() {
      const missing = [];
      if (PLATFORM === 'darwin') {
        if (!hasRosetta()) missing.push({ tool: 'Rosetta 2 (Wine is x86_64)', hint: hint('rosetta') });
        if (!exists('tar', ['--version'])) missing.push({ tool: 'tar', hint: hint('tar') });
        if (!exists('curl', ['--version'])) missing.push({ tool: 'curl', hint: hint('curl') });
        if (missing.length === 0) console.log(`  will install Wine ${WINE_VERSION} (Gcenx build, ~190 MB) into ${path.relative(ROOT, WINE_OUT_DIR)}/; you supply Project64.exe`);
        return missing;
      }
      if (PLATFORM !== 'win32') return [{ tool: 'Windows or macOS', hint: hint('msbuild') }];
      if (!exists('git')) missing.push({ tool: 'git', hint: hint('git') });
      if (!findMsbuild()) missing.push({ tool: 'msbuild (Visual Studio 2019+)', hint: hint('msbuild') });
      return missing;
    },
    build() {
      if (PLATFORM === 'darwin') return installWineRuntime();
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
    if (core.needsSubmodule !== false && !submoduleReady(id)) {
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

export { sha256File, assertSafeArchiveListing, assertSymlinksContained };

// Only run when executed directly, so tests can import the helpers.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
