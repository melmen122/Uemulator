'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectSystem, getSystem, coreForSystem, coresForSystem, SYSTEMS } = require('../src/main/systems');
const rpcs3 = require('../src/main/cores/rpcs3');
const cores = require('../src/main/cores');
const { scanFolders, scanFoldersAsync } = require('../src/main/library');
const ipc = require('../src/main/ipc');
const { createStore } = require('../src/main/store');

const NASTY = [
  '/g/My Game/PS3_GAME/USRDIR/EBOOT.BIN',
  '/g/it\'s "quoted"/USRDIR/EBOOT.BIN',
  '/g/日本語 ゲーム/USRDIR/EBOOT.BIN',
  '/g/a; rm -rf ~ && echo $(whoami)/USRDIR/EBOOT.BIN',
  '-game.iso',
  '--no-gui',
];

// ---- systems ----
test('ps3 system is registered with rpcs3 as default core', () => {
  assert.equal(getSystem('ps3').name, 'PlayStation 3');
  assert.equal(coreForSystem('ps3', {}), 'rpcs3');
  assert.equal(coreForSystem('ps3', { gbCore: 'pyboy' }), 'rpcs3');
  assert.deepEqual(coresForSystem('ps3'), ['rpcs3']);
  assert.equal(SYSTEMS.length, 7);
});

test('detectSystem: .iso (any case) is ps3', () => {
  for (const p of ['/g/Game.iso', '/g/Game.ISO', '/g/Game.Iso']) assert.equal(detectSystem(p), 'ps3', p);
});

test('detectSystem: EBOOT.BIN in USRDIR (any case) is ps3', () => {
  for (const p of [
    '/g/Game/PS3_GAME/USRDIR/EBOOT.BIN',
    '/g/BLUS12345/USRDIR/eboot.bin',
    '/g/BLUS12345/usrdir/Eboot.Bin',
    '/g/BLUS12345/UsrDir/EBOOT.BIN',
  ]) assert.equal(detectSystem(p), 'ps3', p);
});

test('detectSystem: .pkg and other USRDIR files are not ps3', () => {
  for (const p of [
    '/g/Game.pkg', '/g/Game.PKG',
    '/g/BLUS12345/USRDIR/game.sprx', '/g/BLUS12345/USRDIR/EBOOT.self',
    '/g/BLUS12345/USRDIR/EBOOT.BIN.bak', '/g/BLUS12345/USRDIR/NOTEBOOT.BIN',
    '/g/BLUS12345/USRDIR/data.bin',
  ]) assert.equal(detectSystem(p), null, p);
});

test('detectSystem: EBOOT.BIN is matched by name anywhere (library scan alone enforces USRDIR)', () => {
  assert.equal(detectSystem('/g/EBOOT.BIN'), 'ps3');
  assert.equal(detectSystem('/g/Game/eboot.bin'), 'ps3');
});

test('detectSystem leaves existing systems unchanged', () => {
  assert.equal(detectSystem('/r/a.gba'), 'gba');
  assert.equal(detectSystem('/r/a.z64'), 'n64');
  assert.equal(detectSystem('/r/a.nsp'), 'switch');
  assert.equal(detectSystem('/r/a.3ds'), '3ds');
  assert.equal(detectSystem('/r/USRDIR/a.gb'), 'gb');
  assert.equal(detectSystem('/r/readme.txt'), null);
});

// ---- adapter ----
test('rpcs3 metadata', () => {
  assert.equal(rpcs3.id, 'rpcs3');
  assert.deepEqual(rpcs3.systems, ['ps3']);
  assert.equal(rpcs3.license, 'GPL-2.0');
  assert.ok(Array.isArray(rpcs3.platforms) && rpcs3.platforms.length > 0);
  assert.ok(Array.isArray(rpcs3.pathNames) && rpcs3.pathNames.length > 0);
});

test('rpcs3: boot path is its own argv element, last, intact', () => {
  const exe = '/usr/bin/rpcs3';
  for (const p of NASTY) {
    for (const fullscreen of [false, true]) {
      const r = rpcs3.buildArgs(p, { exe, fullscreen });
      assert.equal(r.command, exe);
      assert.ok(r.args.every((a) => typeof a === 'string'));
      assert.equal(r.args[r.args.length - 1], p);
      if (p !== '--no-gui') assert.equal(r.args.filter((a) => a === p).length, 1); // '--no-gui' collides with the real flag
    }
  }
});

