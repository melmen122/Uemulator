// Fetches the official Windows x64 builds of the bundled emulators and lays them out in
// bundle-win/emulators/<id>/ so electron-builder can ship them as extraResources.
//
//   node scripts/bundle-win.mjs [--force]
//
// Archives are SHA-256 verified before extraction, listed and path-checked, extracted with
// bsdtar (argument arrays, no shell) and never executed.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const OUT_SUBDIR = 'bundle-win/emulators';
export const CACHE_SUBDIR = 'bundle-win/cache';
const STAMP = '.uemulator-bundle.json';

export const MANIFEST = Object.freeze([
  Object.freeze({
    id: 'lichii',
    name: 'Lichii',
    version: 'build-130',
    file: 'lichii-windows-x86_64-pgo.zip',
    url: 'https://github.com/zortos293/Lichii/releases/download/build-130/lichii-windows-x86_64-pgo.zip',
    sha256: 'e71515cea8009022b41f285d42483280f913869f0809869cfcd720da1a5de0b5',
    format: 'zip',
    exe: 'lichii.exe',
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

function bsdtar(args) {
  const r = spawnSync('bsdtar', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: false });
  if (r.error) throw new Error(`bsdtar failed to run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`bsdtar ${args[0]} exited ${r.status}: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

function checkBsdtar() {
  const r = spawnSync('bsdtar', ['--version'], { encoding: 'utf8', shell: false });
  if (r.error || r.status !== 0) {
    throw new Error('bsdtar was not found on PATH. It ships with macOS and Windows 10+; on Linux install libarchive-tools (bsdtar).');
  }
}

async function download(entry, cachePath) {
  const res = await fetch(entry.url, { redirect: 'follow' });
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
      process.stdout.write(`\r  ${entry.id}: ${pct >= 0 ? pct + '% ' : ''}${mb(got)}${total ? ' / ' + mb(total) : ''} MB   `);
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

function upToDate(entry, dest) {
  const s = readStamp(dest);
  return !!s && s.file === entry.file && s.sha256 === entry.sha256 && s.version === entry.version && existsSync(join(dest, entry.exe));
}

async function bundleOne(entry, { force }) {
  const outRoot = join(ROOT, OUT_SUBDIR);
  const cacheDir = join(ROOT, CACHE_SUBDIR);
  const dest = join(outRoot, entry.id);

  if (!force && upToDate(entry, dest)) {
    log(`${entry.id}: up to date (${entry.version})`);
    return { id: entry.id, version: entry.version, size: dirSize(dest), skipped: true };
  }
  if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`${entry.id}: manifest sha256 is not pinned`);

  mkdirSync(cacheDir, { recursive: true });
  const archive = join(cacheDir, entry.file);

  let have = existsSync(archive) ? await sha256File(archive) : null;
  if (have !== entry.sha256) {
    if (have) log(`${entry.id}: cached archive hash differs, re-downloading`);
    log(`${entry.id}: downloading ${entry.url}`);
    await download(entry, archive);
    have = await sha256File(archive);
    if (have !== entry.sha256) {
      rmSync(archive, { force: true });
      throw new Error(`${entry.id}: SHA-256 mismatch, archive deleted.\n  expected ${entry.sha256}\n  actual   ${have}`);
    }
  } else {
    log(`${entry.id}: using cached ${entry.file}`);
  }

  const listing = bsdtar(['-tf', archive]).split(/\r?\n/).filter((l) => l !== '');
  const bad = listing.filter((p) => !isSafeEntry(p));
  if (bad.length) throw new Error(`${entry.id}: unsafe archive entries rejected (${bad.length}), e.g. ${JSON.stringify(bad[0])}`);

  const tmpRoot = join(ROOT, 'bundle-win', `.tmp-${entry.id}-${process.pid}`);
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });
  try {
    bsdtar(['-xf', archive, '-C', tmpRoot]);
    const link = findSymlink(tmpRoot);
    if (link) throw new Error(`${entry.id}: archive contains a symlink (${link}), rejected`);

    const top = commonTopDir(listing);
    const srcRoot = top ? join(tmpRoot, top) : tmpRoot;
    if (!existsSync(srcRoot) || !statSync(srcRoot).isDirectory()) throw new Error(`${entry.id}: expected folder ${top} missing after extraction`);

    mkdirSync(outRoot, { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(srcRoot)) renameSync(join(srcRoot, name), join(dest, name));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  if (!existsSync(join(dest, entry.exe))) {
    const real = readdirSync(dest).find((n) => n.toLowerCase() === entry.exe.toLowerCase());
    throw new Error(real
      ? `${entry.id}: expected ${entry.exe} but the archive has ${real} (case differs; fix the manifest)`
      : `${entry.id}: ${entry.exe} not found at the top of ${dest}`);
  }

  writeFileSync(join(dest, STAMP), JSON.stringify({ id: entry.id, file: entry.file, sha256: entry.sha256, version: entry.version, bundledAt: new Date().toISOString() }, null, 2) + '\n');
  return { id: entry.id, version: entry.version, size: dirSize(dest), skipped: false };
}

async function main() {
  const force = process.argv.includes('--force');
  checkBsdtar();
  const results = [];
  const failures = [];
  for (const entry of MANIFEST) {
    try {
      results.push(await bundleOne(entry, { force }));
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
