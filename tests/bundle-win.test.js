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
  const { MANIFEST, ALLOWED_HOSTS } = await load();
  assert.ok(Object.isFrozen(MANIFEST));
  assert.deepEqual(MANIFEST.map((e) => e.id), ['lichii', 'mgba', 'azahar', 'rpcs3', 'ryujinx', 'pyboy']);
  assert.deepEqual(MANIFEST.map((e) => e.exe), ['lichii.exe', 'mGBA.exe', 'azahar.exe', 'rpcs3.exe', 'Ryujinx.exe', 'python/python.exe']);
  assert.deepEqual(MANIFEST.map((e) => e.format), ['zip', '7z', 'zip', '7z', 'zip', 'zip']);
  assert.deepEqual(MANIFEST.map((e) => e.version), ['build-160', '0.10.5', '2126.2', '0.0.43-20574', '1.3.3', '2.9.0']);
  assert.equal(new Set(MANIFEST.map((e) => e.id)).size, 6);
  // Every download is https from an allowlisted host and pinned by a 64-hex sha256.
  const checkArtifact = (a, label, httpHosts = []) => {
    assert.match(a.sha256, /^[0-9a-f]{64}$/, label);
    const u = new URL(a.url);
    assert.ok(u.protocol === 'https:' || (u.protocol === 'http:' && httpHosts.includes(u.hostname)), `${label}: ${a.url}`);
    assert.ok(ALLOWED_HOSTS.includes(u.hostname), `${label}: host ${u.hostname}`);
    assert.ok(a.url.endsWith(a.file), label);
  };
  for (const e of MANIFEST) {
    assert.ok(Object.isFrozen(e), e.id);
    for (const k of ['id', 'name', 'version', 'file', 'url', 'sha256', 'format', 'exe']) assert.equal(typeof e[k], 'string', `${e.id}.${k}`);
    checkArtifact(e, e.id);
    assert.ok(e.file.endsWith('.' + e.format), e.id);
    assert.ok(Array.isArray(e.keep), e.id);
    for (const w of e.wheels || []) {
      assert.ok(Object.isFrozen(w), `${e.id}/${w.file}`);
      checkArtifact(w, `${e.id}/${w.file}`);
      assert.ok(w.file.endsWith('.whl'), w.file);
    }
    if (e.firmware) checkArtifact(e.firmware, `${e.id}/firmware`, ['dus01.ps3.update.playstation.net']);
  }
  const by = Object.fromEntries(MANIFEST.map((e) => [e.id, e]));
  assert.equal(by.rpcs3.firmware.version, '4.93');
  assert.equal(by.rpcs3.firmware.file, 'PS3UPDAT.PUP');
  assert.equal(new URL(by.rpcs3.firmware.url).hostname, 'dus01.ps3.update.playstation.net');
  assert.equal(by.rpcs3.firmware.sha256, '158471fd834f8ea8036136b6aab43cd86c7ba73d79ca30e0af3c0fe0001cf365');
  assert.equal(by.rpcs3.firmware.marker, 'dev_flash/vsh/module/vsh.self');
  assert.equal(by.ryujinx.format, 'zip');
  assert.equal(new URL(by.ryujinx.url).hostname, 'git.ryujinx.app');
  assert.deepEqual([...by.ryujinx.keep], ['portable']);
  assert.equal(by.pyboy.kind, 'python');
  assert.equal(new URL(by.pyboy.url).hostname, 'www.python.org');
  assert.ok(by.pyboy.wheels.length >= 1);
  for (const w of by.pyboy.wheels) assert.equal(new URL(w.url).hostname, 'files.pythonhosted.org');
  assert.ok(by.pyboy.wheels.some((w) => w.file.startsWith('pyboy-2.9.0-')));
  assert.deepEqual([...by.pyboy.keep], []);
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
  assert.ok(by.ryujinx.keep.includes('portable'));
  assert.ok(by.rpcs3.keep.includes('dev_flash'), 'installed PS3 firmware must survive re-bundling');
});

test('ALLOWED_HOSTS is exactly the expected download hosts and is frozen', async () => {
  const { ALLOWED_HOSTS } = await load();
  assert.ok(Object.isFrozen(ALLOWED_HOSTS));
  assert.deepEqual([...ALLOWED_HOSTS].sort(), [
    'dus01.ps3.update.playstation.net', 'files.pythonhosted.org', 'git.ryujinx.app', 'github.com', 'www.python.org',
  ]);
});