test('rpcs3: fullscreen flag only when requested, before the path', () => {
  const exe = '/usr/bin/rpcs3';
  const p = '/g/x/USRDIR/EBOOT.BIN';
  const on = rpcs3.buildArgs(p, { exe, fullscreen: true }).args;
  const off = rpcs3.buildArgs(p, { exe, fullscreen: false }).args;
  const unset = rpcs3.buildArgs(p, { exe }).args;
  const fsFlags = on.filter((a) => /fullscreen/i.test(a));
  assert.ok(fsFlags.length >= 1, `expected a fullscreen flag in ${JSON.stringify(on)}`);
  assert.ok(on.indexOf(fsFlags[0]) < on.indexOf(p));
  assert.ok(!off.some((a) => /fullscreen/i.test(a)), JSON.stringify(off));
  assert.deepEqual(unset, off);
});

test('rpcs3: exact argv is --no-gui [--fullscreen] <path>', () => {
  const exe = '/usr/bin/rpcs3';
  assert.deepEqual(rpcs3.buildArgs('/r/x.iso', { exe }).args, ['--no-gui', '/r/x.iso']);
  assert.deepEqual(rpcs3.buildArgs('/r/x.iso', { exe, fullscreen: true }).args, ['--no-gui', '--fullscreen', '/r/x.iso']);
});

test('rpcs3: rejects empty/NUL/non-string path and missing exe; is pure', () => {
  const exe = '/usr/bin/rpcs3';
  assert.throws(() => rpcs3.buildArgs('', { exe }));
  assert.throws(() => rpcs3.buildArgs('a\0b', { exe }));
  assert.throws(() => rpcs3.buildArgs(null, { exe }));
  assert.throws(() => rpcs3.buildArgs('/r/x.iso', {}));
  const o = { exe, fullscreen: true };
  assert.deepEqual(rpcs3.buildArgs('/r/x.iso', o), rpcs3.buildArgs('/r/x.iso', o));
  assert.deepEqual(o, { exe, fullscreen: true });
});

test('rpcs3 candidates: built bin/rpcs3 first on every platform', () => {
  for (const platform of ['darwin', 'linux']) {
    const list = rpcs3.candidates({ platform, binDir: '/app/bin', homedir: '/Users/u', env: {} });
    assert.ok(list.length > 0);
    assert.ok(list.every((p) => typeof p === 'string' && p.startsWith('/')), platform);
    assert.ok(list[0].startsWith('/app/bin/rpcs3'), `${platform}: ${list[0]}`);
  }
  const w = rpcs3.candidates({ platform: 'win32', binDir: 'C:\\b', homedir: 'C:\\Users\\u', env: {} });
  assert.ok(w[0].startsWith('C:\\b\\rpcs3'), w[0]);
});

// ---- registry / resolution ----
test('registry lists six cores including rpcs3', () => {
  assert.equal(cores.CORES.length, 6);
  assert.deepEqual(cores.listCores().map((c) => c.id).sort(), ['azahar', 'mgba', 'project64', 'pyboy', 'rpcs3', 'ryujinx']);
  assert.equal(cores.getCore('rpcs3'), rpcs3);
  assert.equal(cores.describeCore(rpcs3, {}, { existsSync: () => false, platform: 'linux', which: () => null, binDir: '/n', homedir: '/h', env: {} }).license, 'GPL-2.0');
});

const mkDeps = (existing, extra = {}) => ({
  existsSync: (p) => existing.includes(p),
  platform: 'linux',
  which: () => null,
  binDir: '/app/bin',
  homedir: '/Users/u',
  env: {},
  ...extra,
});
const ctx = { platform: 'linux', binDir: '/app/bin', homedir: '/Users/u', env: {} };

test('rpcs3 resolveExecutable: override > built > system > PATH > missing', () => {
  const list = rpcs3.candidates(ctx);
  const built = list[0];
  const sys = list.find((p) => !p.startsWith('/app/bin/'));
  assert.ok(sys, 'a system candidate exists');

  assert.deepEqual(
    cores.resolveExecutable(rpcs3, { corePaths: { rpcs3: '/my/rpcs3' } }, mkDeps(['/my/rpcs3', built, sys])),
    { status: 'ready', exe: '/my/rpcs3', source: 'override' });
  assert.deepEqual(cores.resolveExecutable(rpcs3, {}, mkDeps([built, sys])), { status: 'ready', exe: built, source: 'built' });
  assert.deepEqual(cores.resolveExecutable(rpcs3, {}, mkDeps([sys], { which: () => '/p/rpcs3' })), { status: 'ready', exe: sys, source: 'system' });
  assert.deepEqual(cores.resolveExecutable(rpcs3, { corePaths: { rpcs3: '/gone' } }, mkDeps([sys])), { status: 'ready', exe: sys, source: 'system' });
  const name = rpcs3.pathNames[0];
  assert.deepEqual(cores.resolveExecutable(rpcs3, {}, mkDeps([], { which: (n) => (n === name ? '/somewhere/rpcs3' : null) })),
    { status: 'ready', exe: '/somewhere/rpcs3', source: 'path' });
  assert.deepEqual(cores.resolveExecutable(rpcs3, {}, mkDeps([])), { status: 'missing', exe: null, source: null });
});

