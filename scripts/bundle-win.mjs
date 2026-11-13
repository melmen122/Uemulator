// Fetches the official Windows x64 builds of the bundled emulators and lays them out in
// bundle-win/emulators/<id>/ so electron-builder can ship them as extraResources.
//
//   node scripts/bundle-win.mjs [--force] [--out <dir>] [--ps3-firmware]
//
// --out <dir> (relative to the repo root, or absolute) writes <dir>/<id>/ instead of bundle-win/emulators/<id>/.
// For dev mode (npm start) use "--out bin": the app resolves bundled emulators from <repo>/bin when not packaged.
// --ps3-firmware (opt-in, dev only) downloads and installs the official PS3 system software into <out>/rpcs3. It is refused for
// the default packaging dir: Sony's firmware is not redistributable and must never end up in the installer.
//   dev flow: node scripts/bundle-win.mjs --out bin --ps3-firmware
// (--no-ps3-firmware is still accepted and is a no-op, since firmware is now off by default.)
//
// Archives are SHA-256 verified before extraction, listed and path-checked, extracted with
// bsdtar (argument arrays, no shell) and never executed.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const OUT_SUBDIR = 'bundle-win/emulators';
export const CACHE_SUBDIR = 'bundle-win/cache';
// Ownership marker written into <out>/<id> after a successful install; only folders carrying it are ever replaced.
export const STAMP = '.uemulator-bundle.json';
// Written into <out>/rpcs3 after a clean firmware install (dev only; never shipped, see package.json extraResources).
export const FW_STAMP = '.uemulator-ps3fw.json';

