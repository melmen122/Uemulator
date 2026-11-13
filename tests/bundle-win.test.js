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
  assert.deepEqual(MANIFEST.map((e) => e.version), ['build-160', '0.10.5', '2126.2', '0.0.43-20574']);
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
  assert.equal(by.lichii.file, 'lichii-windows-x86_64.zip');
  assert.equal(by.lichii.url, 'https://github.com/zortos293/Lichii/releases/download/build-160/lichii-windows-x86_64.zip');
  assert.equal(by.lichii.sha256, '215459edfbd9f6c542b4548cabf4c16d487feca8ce1003a1094f9beda5f02460');
  assert.equal(by.azahar.sha256, '4412eac8d13123c8840f11890fc26e5b0e4c76d16aa28a608941377b948a9db0');
  assert.equal(by.rpcs3.sha256, '12b36fbb6e0c44de8d8880d09d8b7c6d57a53b197741aae9948da0e82b54a7bc');
});

test('parseOutDir: default, --out <dir>, --out=<dir>, missing value throws', async () => {
  const { parseOutDir } = await load();
  assert.equal(parseOutDir([]), path.resolve(root, 'bundle-win/emulators'));
  assert.equal(parseOutDir(['--out', 'bin']), path.resolve(root, 'bin'));
  assert.equal(parseOutDir(['--out=bin']), path.resolve(root, 'bin'));
  assert.throws(() => parseOutDir(['--out']), /--out needs a directory/);
  assert.throws(() => parseOutDir(['--out', '--other']), /--out needs a directory/);
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

test('parseOutDir: absolute path is returned as-is; empty --out= throws', async () => {
  const { parseOutDir } = await load();
  const abs = path.resolve(os.tmpdir(), 'uemu-out');
  assert.equal(parseOutDir(['--out', abs]), abs);
  assert.equal(parseOutDir(['--out=' + abs]), abs);
  assert.throws(() => parseOutDir(['--out=']), /--out needs a directory/);
});

test('tarCandidates: win32 is a single absolute System32 path, never a bare name', async () => {
  const { tarCandidates } = await load();
  assert.deepEqual(tarCandidates('win32', { SystemRoot: 'D:\\Win' }), ['D:\\Win\\System32\\tar.exe']);
  assert.deepEqual(tarCandidates('win32', {}), ['C:\\Windows\\System32\\tar.exe']);
  for (const env of [{}, { SystemRoot: 'D:\\Win' }, { SystemRoot: '' }]) {
    const c = tarCandidates('win32', env);
    assert.equal(c.length, 1);
    for (const x of c) assert.ok(path.win32.isAbsolute(x), x);
  }
  assert.deepEqual(tarCandidates('linux', {}), ['bsdtar']);
  assert.deepEqual(tarCandidates('darwin', {}), ['bsdtar']);
});

test('STAMP is the ownership marker filename', async () => {
  const { STAMP } = await load();
  assert.equal(typeof STAMP, 'string');
  assert.ok(STAMP.length > 0 && !/[\/]/.test(STAMP));
});

test('canReplace: only absent or stamped dirs may be replaced (no exe fallback)', async () => {
  const { canReplace, STAMP } = await load();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-bw-'));
  try {
    assert.equal(canReplace(path.join(d, 'nope')), true);
    assert.equal(canReplace(path.join(d, 'nope'), 'a.exe'), true);
    const user = path.join(d, 'user');
    fs.mkdirSync(user);
    fs.writeFileSync(path.join(user, 'saves.dat'), 'x');
    assert.equal(canReplace(user), false);
    assert.equal(canReplace(user, 'a.exe'), false);
    const stamped = path.join(d, 'stamped');
    fs.mkdirSync(stamped);
    fs.writeFileSync(path.join(stamped, STAMP), '{}');
    assert.equal(canReplace(stamped), true);
    assert.equal(canReplace(stamped, 'a.exe'), true);
    const legacy = path.join(d, 'legacy');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'rpcs3.exe'), 'x');
    assert.equal(canReplace(legacy), false);
    assert.equal(canReplace(legacy, 'rpcs3.exe'), false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('swapInto: backup-then-swap; user keep data wins, shipped-only files merged', async () => {
  const { swapInto } = await load();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-bw-'));
  const w = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
  const rd = (p) => fs.readFileSync(p, 'utf8');
  const noOld = (dest) => assert.deepEqual(
    fs.readdirSync(path.dirname(dest)).filter((n) => n.startsWith(path.basename(dest) + '.old-')), []);
  try {
    // (a) dest absent
    const ex1 = path.join(d, 'ex1'), dest1 = path.join(d, 'dest1');
    w(path.join(ex1, 'new.exe'), 'N');
    swapInto(ex1, dest1);
    assert.equal(rd(path.join(dest1, 'new.exe')), 'N');
    assert.equal(fs.existsSync(ex1), false);
    noOld(dest1);

    // (b) keep preserved, old files gone
    const ex2 = path.join(d, 'ex2'), dest2 = path.join(d, 'dest2');
    w(path.join(ex2, 'new.exe'), 'N2');
    w(path.join(dest2, 'old.exe'), 'O');
    w(path.join(dest2, 'config', 'x.txt'), 'mine');
    swapInto(ex2, dest2, ['config']);
    assert.equal(rd(path.join(dest2, 'new.exe')), 'N2');
    assert.equal(fs.existsSync(path.join(dest2, 'old.exe')), false);
    assert.equal(rd(path.join(dest2, 'config', 'x.txt')), 'mine');
    assert.equal(fs.existsSync(ex2), false);
    noOld(dest2);

    // (c) keep dir in both: user wins, shipped-only merged
    const ex3 = path.join(d, 'ex3'), dest3 = path.join(d, 'dest3');
    w(path.join(ex3, 'config', 'shared.txt'), 'shipped');
    w(path.join(ex3, 'config', 'shipped-only.txt'), 'S');
    w(path.join(dest3, 'config', 'shared.txt'), 'mine');
    w(path.join(dest3, 'config', 'user.yml'), 'U');
    swapInto(ex3, dest3, ['config']);
    assert.equal(rd(path.join(dest3, 'config', 'user.yml')), 'U');
    assert.equal(rd(path.join(dest3, 'config', 'shared.txt')), 'mine');
    assert.equal(rd(path.join(dest3, 'config', 'shipped-only.txt')), 'S');
    noOld(dest3);

    // (d) keep file in both: user wins
    const ex5 = path.join(d, 'ex5'), dest5 = path.join(d, 'dest5');
    w(path.join(ex5, 'qt.ini'), 'shipped');
    w(path.join(ex5, 'new.exe'), 'N5');
    w(path.join(dest5, 'qt.ini'), 'mine');
    swapInto(ex5, dest5, ['qt.ini']);
    assert.equal(rd(path.join(dest5, 'qt.ini')), 'mine');
    assert.equal(rd(path.join(dest5, 'new.exe')), 'N5');
    noOld(dest5);

    // (e) keep names absent from dest ignored
    const ex4 = path.join(d, 'ex4'), dest4 = path.join(d, 'dest4');
    w(path.join(ex4, 'new.exe'), 'N4');
    w(path.join(dest4, 'old.exe'), 'O');
    assert.doesNotThrow(() => swapInto(ex4, dest4, ['config', 'user']));
    assert.equal(rd(path.join(dest4, 'new.exe')), 'N4');
    assert.equal(fs.existsSync(path.join(dest4, 'config')), false);
    noOld(dest4);

    // (f) failure rolls back: extractedDir missing
    const dest6 = path.join(d, 'dest6');
    w(path.join(dest6, 'dev_hdd0', 'save.dat'), 'SAVE');
    w(path.join(dest6, 'rpcs3.exe'), 'E');
    assert.throws(() => swapInto(path.join(d, 'does-not-exist'), dest6, ['dev_hdd0']));
    assert.equal(rd(path.join(dest6, 'dev_hdd0', 'save.dat')), 'SAVE');
    assert.equal(rd(path.join(dest6, 'rpcs3.exe')), 'E');
    noOld(dest6);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('MANIFEST keep lists protect user data', async () => {
  const { MANIFEST } = await load();
  const by = Object.fromEntries(MANIFEST.map((e) => [e.id, e]));
  for (const k of ['config', 'GuiConfigs', 'dev_hdd0', 'dev_flash']) assert.ok(by.rpcs3.keep.includes(k), k);
  assert.ok(by.lichii.keep.includes('user'));
  assert.ok(by.mgba.keep.includes('config.ini'));
  assert.ok(by.mgba.keep.includes('qt.ini'));
});