// ---- library scan ----
let root;
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-ps3-')); });
test.afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const touch = (rel, content = 'x') => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};

test('scan: disc-folder EBOOT.BIN is one ps3 game titled from the game folder', () => {
  const eboot = touch('Demons_Souls/PS3_GAME/USRDIR/EBOOT.BIN', 'abc');
  touch('Demons_Souls/PS3_GAME/USRDIR/module.sprx');
  touch('Demons_Souls/PS3_GAME/USRDIR/boot.self');
  touch('Demons_Souls/PS3_GAME/USRDIR/data/readme.txt');
  const games = scanFolders([root]);
  assert.equal(games.length, 1, JSON.stringify(games));
  assert.equal(games[0].system, 'ps3');
  assert.equal(games[0].path, eboot);
  assert.equal(games[0].size, 3);
  assert.equal(games[0].title, 'Demons Souls');
  assert.doesNotMatch(games[0].title, /eboot/i);
});

test('scan: installed-style BLUS30001/USRDIR/EBOOT.BIN is titled from its folder, never EBOOT', () => {
  touch('BLUS30001/USRDIR/EBOOT.BIN');
  const [g] = scanFolders([root]);
  assert.equal(g.system, 'ps3');
  assert.equal(g.title, 'BLUS30001');
});

test('scan: corrupt PARAM.SFO falls back to a folder-derived title', () => {
  touch('BLUS30002/USRDIR/EBOOT.BIN');
  touch('BLUS30002/PARAM.SFO', 'not a real sfo');
  touch('Demons_Souls/PS3_GAME/USRDIR/EBOOT.BIN');
  touch('Demons_Souls/PS3_GAME/PARAM.SFO', Buffer.alloc(3));
  const games = scanFolders([root]);
  assert.deepEqual(games.map((g) => g.title).sort(), ['BLUS30002', 'Demons Souls']);
});

test('scan: .iso detected; .pkg and stray USRDIR files ignored', () => {
  const iso = touch('Disc_One.ISO');
  touch('Update.pkg');
  touch('Other/USRDIR/thing.sprx');
  touch('Other/USRDIR/EBOOT.self');
  touch('Loose/EBOOT.BIN');
  const games = scanFolders([root]);
  assert.deepEqual(games.map((g) => [g.path, g.system]), [[iso, 'ps3']]);
  assert.equal(games[0].title, 'Disc One');
});

test('scan: id is stable and previous favorite/lastPlayed are preserved for ps3', () => {
  touch('BLUS30001/USRDIR/EBOOT.BIN');
  const first = scanFolders([root]);
  first[0].favorite = true;
  first[0].lastPlayed = 42;
  const second = scanFolders([root], { previous: first });
  assert.equal(second[0].id, first[0].id);
  assert.equal(second[0].favorite, true);
  assert.equal(second[0].lastPlayed, 42);
});

test('scan: sync and async agree on a mixed tree', async () => {
  touch('Demons_Souls/PS3_GAME/USRDIR/EBOOT.BIN');
  touch('BLUS30001/USRDIR/eboot.bin');
  touch('Disc.iso');
  touch('Update.pkg');
  touch('gba/Pokemon.gba');
  touch('BLUS30001/USRDIR/x.sprx');
  const sync = scanFolders([root]);
  const asyn = await scanFoldersAsync([root]);
  assert.equal(sync.length, 4);
  assert.deepEqual(asyn, sync);
  assert.deepEqual(sync.map((g) => g.system).sort(), ['gba', 'ps3', 'ps3', 'ps3']);
});

// Minimal valid PARAM.SFO with a single UTF-8 TITLE entry.
function sfo(title, { fmt = 0x0204 } = {}) {
  const key = Buffer.from('TITLE\0');
  const data = Buffer.from(title + '\0');
  const keyStart = 20 + 16;
  const dataStart = keyStart + key.length;
  const b = Buffer.alloc(dataStart + data.length);
  b.writeUInt32BE(0x00505346, 0);
  b.writeUInt32LE(0x101, 4);
  b.writeUInt32LE(keyStart, 8);
  b.writeUInt32LE(dataStart, 12);
  b.writeUInt32LE(1, 16);
  b.writeUInt16LE(0, 20); b.writeUInt16LE(fmt, 22);
  b.writeUInt32LE(data.length, 24); b.writeUInt32LE(data.length, 28); b.writeUInt32LE(0, 32);
  key.copy(b, keyStart); data.copy(b, dataStart);
  return b;
}

