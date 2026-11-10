'use strict';
// scripts/bundle-win.mjs pure helpers, src/main/bundled.js, and the package.json wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const load = () => import(pathToFileURL(path.join(root, 'scripts', 'bundle-win.mjs')).href);
const pkg = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('bundledBinDir: packaged uses resources/emulators, otherwise appPath/bin', () => {
  const { bundledBinDir } = require('../src/main/bundled.js');
  assert.equal(bundledBinDir({ isPackaged: true, resourcesPath: '/r', appPath: '/a' }), path.join('/r', 'emulators'));
  assert.equal(bundledBinDir({ isPackaged: false, resourcesPath: '/r', appPath: '/a' }), path.join('/a', 'bin'));
  assert.equal(bundledBinDir({ isPackaged: true, resourcesPath: '', appPath: '/a' }), path.join('/a', 'bin'));
  assert.equal(bundledBinDir({ isPackaged: 'yes', resourcesPath: '/r', appPath: '/a' }), path.join('/a', 'bin'));
  assert.equal(bundledBinDir({ isPackaged: true, resourcesPath: undefined, appPath: '/a' }), path.join('/a', 'bin'));
  assert.doesNotThrow(() => bundledBinDir({}));
  assert.equal(bundledBinDir({}), path.join('', 'bin'));
});

test('MANIFEST shape and pinned values', async () => {
  const { MANIFEST } = await load();
  assert.ok(Object.isFrozen(MANIFEST));
  assert.deepEqual(MANIFEST.map((e) => e.id), ['lichii', 'mgba', 'azahar', 'rpcs3']);
  assert.deepEqual(MANIFEST.map((e) => e.exe), ['lichii.exe', 'mGBA.exe', 'azahar.exe', 'rpcs3.exe']);
  assert.deepEqual(MANIFEST.map((e) => e.format), ['zip', '7z', 'zip', '7z']);
  assert.deepEqual(MANIFEST.map((e) => e.version), ['build-130', '0.10.5', '2126.2', '0.0.43-20574']);
  assert.equal(new Set(MANIFEST.map((e) => e.id)).size, 4);
  for (const e of MANIFEST) {
    assert.ok(Object.isFrozen(e), e.id);
    for (const k of ['id', 'name', 'version', 'file', 'url', 'sha256', 'format', 'exe']) assert.equal(typeof e[k], 'string', `${e.id}.${k}`);
    assert.match(e.sha256, /^[0-9a-f]{64}$/, e.id);
    const u = new URL(e.url);
    assert.equal(u.protocol, 'https:');
    assert.equal(u.hostname, 'github.com');
    assert.ok(e.url.endsWith(e.file), e.id);
    assert.ok(e.file.endsWith('.' + e.format), e.id);
  }
  const by = Object.fromEntries(MANIFEST.map((e) => [e.id, e]));
  assert.equal(by.lichii.file, 'lichii-windows-x86_64-pgo.zip');
  assert.equal(by.lichii.sha256, 'e71515cea8009022b41f285d42483280f913869f0809869cfcd720da1a5de0b5');
  assert.equal(by.azahar.sha256, '4412eac8d13123c8840f11890fc26e5b0e4c76d16aa28a608941377b948a9db0');
  assert.equal(by.rpcs3.sha256, '12b36fbb6e0c44de8d8880d09d8b7c6d57a53b197741aae9948da0e82b54a7bc');
});

test('each manifest <id>/<exe> is where the win32 adapter looks in the bundled bin dir', async () => {
  const { MANIFEST } = await load();
  const binDir = 'C:\\app\\resources\\emulators';
  for (const e of MANIFEST) {
    const core = require(`../src/main/cores/${e.id}.js`);
    const c = core.candidates({ platform: 'win32', binDir, homedir: 'C:\\Users\\u', env: {} });
    assert.ok(c.includes(path.win32.join(binDir, e.id, e.exe)), `${e.id}: ${JSON.stringify(c)}`);
  }
});

test('output/cache subdirs', async () => {
  const m = await load();
  assert.equal(m.OUT_SUBDIR, 'bundle-win/emulators');
  assert.equal(m.CACHE_SUBDIR, 'bundle-win/cache');
});

test('isSafeEntry', async () => {
  const { isSafeEntry } = await load();
  for (const bad of ['', null, undefined, 5, '/etc/x', 'C:\\x', 'C:/x', '\\\\server\\share\\x', 'a/../b', '..\\x', 'a\\..\\b', 'a\0b']) {
    assert.equal(isSafeEntry(bad), false, JSON.stringify(bad));
  }
  for (const ok of ['dir/file.exe', 'file.exe', 'dir/sub dir/a..b.dll', 'dir/']) assert.equal(isSafeEntry(ok), true, ok);
});

test('commonTopDir', async () => {
  const { commonTopDir } = await load();
  assert.equal(commonTopDir(['app/', 'app/a.exe', 'app/lib/x.dll']), 'app');
  assert.equal(commonTopDir(['a.exe', 'lib/x.dll']), null);
  assert.equal(commonTopDir(['app/a.exe', 'other/b.exe']), null);
  assert.equal(commonTopDir([]), null);
  assert.equal(commonTopDir(['app\\a.exe', 'app\\lib\\x.dll']), 'app');
  assert.equal(commonTopDir(['__MACOSX/._a', 'app/a.exe']), 'app');
  assert.equal(commonTopDir(['desktop.ini', 'app/a.exe']), 'app');
});

test('sha256File hashes a file and rejects when missing', async () => {
  const { sha256File } = await load();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-bw-'));
  try {
    const f = path.join(d, 'f');
    fs.writeFileSync(f, 'abc');
    assert.equal(await sha256File(f), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    await assert.rejects(sha256File(path.join(d, 'missing')));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('importing does not run the CLI or create bundle-win in cwd', async () => {
  const { spawnSync } = require('node:child_process');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-bw-'));
  try {
    const href = pathToFileURL(path.join(root, 'scripts', 'bundle-win.mjs')).href;
    const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(href)}).then(m=>console.log(Object.keys(m).length))`], { cwd: d, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Number(r.stdout.trim()) > 0);
    assert.equal(fs.existsSync(path.join(d, 'bundle-win')), false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('package.json wiring', () => {
  const p = pkg();
  assert.equal(p.scripts['bundle:win'], 'node scripts/bundle-win.mjs');
  assert.ok(p.scripts['dist:win'].startsWith('npm run bundle:win'));
  assert.ok(p.scripts['dist:win'].endsWith('electron-builder --win nsis zip --x64'));
  const extra = p.build.win.extraResources;
  assert.ok(Array.isArray(extra) && extra.some((x) => x.from === 'bundle-win/emulators' && x.to === 'emulators'));
  for (const f of ['!bundle-win/**', '!bin/**', '!cores/**']) assert.ok(p.build.files.includes(f), f);
  assert.ok(!JSON.stringify(p.build.mac || {}).includes('extraResources'));
  assert.ok(!JSON.stringify(p.build.linux || {}).includes('extraResources'));
});

test('.gitignore ignores bundle-win/', () => {
  const lines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
  assert.ok(lines.includes('bundle-win/'));
});