// Every artifact is SHA-256 pinned; these lists only bound where the bytes may come from.
// ALLOWED_HOSTS: hosts the manifest URLs may name. REDIRECT_HOSTS adds the GitHub release-asset CDN hosts that
// github.com release URLs redirect to (checked on every redirect hop, never accepted as a manifest URL host).
export const ALLOWED_HOSTS = Object.freeze(['github.com', 'git.ryujinx.app', 'www.python.org', 'files.pythonhosted.org', 'dus01.ps3.update.playstation.net']);
export const REDIRECT_HOSTS = Object.freeze([...ALLOWED_HOSTS, 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
export const MAX_REDIRECTS = 5;
// Sony's update host only serves plain http; that is acceptable solely because the download is hash-pinned.
const HTTP_OK_HOSTS = Object.freeze(['dus01.ps3.update.playstation.net']);

export const MANIFEST = Object.freeze([
  Object.freeze({
    id: 'lichii',
    name: 'Lichii',
    version: 'build-160',
    file: 'lichii-windows-x86_64.zip',
    url: 'https://github.com/zortos293/Lichii/releases/download/build-160/lichii-windows-x86_64.zip',
    // Matches the "digest" field the GitHub release API reports for this asset.
    sha256: '215459edfbd9f6c542b4548cabf4c16d487feca8ce1003a1094f9beda5f02460',
    format: 'zip',
    exe: 'lichii.exe',
    keep: Object.freeze(['user']),
  }),
  Object.freeze({
    id: 'mgba',
    name: 'mGBA',
    version: '0.10.5',
    file: 'mGBA-0.10.5-win64.7z',
    url: 'https://github.com/mgba-emu/mgba/releases/download/0.10.5/mGBA-0.10.5-win64.7z',
    // Pinned from the first download: upstream publishes no checksum for this asset.
    sha256: 'b497a57c7d9093834dadc64f33a90f7c411439c21fdb8a0143255a45ea37563a',
    format: '7z',
    exe: 'mGBA.exe',
    // The archive ships portable.ini, so settings live next to the exe.
    keep: Object.freeze(['config.ini', 'qt.ini']),
  }),
  Object.freeze({
    id: 'azahar',
    name: 'Azahar',
    version: '2126.2',
    file: 'azahar-windows-msvc-2126.2.zip',
    url: 'https://github.com/azahar-emu/azahar/releases/download/2126.2/azahar-windows-msvc-2126.2.zip',
    sha256: '4412eac8d13123c8840f11890fc26e5b0e4c76d16aa28a608941377b948a9db0',
    format: 'zip',
    exe: 'azahar.exe',
    // Not portable as shipped (no portable marker / user folder in the archive), so nothing lives in the install dir.
    keep: Object.freeze([]),
  }),
  Object.freeze({
    id: 'rpcs3',
    name: 'RPCS3',
    version: '0.0.43-20574',
    file: 'rpcs3-v0.0.43-20574-8183f6e3_win64_msvc.7z',
    url: 'https://github.com/RPCS3/rpcs3-binaries-win/releases/download/build-8183f6e328f4d9903b29325978db59226e5e7177/rpcs3-v0.0.43-20574-8183f6e3_win64_msvc.7z',
    sha256: '12b36fbb6e0c44de8d8880d09d8b7c6d57a53b197741aae9948da0e82b54a7bc',
    format: '7z',
    exe: 'rpcs3.exe',
    keep: Object.freeze(['config', 'GuiConfigs', 'dev_hdd0', 'dev_flash', '.uemulator-ps3fw.json', 'dev_usb000', 'savestates', 'screenshots', 'patches', 'games.yml', 'games']),
    // Official Sony system software, installed once with "rpcs3.exe --installfw" (dev_flash is in keep, so it persists).
    firmware: Object.freeze({
      version: '4.93',
      file: 'PS3UPDAT.PUP',
      url: 'http://dus01.ps3.update.playstation.net/update/ps3/image/us/2026_0318_a2b60b6ac1d2e49e230144345616927c/PS3UPDAT.PUP',
      sha256: '158471fd834f8ea8036136b6aab43cd86c7ba73d79ca30e0af3c0fe0001cf365',
      marker: 'dev_flash/vsh/module/vsh.self',
    }),
  }),
  Object.freeze({
    id: 'ryujinx',
    name: 'Ryujinx (Ryubing)',
    version: '1.3.3',
    file: 'ryujinx-1.3.3-win_x64.zip',
    url: 'https://git.ryujinx.app/projects/Ryubing/releases/download/1.3.3/ryujinx-1.3.3-win_x64.zip',
    sha256: 'baa93f48b012eefeca339a78a39844599ccd194c109093f354a4b9d1e03a056e',
    format: 'zip',
    exe: 'Ryujinx.exe',
    // A "portable" folder next to the exe keeps config, keys and saves inside the install dir.
    keep: Object.freeze(['portable']),
  }),
  Object.freeze({
    id: 'pyboy',
    name: 'PyBoy (embedded Python)',
    version: '2.9.0',
    // Self-contained python.org embeddable build plus pinned wheels unpacked into Lib/site-packages (no pip, no system Python).
    kind: 'python',
    file: 'python-3.13.17-embed-amd64.zip',
    url: 'https://www.python.org/ftp/python/3.13.17/python-3.13.17-embed-amd64.zip',
    sha256: '9e35319bffedab8b36ad44d8f377cb4f1733bcec257a0b6d04d94f01486ddb38',
    format: 'zip',
    exe: 'python/python.exe',
    wheels: Object.freeze([
      Object.freeze({
        file: 'pyboy-2.9.0-cp313-cp313-win_amd64.whl',
        url: 'https://files.pythonhosted.org/packages/34/1e/4833db5cdab57a9db2e65c8a44ffeb8381a9d62008eb88830773fa486465/pyboy-2.9.0-cp313-cp313-win_amd64.whl',
        sha256: 'c9460067f2ebecbb552c8c95897cf6f88948809b8cc8b36d19932ecadff494c6',
      }),
      Object.freeze({
        file: 'numpy-2.5.4-cp313-cp313-win_amd64.whl',
        url: 'https://files.pythonhosted.org/packages/90/8c/140a40398a66b4471211be1affdb6ed24c486d581bd28d07b7f2fcb69540/numpy-2.5.4-cp313-cp313-win_amd64.whl',
        sha256: '8b4d2fd2d34e5f8c9235ee787de5631a37a28402b15cb80814df973d2be54129',
      }),
      Object.freeze({
        file: 'PySDL2-0.9.17-py3-none-any.whl',
        url: 'https://files.pythonhosted.org/packages/5d/e2/399ea7900e7510096aeb41439e6f1540bef0bdf7e15cc2d8464e4adb71e8/PySDL2-0.9.17-py3-none-any.whl',
        sha256: 'fe923dbf5c7b27bbc1eb2bf58abfa793f8f13fd7ae8b27b1bc2de49920bcbd41',
      }),
      Object.freeze({
        file: 'pysdl2_dll-2.32.10-py2.py3-none-win_amd64.whl',
        url: 'https://files.pythonhosted.org/packages/91/8e/3a90c664cca4c61c7538a8b1a7fd86c7dc3521465198a844bce21b4a97c1/pysdl2_dll-2.32.10-py2.py3-none-win_amd64.whl',
        sha256: '65eba83d68c33b22aa5eca6c9a8521cff5044435ecd5b49521068df82674de6a',
      }),
    ]),
    // Run after the tree is assembled (before it replaces any existing install); a non-zero exit fails the bundle.
    smoke: Object.freeze(['-c', "import pyboy, sdl2, numpy; print(pyboy.__version__ if hasattr(pyboy, '__version__') else 'ok')"]),
    keep: Object.freeze([]),
  }),
]);

/** True when an archive entry path is safe to extract under a destination directory. */
export function isSafeEntry(p) {
  if (typeof p !== 'string' || p === '') return false;
  if (p.includes('\0')) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false; // posix absolute, UNC
  if (/^[A-Za-z]:/.test(p)) return false; // drive letter
  return !p.split(/[\\/]/).includes('..');
}

const isJunk = (segs) => segs[0] === '__MACOSX' || segs[segs.length - 1].toLowerCase() === 'desktop.ini';

/** Single shared top-level directory name of every entry, or null. */
export function commonTopDir(entries) {
  let top = null;
  for (const raw of entries || []) {
    if (typeof raw !== 'string') return null;
    const segs = raw.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
    if (segs.length === 0 || isJunk(segs)) continue;
    const isDir = /[\\/]$/.test(raw);
    // A lone top-level file (no directory) means there is no common directory.
    if (segs.length === 1 && !isDir) return null;
    if (top === null) top = segs[0];
    else if (top !== segs[0]) return null;
  }
  return top;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------

const log = (...a) => console.log(...a);
const mb = (n) => (n / 1048576).toFixed(1);

function dirSize(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}

function findSymlink(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return p;
    if (st.isDirectory()) {
      const r = findSymlink(p);
      if (r) return r;
    }
  }
  return null;
}

// bsdtar is on PATH on macOS/Linux. Windows 10+ ships the same libarchive tar as System32\tar.exe (no bsdtar.exe).
// On Windows only that absolute path is used: spawnSync with a bare name searches the current directory before
// PATH (a planted tar.exe), and Git-for-Windows can put a GNU tar first on PATH.
let TAR = 'bsdtar';

/** Candidate tar executables to probe, in order. win32: the absolute System32 path only (no bare names). */
export function tarCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') return [win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')];
  return ['bsdtar'];
}