test('scan: valid PARAM.SFO TITLE wins over the folder name (sync and async)', async () => {
  touch('BLUS30001/USRDIR/EBOOT.BIN');
  touch('BLUS30001/PARAM.SFO', sfo('Demon Souls Real Title'));
  assert.equal(scanFolders([root])[0].title, 'Demon Souls Real Title');
  assert.equal((await scanFoldersAsync([root]))[0].title, 'Demon Souls Real Title');
});

test('parseSfoTitle: valid, truncated and wrong-magic inputs', () => {
  const { parseSfoTitle } = require('../src/main/library');
  assert.equal(parseSfoTitle(sfo('Hello')), 'Hello');
  assert.equal(parseSfoTitle(sfo('Hello').subarray(0, 40)), null);
  const bad = sfo('Hello'); bad[1] = 0x58;
  assert.equal(parseSfoTitle(bad), null);
  assert.equal(parseSfoTitle(null), null);
  assert.equal(parseSfoTitle(Buffer.alloc(0)), null);
});

// ---- store ----
test('store: saved ps3 EBOOT.BIN game survives reload; wrong-system entries do not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-ps3-store-'));
  try {
    const eboot = '/g/BLUS12345/USRDIR/EBOOT.BIN';
    const st = createStore({ dir });
    st.setLibrary({ folders: [], games: [
      { id: 'abcdef012345', title: 'Ok', path: eboot, system: 'ps3', size: 1, lastPlayed: null, favorite: false },
      { id: 'abcdef012346', title: 'Iso', path: '/g/x.iso', system: 'ps3' },
      { id: 'abcdef012348', title: 'Wrong', path: eboot, system: 'gba' },
    ] });
    const lib = createStore({ dir }).getLibrary();
    assert.deepEqual(lib.games.map((g) => g.path).sort(), ['/g/BLUS12345/USRDIR/EBOOT.BIN', '/g/x.iso']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('store: corePaths includes rpcs3 defaulting to null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-ps3-store-'));
  try {
    const st = createStore({ dir });
    assert.equal(st.getSettings().corePaths.rpcs3, null);
    st.setSettings({ corePaths: { rpcs3: '/x/rpcs3' } });
    assert.equal(createStore({ dir }).getSettings().corePaths.rpcs3, '/x/rpcs3');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- IPC ----
const EBOOT = '/g/BLUS12345/USRDIR/EBOOT.BIN';
function harness(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-ps3-ipc-'));
  const store = createStore({ dir });
  if (settings) store.setSettings(settings);
  store.setLibrary({ folders: [], games: [
    { id: 'aaaaaaaaaaaa', title: 'P', path: EBOOT, system: 'ps3', size: 1, lastPlayed: null, favorite: false },
  ] });
  const started = [];
  const h = ipc.createHandlers({
    store,
    processes: { start: async (x) => { started.push(x); return { pid: 1, sessionId: 's' }; }, stop() {}, list: () => [] },
    dialog: {}, shell: {}, getWindow: () => null,
    fs: { ...fs, statSync: (p) => (p === EBOOT ? { isFile: () => true, isDirectory: () => false } : fs.statSync(p)) },
    platform: 'linux',
    resolveDeps: { existsSync: (p) => p === '/my/rpcs3', platform: 'linux', which: () => null, binDir: '/nobin', homedir: '/h', env: {} },
  });
  return { h, started, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('game:launch ps3 with rpcs3 spawns exe with boot path last; mgba is rejected', async () => {
  const t = harness({ corePaths: { rpcs3: '/my/rpcs3' } });
  try {
    await assert.rejects(t.h['game:launch']('aaaaaaaaaaaa', { coreId: 'mgba' }), /cannot run/);
    assert.equal(t.started.length, 0);
    await t.h['game:launch']('aaaaaaaaaaaa', { coreId: 'rpcs3' });
    assert.equal(t.started.length, 1);
    assert.equal(t.started[0].command, '/my/rpcs3');
    assert.equal(t.started[0].args[t.started[0].args.length - 1], EBOOT);
    await t.h['game:launch']('aaaaaaaaaaaa'); // default core is rpcs3
    assert.equal(t.started[1].command, '/my/rpcs3');
  } finally { t.cleanup(); }
});

test('game:launch ps3 fullscreen setting adds a fullscreen flag before the path', async () => {
  const t = harness({ corePaths: { rpcs3: '/my/rpcs3' }, fullscreen: true });
  try {
    await t.h['game:launch']('aaaaaaaaaaaa');
    const a = t.started[0].args;
    assert.ok(a.some((x) => /fullscreen/i.test(x)), JSON.stringify(a));
    assert.equal(a[a.length - 1], EBOOT);
  } finally { t.cleanup(); }
});