test('patchPth: stock embeddable ._pth gains Lib\\site-packages and an active "import site"', async () => {
  const { patchPth } = await load();
  const stock = 'python313.zip\r\n.\r\n\r\n# Uncomment to run site.main() automatically\r\n#import site\r\n';
  const out = patchPth(stock);
  const lines = out.split(/\r?\n/).filter((l) => l !== '');
  assert.ok(lines.includes('Lib\\site-packages'), out);
  assert.ok(lines.includes('import site'), out);
  assert.ok(!lines.some((l) => /^#\s*import\s+site/.test(l)), out);
  assert.ok(lines.includes('python313.zip') && lines.includes('.'), 'original search paths kept');
  assert.equal(lines.filter((l) => l === 'import site').length, 1);
  // site-packages must precede "import site" (it is a path entry, not a statement)
  assert.ok(lines.indexOf('Lib\\site-packages') < lines.indexOf('import site'));
  assert.ok(out.endsWith('\r\n'));
});

test('patchPth is idempotent and also handles LF input and a missing import-site line', async () => {
  const { patchPth } = await load();
  const stock = 'python313.zip\n.\n# Uncomment to run site.main() automatically\n#import site\n';
  const once = patchPth(stock);
  assert.equal(patchPth(once), once);
  assert.equal(patchPth(patchPth(once)), once);
  const bare = patchPth('python313.zip\n.\n');
  const lines = bare.split(/\r?\n/).filter((l) => l !== '');
  assert.deepEqual(lines, ['python313.zip', '.', 'Lib\\site-packages', 'import site']);
  assert.equal(patchPth(bare), bare);
});

test('constants: REDIRECT_HOSTS, MAX_REDIRECTS, FW_STAMP', async () => {
  const { REDIRECT_HOSTS, ALLOWED_HOSTS, MAX_REDIRECTS, FW_STAMP } = await load();
  assert.ok(Object.isFrozen(REDIRECT_HOSTS));
  assert.deepEqual([...REDIRECT_HOSTS], [...ALLOWED_HOSTS, 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
  assert.equal(MAX_REDIRECTS, 5);
  assert.equal(FW_STAMP, '.uemulator-ps3fw.json');
  assert.ok(pkg().build.win.extraResources[0].filter.includes('!**/' + FW_STAMP));
});

test('rpcs3 MANIFEST keep includes the firmware stamp', async () => {
  const { MANIFEST, FW_STAMP } = await load();
  assert.ok(MANIFEST.find((e) => e.id === 'rpcs3').keep.includes(FW_STAMP));
});

test('checkSource: allowlist and scheme rules', async () => {
  const { checkSource, REDIRECT_HOSTS } = await load();
  const f = 'x';
  assert.throws(() => checkSource({ file: f, url: 'https://evil.example.com/a' }), /allowlist/);
  assert.throws(() => checkSource({ file: f, url: 'http://github.com/a' }), /non-https/);
  assert.throws(() => checkSource({ file: f, url: 'http://git.ryujinx.app/a' }), /non-https/);
  assert.doesNotThrow(() => checkSource({ file: f, url: 'https://github.com/a' }));
  assert.doesNotThrow(() => checkSource({ file: f, url: 'http://dus01.ps3.update.playstation.net/a' }));
  const cdn = { file: f, url: 'https://objects.githubusercontent.com/a' };
  assert.throws(() => checkSource(cdn), /allowlist/);
  assert.doesNotThrow(() => checkSource(cdn, REDIRECT_HOSTS));
});

test('fetchChecked: redirects are manual, re-validated per hop, and bounded', async () => {
  const { fetchChecked, MAX_REDIRECTS } = await load();
  const res = (status, loc) => ({ status, headers: { get: (n) => (n.toLowerCase() === 'location' ? loc ?? null : null) } });
  const seq = (...rs) => {
    const calls = [];
    const fn = async (url, opts) => { calls.push([url, opts]); return rs[Math.min(calls.length - 1, rs.length - 1)]; };
    fn.calls = calls;
    return fn;
  };
  const item = { file: 'x', url: 'https://github.com/a/b' };

  const direct = seq(res(200));
  const r0 = await fetchChecked(item, direct);
  assert.equal(r0.status, 200);
  assert.equal(direct.calls.length, 1);
  assert.deepEqual(direct.calls[0], [item.url, { redirect: 'manual' }]);

  const hop = seq(res(302, 'https://release-assets.githubusercontent.com/z'), res(200));
  const r1 = await fetchChecked(item, hop);
  assert.equal(r1.status, 200);
  assert.deepEqual(hop.calls.map((c) => c[0]), [item.url, 'https://release-assets.githubusercontent.com/z']);
  for (const c of hop.calls) assert.deepEqual(c[1], { redirect: 'manual' });

  const rel = seq(res(301, '/other/path'), res(200));
  await fetchChecked(item, rel);
  assert.equal(rel.calls[1][0], 'https://github.com/other/path');

  const bad = seq(res(302, 'https://evil.example.com/p'), res(200));
  await assert.rejects(fetchChecked(item, bad), /allowlist/);
  assert.equal(bad.calls.length, 1);

  await assert.rejects(fetchChecked(item, seq(res(302, 'http://objects.githubusercontent.com/p'))), /downgrade/);
  await assert.rejects(fetchChecked(item, seq(res(302))), /without a Location/);

  const loop = seq(res(302, 'https://github.com/a/b'));
  await assert.rejects(fetchChecked(item, loop), /too many redirects/);
  assert.equal(loop.calls.length, MAX_REDIRECTS + 1);

  // exactly MAX_REDIRECTS hops then a 200 still succeeds
  const rs = Array.from({ length: MAX_REDIRECTS }, () => res(302, 'https://github.com/a/b')).concat(res(200));
  assert.equal((await fetchChecked(item, seq(...rs))).status, 200);

  // https -> http is allowed only to the Sony host
  const sony = seq(res(302, 'http://dus01.ps3.update.playstation.net/f'), res(200));
  assert.equal((await fetchChecked(item, sony)).status, 200);
});

test('firmwareStampOk: only a stamp matching version and sha256 counts', async () => {
  const { firmwareStampOk, FW_STAMP } = await load();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-bw-'));
  const fw = { version: '4.93', sha256: 'a'.repeat(64) };
  try {
    assert.equal(firmwareStampOk(d, fw), false, 'no stamp');
    fs.writeFileSync(path.join(d, FW_STAMP), JSON.stringify({ version: '4.93', sha256: 'a'.repeat(64) }));
    assert.equal(firmwareStampOk(d, fw), true);
    fs.writeFileSync(path.join(d, FW_STAMP), JSON.stringify({ version: '4.92', sha256: 'a'.repeat(64) }));
    assert.equal(firmwareStampOk(d, fw), false, 'version mismatch');
    fs.writeFileSync(path.join(d, FW_STAMP), JSON.stringify({ version: '4.93', sha256: 'b'.repeat(64) }));
    assert.equal(firmwareStampOk(d, fw), false, 'sha mismatch');
    fs.writeFileSync(path.join(d, FW_STAMP), '{not json');
    assert.equal(firmwareStampOk(d, fw), false, 'malformed');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('isPackagingDir: only the bundle-win/emulators output dir', async () => {
  const { isPackagingDir } = await load();
  assert.equal(isPackagingDir(path.resolve(root, 'bundle-win/emulators')), true);
  assert.equal(isPackagingDir(path.resolve(root, 'bin')), false);
  assert.equal(isPackagingDir(path.resolve(root, 'bundle-win')), false);
  assert.equal(isPackagingDir(path.resolve(root, 'bundle-win/emulators/rpcs3')), true, 'inside the packaging dir');
  assert.equal(isPackagingDir(path.resolve(root, 'bundle-win/cache')), false);
  assert.equal(isPackagingDir(path.resolve(root, 'bundle-win/emulators-other')), false);
  if (process.platform === 'win32') assert.equal(isPackagingDir(path.resolve(root, 'BUNDLE-WIN/Emulators')), true);
});

test('--ps3-firmware is handled inside main() only; --no-ps3-firmware is not exported anywhere', async () => {
  const m = await load();
  for (const k of ['parseNoFirmware', 'parseArgs', 'noPs3Firmware', 'parsePs3Firmware']) assert.equal(typeof m[k], 'undefined', k);
});

test('package.json win extraResources filter excludes RPCS3 runtime data and user dirs', () => {
  const entry = pkg().build.win.extraResources.find((x) => x.from === 'bundle-win/emulators');
  assert.ok(entry.filter.includes('**/*'));
  for (const f of ['rpcs3/dev_flash/**', 'rpcs3/dev_hdd0/**', 'rpcs3/log/**', '**/.uemulator-ps3fw.json', 'lichii/user/**', 'ryujinx/portable/**']) {
    assert.ok(entry.filter.includes('!' + f), f);
  }
});