function bsdtar(args) {
  const r = spawnSync(TAR, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: false });
  if (r.error) throw new Error(`bsdtar failed to run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`bsdtar ${args[0]} exited ${r.status}: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

function checkBsdtar() {
  for (const cmd of tarCandidates()) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', shell: false });
    if (!r.error && r.status === 0 && /bsdtar|libarchive/i.test(r.stdout || '')) {
      TAR = cmd;
      return;
    }
  }
  throw new Error('bsdtar (libarchive tar) was not found. It ships with macOS and Windows 10+ (as %SystemRoot%\\System32\\tar.exe); on Linux install libarchive-tools (bsdtar).');
}

/** Throws unless item.url is https (or http on an HTTP_OK host) and on the allowlist. `hosts` is ALLOWED_HOSTS for manifest URLs, REDIRECT_HOSTS for redirect hops. */
export function checkSource(item, hosts = ALLOWED_HOSTS) {
  const u = new URL(item.url);
  if (!hosts.includes(u.hostname)) throw new Error(`${item.file}: host ${u.hostname} is not in the download allowlist`);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && HTTP_OK_HOSTS.includes(u.hostname))) throw new Error(`${item.file}: refusing non-https url ${item.url}`);
}

/** Fetches with manual redirects: every hop is re-validated (allowlist + scheme), https->http downgrades only to HTTP_OK hosts, max MAX_REDIRECTS hops. */
export async function fetchChecked(item, fetchFn = fetch) {
  let url = item.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchFn(url, { redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get('location');
    try { await res.body?.cancel(); } catch { /* ignore */ }
    if (!loc) throw new Error(`${item.file}: redirect (HTTP ${res.status}) without a Location header`);
    const next = new URL(loc, url);
    if (new URL(url).protocol === 'https:' && next.protocol !== 'https:' && !HTTP_OK_HOSTS.includes(next.hostname)) throw new Error(`${item.file}: refusing https->http downgrade to ${next.href}`);
    checkSource({ file: item.file, url: next.href }, REDIRECT_HOSTS);
    url = next.href;
  }
  throw new Error(`${item.file}: too many redirects (more than ${MAX_REDIRECTS})`);
}

async function download(entry, cachePath) {
  const res = await fetchChecked({ file: entry.id || entry.url, url: entry.url });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${entry.url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let lastPct = -1;
  const tmp = `${cachePath}.part`;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (pct !== lastPct && (pct % 5 === 0 || pct === -1)) {
      lastPct = pct;
      process.stdout.write(`\r  ${entry.id || entry.file}: ${pct >= 0 ? pct + '% ' : ''}${mb(got)}${total ? ' / ' + mb(total) : ''} MB   `);
    }
  });
  try {
    await pipeline(body, createWriteStream(tmp));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  process.stdout.write('\n');
  renameSync(tmp, cachePath);
}

function readStamp(dest) {
  try {
    return JSON.parse(readFileSync(join(dest, STAMP), 'utf8'));
  } catch {
    return null;
  }
}

const wheelSig = (entry) => (entry.wheels || []).map((w) => `${w.file}:${w.sha256}`).join(',');

function upToDate(entry, dest) {
  const s = readStamp(dest);
  return !!s && s.file === entry.file && s.sha256 === entry.sha256 && s.version === entry.version && (!entry.wheels || s.wheels === wheelSig(entry)) && existsSync(join(dest, entry.exe));
}

/**
 * True when `dest` may be deleted/replaced by this script: it does not exist, or it carries the STAMP file
 * (created by a previous bundle-win run). Stamp only: no guessing from the presence of an exe.
 */
export function canReplace(dest) {
  return !existsSync(dest) || existsSync(join(dest, STAMP));
}

/**
 * Replaces `dest` with `extractedDir` (renamed into place) as backup-then-swap. The old install is first renamed to
 * `<dest>.old-<pid>` (a sibling, so same volume); the new tree is then renamed into dest, and each name in `keep`
 * is moved from the old install over the shipped copy (the user's copy wins; for directories, shipped-only files
 * are copied into the user's copy first). User data is never moved into extractedDir, so cleaning up the temp
 * extraction can never touch it, and the old install is only deleted after every keep entry was carried over.
 */
export function swapInto(extractedDir, dest, keep = []) {
  const old = `${dest}.old-${process.pid}`;
  const hadOld = existsSync(dest);
  if (hadOld) renameSync(dest, old); // throws with nothing touched if dest is locked
  try {
    renameSync(extractedDir, dest);
  } catch (e) {
    if (existsSync(old)) renameSync(old, dest); // roll back
    throw e;
  }
  if (hadOld) {
    try {
      for (const name of keep) {
        const mine = join(old, name);
        if (!existsSync(mine)) continue;
        const shipped = join(dest, name);
        if (existsSync(shipped)) {
          // User copy wins. For directories, first top up the user's copy with shipped-only files.
          if (lstatSync(mine).isDirectory() && lstatSync(shipped).isDirectory()) {
            cpSync(shipped, mine, { recursive: true, force: false, errorOnExist: false });
          }
          rmSync(shipped, { recursive: true, force: true });
        }
        renameSync(mine, shipped);
        log(`  preserved ${name}`);
      }
    } catch (e) {
      throw new Error(`${e.message} (the previous install and your data are intact in ${old})`, { cause: e });
    }
    try {
      rmSync(old, { recursive: true, force: true });
    } catch (e) {
      console.warn(`  warning: left previous install at ${old} (${e.message})`);
    }
  }
}

/** True when `dir` is (or is inside) the default packaging directory that electron-builder copies into the installer. */
export function isPackagingDir(dir) {
  const rel = relative(resolve(ROOT, OUT_SUBDIR).toLowerCase(), resolve(dir).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Output root from "--out <dir>" / "--out=<dir>" (relative to the repo root); defaults to OUT_SUBDIR. */
export function parseOutDir(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let v;
    if (a === '--out') v = argv[i + 1];
    else if (a.startsWith('--out=')) v = a.slice(6);
    else continue;
    if (!v || v.startsWith('--')) throw new Error('--out needs a directory argument');
    return resolve(ROOT, v);
  }
  return join(ROOT, OUT_SUBDIR);
}

/** Downloads `item` ({file,url,sha256}) into the cache unless a copy with the pinned hash is already there. Returns its path. */
async function fetchVerified(item, label) {
  checkSource(item);
  if (!/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error(`${label}: manifest sha256 is not pinned`);
  const cacheDir = join(ROOT, CACHE_SUBDIR);
  mkdirSync(cacheDir, { recursive: true });
  const archive = join(cacheDir, item.file);
  let have = existsSync(archive) ? await sha256File(archive) : null;
  if (have !== item.sha256) {
    if (have) log(`${label}: cached file hash differs, re-downloading`);
    log(`${label}: downloading ${item.url}`);
    await download({ id: label, url: item.url }, archive);
    have = await sha256File(archive);
    if (have !== item.sha256) {
      rmSync(archive, { force: true });
      throw new Error(`${label}: SHA-256 mismatch, file deleted.\n  expected ${item.sha256}\n  actual   ${have}`);
    }
  } else {
    log(`${label}: using cached ${item.file}`);
  }
  return archive;
}

/** Lists an archive and rejects it if any entry path is unsafe. Returns the entry list. */
function listSafe(label, archive) {
  const listing = bsdtar(['-tf', archive]).split(/\r?\n/).filter((l) => l !== '');
  const bad = listing.filter((p) => !isSafeEntry(p));
  if (bad.length) throw new Error(`${label}: unsafe archive entries rejected (${bad.length}), e.g. ${JSON.stringify(bad[0])}`);
  return listing;
}

/** Makes the embeddable Python see Lib\\site-packages and run site.py (the shipped ._pth has "import site" commented out). */
export function patchPth(text) {
  const PKGS = 'Lib\\site-packages';
  const out = [];
  let hasSite = false;
  let hasPkgs = false;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (l === '') continue;
    if (/^#\s*import\s+site$/.test(l) || l === 'import site') {
      out.push('import site');
      hasSite = true;
    } else {
      if (l === PKGS) hasPkgs = true;
      out.push(l);
    }
  }
  if (!hasPkgs) {
    const i = out.indexOf('import site');
    if (i >= 0) out.splice(i, 0, PKGS);
    else out.push(PKGS);
  }
  if (!hasSite) out.push('import site');
  return out.join('\r\n') + '\r\n';
}

/** Assembles the embedded-Python tree (<tmpRoot>/python) from the base zip and the pinned wheels. */
async function assemblePython(entry, archive, tmpRoot) {
  const pyDir = join(tmpRoot, 'python');
  mkdirSync(pyDir, { recursive: true });
  bsdtar(['-xf', archive, '-C', pyDir]);
  const sp = join(pyDir, 'Lib', 'site-packages');
  mkdirSync(sp, { recursive: true });
  for (const w of entry.wheels) {
    const label = `${entry.id}/${w.file.split('-')[0]}`;
    const wheel = await fetchVerified(w, label);
    listSafe(label, wheel);
    bsdtar(['-xf', wheel, '-C', sp]);
  }
  const pth = readdirSync(pyDir).find((n) => n.toLowerCase().endsWith('._pth'));
  if (!pth) throw new Error(`${entry.id}: no ._pth file in the embeddable Python`);
  writeFileSync(join(pyDir, pth), patchPth(readFileSync(join(pyDir, pth), 'utf8')));
  return tmpRoot;
}

function runSmoke(entry, root) {
  if (!entry.smoke) return;
  const r = spawnSync(join(root, entry.exe), [...entry.smoke], { encoding: 'utf8', shell: false, timeout: 120000, cwd: root, windowsHide: true });
  if (r.error || r.status !== 0) {
    throw new Error(`${entry.id}: smoke test failed (${r.error ? r.error.message : 'exit ' + r.status}): ${((r.stderr || '') + (r.stdout || '')).trim()}`);
  }
  log(`${entry.id}: smoke test ok (${(r.stdout || '').trim()})`);
}

/** The firmware stamp is the "already installed" proof: same pinned version and sha256 as the manifest. */
export function firmwareStampOk(dest, fw) {
  try {
    const st = JSON.parse(readFileSync(join(dest, FW_STAMP), 'utf8'));
    return st.version === fw.version && st.sha256 === fw.sha256;
  } catch {
    return false;
  }
}

/** Installs the PS3 system software into <out>/rpcs3 via "rpcs3.exe --installfw". A failed install only warns and prints the manual command. */
async function installPs3Firmware(entry, outRoot) {
  const fw = entry.firmware;
  const dest = join(outRoot, entry.id);
  const marker = join(dest, ...fw.marker.split('/'));
  if (existsSync(marker) && firmwareStampOk(dest, fw)) {
    log(`${entry.id}: PS3 firmware ${fw.version} already installed`);
    return;
  }
  const exe = join(dest, entry.exe);
  if (!existsSync(exe)) throw new Error(`${entry.id}: ${exe} missing, cannot install firmware`);
  const pup = await fetchVerified(fw, `${entry.id}/firmware ${fw.version}`);
  log(`${entry.id}: installing PS3 firmware ${fw.version} (rpcs3 --installfw). RPCS3 shows an 'Install firmware?' dialog: click Yes (waits up to 10 min).`);
  const r = spawnSync(exe, ['--installfw', pup], { cwd: dest, shell: false, encoding: 'utf8', timeout: 600000 });
  if (!r.error && r.status === 0 && existsSync(marker)) {
    writeFileSync(join(dest, FW_STAMP), JSON.stringify({ version: fw.version, sha256: fw.sha256, installedAt: new Date().toISOString() }, null, 2) + '\n');
    log(`${entry.id}: PS3 firmware ${fw.version} installed`);
    return;
  }
  const why = r.error ? r.error.message : r.status !== 0 ? `exit ${r.status}` : 'exit 0 but firmware files not found';
  console.warn(`\nWARNING ${entry.id}: automatic firmware install did not complete (${why}). Install it manually:\n  "${exe}" --installfw "${pup}"\n  (or RPCS3: File > Install Firmware)\n`);
}

async function bundleOne(entry, { force, outRoot }) {
  const dest = join(outRoot, entry.id);

  if (!force && upToDate(entry, dest)) {
    log(`${entry.id}: up to date (${entry.version})`);
    return { id: entry.id, version: entry.version, size: dirSize(dest), skipped: true };
  }
  if (!canReplace(dest)) {
    throw new Error(`${entry.id}: ${dest} was not created by bundle-win (no ${STAMP}); remove it manually or pick another --out`);
  }
  const archive = await fetchVerified(entry, entry.id);
  const listing = listSafe(entry.id, archive);

  // Sibling of the output root (same volume, so the renames below never cross devices).
  const tmpRoot = join(dirname(outRoot), `.tmp-${entry.id}-${process.pid}`);
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });
  try {
    let srcRoot;
    let top = null;
    if (entry.kind === 'python') {
      srcRoot = await assemblePython(entry, archive, tmpRoot);
    } else {
      bsdtar(['-xf', archive, '-C', tmpRoot]);
      top = commonTopDir(listing);
      srcRoot = top ? join(tmpRoot, top) : tmpRoot;
    }
    const link = findSymlink(tmpRoot);
    if (link) throw new Error(`${entry.id}: archive contains a symlink (${link}), rejected`);
    if (!existsSync(srcRoot) || !statSync(srcRoot).isDirectory()) throw new Error(`${entry.id}: expected folder ${top} missing after extraction`);

    // Validate and stamp the extracted tree first, so the existing install is only touched once the new one is good.
    if (!existsSync(join(srcRoot, entry.exe))) {
      const real = readdirSync(srcRoot).find((n) => n.toLowerCase() === entry.exe.toLowerCase());
      throw new Error(real
        ? `${entry.id}: expected ${entry.exe} but the archive has ${real} (case differs; fix the manifest)`
        : `${entry.id}: ${entry.exe} not found at the top of the extracted archive`);
    }
    runSmoke(entry, srcRoot);
    writeFileSync(join(srcRoot, STAMP), JSON.stringify({ id: entry.id, file: entry.file, sha256: entry.sha256, version: entry.version, ...(entry.wheels ? { wheels: wheelSig(entry) } : {}), bundledAt: new Date().toISOString() }, null, 2) + '\n');

    mkdirSync(outRoot, { recursive: true });
    swapInto(srcRoot, dest, entry.keep);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  return { id: entry.id, version: entry.version, size: dirSize(dest), skipped: false };
}

async function main() {
  const force = process.argv.includes('--force');
  const withFirmware = process.argv.includes('--ps3-firmware');
  const outRoot = parseOutDir(process.argv.slice(2));
  if (withFirmware && isPackagingDir(outRoot)) {
    console.error(`--ps3-firmware is refused for the packaging directory (${outRoot}): Sony's PS3 firmware must never be shipped in the installer. Use e.g.: node scripts/bundle-win.mjs --out bin --ps3-firmware`);
    process.exit(1);
  }
  checkBsdtar();
  log(`output: ${outRoot}`);
  const results = [];
  const failures = [];
  for (const entry of MANIFEST) {
    try {
      results.push(await bundleOne(entry, { force, outRoot }));
      if (entry.firmware && withFirmware) await installPs3Firmware(entry, outRoot);
    } catch (e) {
      failures.push(entry.id);
      console.error(`\nERROR ${e.message}`);
    }
  }
  log('\nid        version         size');
  for (const r of results) log(`${r.id.padEnd(9)} ${r.version.padEnd(15)} ${mb(r.size)} MB${r.skipped ? ' (cached)' : ''}`);
  if (failures.length) {
    console.error(`\nFailed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
