'use strict';
// Regression tests for the hardening pass: wine resolution, settings/corePaths trust, scan caps,
// folder validation, process error handling, IPC sender check, library sanitising.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const cores = require('../src/main/cores');
const ipc = require('../src/main/ipc');
const library = require('../src/main/library');
const { createStore } = require('../src/main/store');
const { createProcessManager } = require('../src/main/processes');

const posix = process.platform !== 'win32';
const mkdtemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-hard-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

// ---- 1. wine resolution with a non-executable (0644) .exe ----
test('project64 .exe override with mode 0644 is ready via wine on non-win32', { skip: !posix }, () => {
  const d = mkdtemp();
  try {
    const exe = path.join(d, 'Project64.exe');
    fs.writeFileSync(exe, 'MZ');
    fs.chmodSync(exe, 0o644);
    const wineDir = path.join(d, 'winebin');
    fs.mkdirSync(wineDir);
    fs.writeFileSync(path.join(wineDir, 'wine'), '#!/bin/sh\n', { mode: 0o755 });
    fs.chmodSync(path.join(wineDir, 'wine'), 0o755);
    const pj = cores.getCore('project64');
    const base = { platform: 'linux', binDir: '/nobin', homedir: '/h' };
    // real fs, real default which() over an injected PATH
    const r = cores.resolveExecutable(pj, { corePaths: { project64: exe } }, { ...base, env: { PATH: wineDir } });
    assert.equal(r.status, 'ready');
    assert.equal(r.exe, exe);
    assert.equal(r.source, 'override');
    assert.equal(r.wine, path.join(wineDir, 'wine'));
    assert.equal(r.wineSource, 'path');
    // injected which
    const r2 = cores.resolveExecutable(pj, { corePaths: { project64: exe } }, { ...base, env: {}, which: (n) => (n === 'wine' ? '/usr/bin/wine' : null) });
    assert.equal(r2.status, 'ready');
    // no wine anywhere -> missing (not unsupported)
    const r3 = cores.resolveExecutable(pj, { corePaths: { project64: exe } }, { ...base, env: { PATH: path.join(d, 'empty') } });
    assert.equal(r3.status, 'missing');
    assert.equal(r3.wine, null);
  } finally { rm(d); }
});

test('project64 wine path still requires the override to exist as a regular file', { skip: !posix }, () => {
  const d = mkdtemp();
  try {
    const pj = cores.getCore('project64');
    const deps = { platform: 'linux', binDir: '/nobin', homedir: '/h', env: {}, which: () => '/usr/bin/wine' };
    assert.equal(cores.resolveExecutable(pj, { corePaths: { project64: path.join(d, 'gone.exe') } }, deps).status, 'missing');
    fs.mkdirSync(path.join(d, 'dir.exe'));
    assert.equal(cores.resolveExecutable(pj, { corePaths: { project64: path.join(d, 'dir.exe') } }, deps).status, 'missing');
  } finally { rm(d); }
});

test('native core override that is a 0644 file is NOT ready', { skip: !posix }, () => {
  const d = mkdtemp();
  try {
    const f = path.join(d, 'mgba');
    fs.writeFileSync(f, 'x');
    fs.chmodSync(f, 0o644);
    const mgba = cores.getCore('mgba');
    const r = cores.resolveExecutable(mgba, { corePaths: { mgba: f } }, { binDir: '/nobin', homedir: d, env: {}, which: () => null });
    assert.notEqual(r.status, 'ready');
    fs.chmodSync(f, 0o755);
    const r2 = cores.resolveExecutable(mgba, { corePaths: { mgba: f } }, { binDir: '/nobin', homedir: d, env: {}, which: () => null });
    assert.deepEqual(r2, { status: 'ready', exe: f, source: 'override' });
  } finally { rm(d); }
});

// ---- 2. settings:set / corePaths trust ----
function handlerHarness() {
  const dir = mkdtemp();
  const store = createStore({ dir });
  const h = ipc.createHandlers({ store, processes: { list: () => [] }, dialog: {}, shell: {}, getWindow: () => null });
  return { dir, store, h };
}

test('settings:set rejects any corePaths patch and leaves settings unchanged', () => {
  const t = handlerHarness();
  try {
    const before = t.store.getSettings();
    for (const patch of [{ corePaths: { mgba: '/bin/sh' } }, { corePaths: {} }, { corePaths: { mgba: null } }, { fullscreen: true, corePaths: { mgba: '/bin/sh' } }]) {
      assert.throws(() => t.h['settings:set'](patch), (e) => e instanceof Error && e.message.length > 0, JSON.stringify(patch));
    }
    assert.deepEqual(t.store.getSettings(), before);
    assert.equal(t.store.getSettings().fullscreen, false); // mixed patch applied nothing
    assert.equal(fs.existsSync(t.store.file), false);
  } finally { rm(t.dir); }
});

test('settings:set still applies normal patches', () => {
  const t = handlerHarness();
  try {
    assert.equal(t.h['settings:set']({ fullscreen: true }).fullscreen, true);
    assert.equal(t.store.getSettings().fullscreen, true);
  } finally { rm(t.dir); }
});

test('store.load drops non-absolute corePaths from disk, keeps absolute ones', () => {
  const dir = mkdtemp();
  try {
    const abs = path.resolve('/opt/emu/mgba');
    fs.writeFileSync(path.join(dir, 'uemulator.json'), JSON.stringify({
      settings: { corePaths: { mgba: abs, pyboy: 'relative/pyboy', azahar: './azahar', ryujinx: 'ryujinx' } },
    }));
    const s = createStore({ dir }).getSettings();
    assert.equal(s.corePaths.mgba, abs);
    assert.equal(s.corePaths.pyboy, null);
    assert.equal(s.corePaths.azahar, null);
    assert.equal(s.corePaths.ryujinx, null);
  } finally { rm(dir); }
});

// ---- 3. library caps + async scan ----
function buildTree(root) {
  const touch = (rel, c = 'rom') => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  };
  touch('zeta.gba'); touch('Alpha.z64', '12345'); touch('a/b/mid.gb'); touch('c/Game_Two.nsp');
  touch('.hidden.gba'); touch('.cache/x.gba'); touch('node_modules/p/x.gba');
  touch('Foo.app/Contents/in.gba'); touch('notes.txt');
  touch(`${Array.from({ length: 15 }, (_, i) => `d${i}`).join('/')}/deep.gba`);
  try { fs.symlinkSync(root, path.join(root, 'a', 'loop'), 'dir'); } catch { /* ignore */ }
}

test('MAX_ENTRIES is exported as a positive integer', () => {
  assert.ok(Number.isInteger(library.MAX_ENTRIES) && library.MAX_ENTRIES > 0);
  assert.equal(typeof library.scanFoldersAsync, 'function');
});

test('scanFolders honors maxEntries cap without throwing and returns partial results', () => {
  const root = mkdtemp();
  try {
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, `g${i}.gba`), 'x');
    const all = library.scanFolders([root]);
    assert.equal(all.length, 20);
    let capped;
    assert.doesNotThrow(() => { capped = library.scanFolders([root], { maxEntries: 5 }); });
    assert.ok(capped.length > 0 && capped.length < 20, `got ${capped.length}`);
    const ids = new Set(all.map((g) => g.id));
    for (const g of capped) assert.ok(ids.has(g.id));
  } finally { rm(root); }
});

test('scanFoldersAsync matches scanFolders exactly on the same tree', async () => {
  const root = mkdtemp();
  try {
    buildTree(root);
    const sync = library.scanFolders([root, path.join(root, 'a')]);
    const asyn = await library.scanFoldersAsync([root, path.join(root, 'a')]);
    assert.ok(sync.length >= 4);
    assert.deepEqual(asyn, sync);
    const names = sync.map((g) => path.basename(g.path));
    assert.deepEqual(names.sort(), ['Alpha.z64', 'Game_Two.nsp', 'mid.gb', 'zeta.gba']); // skips dot/node_modules/.app/deep
    // preserves previous favorite/lastPlayed
    const prev = sync.map((g, i) => (i === 0 ? { ...g, favorite: true, lastPlayed: 42 } : g));
    const sync2 = library.scanFolders([root], { previous: prev });
    const asyn2 = await library.scanFoldersAsync([root], { previous: prev });
    assert.deepEqual(asyn2, sync2);
    const fav = asyn2.find((g) => g.id === prev[0].id);
    assert.equal(fav.favorite, true);
    assert.equal(fav.lastPlayed, 42);
  } finally { rm(root); }
});

test('scanFoldersAsync honors maxDepth and bad inputs like the sync scan', async () => {
  const root = mkdtemp();
  try {
    buildTree(root);
    assert.deepEqual(await library.scanFoldersAsync([root], { maxDepth: 0 }), library.scanFolders([root], { maxDepth: 0 }));
    assert.deepEqual(await library.scanFoldersAsync([path.join(root, 'missing'), 'rel', null, 5]), []);
    assert.deepEqual(await library.scanFoldersAsync(undefined), []);
  } finally { rm(root); }
});

test('scanFoldersAsync honors maxEntries cap without throwing', async () => {
  const root = mkdtemp();
  try {
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, `g${i}.gba`), 'x');
    const capped = await library.scanFoldersAsync([root], { maxEntries: 5 });
    assert.ok(capped.length > 0 && capped.length < 20, `got ${capped.length}`);
  } finally { rm(root); }
});

test('validateFolderPath refuses filesystem root and the home directory itself', () => {
  const home = mkdtemp();
  try {
    const sub = path.join(home, 'roms');
    fs.mkdirSync(sub);
    const opts = { homedir: home };
    assert.throws(() => ipc.validateFolderPath(path.parse(process.cwd()).root, opts), Error);
    assert.throws(() => ipc.validateFolderPath('/', opts), Error);
    assert.throws(() => ipc.validateFolderPath(home, opts), Error);
    assert.throws(() => ipc.validateFolderPath(home + path.sep, opts), Error);
    assert.equal(ipc.validateFolderPath(sub, opts), sub);
    const other = mkdtemp();
    try { assert.equal(ipc.validateFolderPath(other, opts), path.resolve(other)); } finally { rm(other); }
  } finally { rm(home); }
});

test('validateFolderPath refuses a Windows drive root on win32', () => {
  const fake = { statSync: () => ({ isDirectory: () => true }) };
  assert.throws(() => ipc.validateFolderPath('C:\\', { fs: fake, platform: 'win32', homedir: 'C:\\Users\\u' }), Error);
});

// ---- 4. processes: second 'error' after spawn ----
function fakeChild() {
  const c = new EventEmitter();
  c.pid = 4242;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => true;
  return c;
}

test('a second error event after spawn does not throw and the registry stays intact', async () => {
  const child = fakeChild();
  const events = [];
  const pm = createProcessManager({ spawn: () => child, emit: (e) => events.push(e), flushIntervalMs: 1 });
  const p = pm.start({ gameId: 'g', coreId: 'mgba', command: 'x', args: [] });
  child.emit('spawn');
  const { sessionId } = await p;
  assert.doesNotThrow(() => child.emit('error', new Error('first')));
  assert.doesNotThrow(() => child.emit('error', new Error('second')));
  assert.doesNotThrow(() => child.emit('error', new Error('third')));
  assert.equal(pm.size, 1);
  assert.deepEqual(pm.list().map((s) => s.sessionId), [sessionId]);
  child.emit('close', 0, null);
  assert.equal(pm.size, 0);
  assert.ok(events.some((e) => e.type === 'exit' && e.sessionId === sessionId));
});

test('start() settles once: error before spawn rejects, later spawn/error are harmless', async () => {
  const child = fakeChild();
  const pm = createProcessManager({ spawn: () => child });
  const p = pm.start({ gameId: 'g', coreId: 'mgba', command: 'x', args: [] });
  child.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' }));
  await assert.rejects(p, /not found/);
  assert.doesNotThrow(() => child.emit('error', new Error('again')));
  assert.equal(pm.size, 0);
  child.emit('close', 1, null);
  assert.equal(pm.size, 0);
});

// ---- 5. registerIpc sender check ----
function register(extra = {}) {
  const dir = mkdtemp();
  const store = createStore({ dir });
  const reg = {};
  ipc.registerIpc({ handle: (c, f) => { reg[c] = f; } }, {
    store, processes: { list: () => ['ok'] }, dialog: {}, shell: {}, getWindow: () => null, ...extra,
  });
  return { reg, dir };
}

test('registerIpc rejects missing/foreign/non-file senders', () => {
  const { reg, dir } = register();
  try {
    const bad = [
      undefined, null, {}, { senderFrame: null }, { senderFrame: undefined }, { senderFrame: {} }, { senderFrame: { url: undefined } },
      { senderFrame: { url: '' } }, { senderFrame: { url: 5 } },
      { senderFrame: { url: 'file:///tmp/evil.html' } },
      { senderFrame: { url: 'http://localhost/index.html' } },
      { senderFrame: { url: 'https://evil.example/' } },
    ];
    for (const ev of bad) assert.throws(() => reg['game:sessions'](ev), Error, JSON.stringify(ev));
  } finally { rm(dir); }
});

test('registerIpc accepts the app renderer URL with or without hash/query', () => {
  const rendererUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'index.html')).href;
  const { reg, dir } = register({ rendererUrl });
  try {
    for (const suffix of ['', '#/library', '?x=1', '?x=1#h']) {
      assert.deepEqual(reg['game:sessions']({ senderFrame: { url: rendererUrl + suffix } }), ['ok'], suffix);
    }
    assert.throws(() => reg['game:sessions']({ senderFrame: { url: rendererUrl.replace('index.html', 'other.html') } }));
  } finally { rm(dir); }
});

test('registerIpc default renderer URL is src/renderer/index.html', () => {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'index.html')).href;
  const { reg, dir } = register();
  try {
    assert.deepEqual(reg['game:sessions']({ senderFrame: { url: `${url}#x` } }), ['ok']);
  } finally { rm(dir); }
});

// ---- 6. sanitizeGames via library load ----
test('store load drops games with relative paths or extension/system mismatch', () => {
  const dir = mkdtemp();
  try {
    const good = { id: 'abcdef012345', title: 'Good', path: path.resolve('/x/a.gba'), system: 'gba', size: 1, lastPlayed: null, favorite: false };
    fs.writeFileSync(path.join(dir, 'uemulator.json'), JSON.stringify({
      library: { folders: [], games: [
        good,
        { ...good, id: '111111111111', path: 'rel/a.gba' },
        { ...good, id: '222222222222', path: path.resolve('/x/a.gba'), system: 'n64' },
        { ...good, id: '333333333333', path: path.resolve('/x/a.txt') },
        { ...good, id: '444444444444', path: path.resolve('/x/b.z64'), system: 'n64' },
      ] },
    }));
    const games = createStore({ dir }).getLibrary().games;
    assert.deepEqual(games.map((g) => g.id).sort(), ['444444444444', 'abcdef012345']);
  } finally { rm(dir); }
});

// ---- wine env allowlist in processes.start ----
async function startWith(env, hostEnv = {}) {
  const calls = [];
  const child = fakeChild();
  const pm = createProcessManager({ spawn: (cmd, args, o) => { calls.push({ cmd, args, o }); return child; } });
  const saved = {};
  for (const [k, v] of Object.entries(hostEnv)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const p = pm.start({ gameId: 'g', coreId: 'project64', command: 'wine', args: ['/p/Project64.exe', '/r/x.z64'], env });
    child.emit('spawn');
    await p;
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return calls[0];
}

test('processes.start passes allowlisted env merged over process.env, shell stays false', async () => {
  const c = await startWith({ WINEPREFIX: '/ud/wine/project64', WINEDEBUG: '-all', WINEDLLOVERRIDES: 'mscoree,mshtml=' }, { UEMU_TEST_MARKER: 'keep' });
  assert.equal(c.o.shell, false);
  assert.equal(c.o.env.WINEPREFIX, '/ud/wine/project64');
  assert.equal(c.o.env.WINEDEBUG, '-all');
  assert.equal(c.o.env.WINEDLLOVERRIDES, 'mscoree,mshtml=');
  assert.equal(c.o.env.UEMU_TEST_MARKER, 'keep'); // inherited env is preserved
  assert.deepEqual(c.args, ['/p/Project64.exe', '/r/x.z64']);
});

test('processes.start ignores non-allowlisted env keys and never passes loader-injection vars', async () => {
  const c = await startWith(
    { WINEDEBUG: '-all', LD_PRELOAD: '/evil.so', DYLD_INSERT_LIBRARIES: '/evil.dylib', PATH: '/evil', WINELOADER: '/evil' },
    { LD_PRELOAD: '/inherited.so', DYLD_INSERT_LIBRARIES: '/inherited.dylib' },
  );
  assert.equal(c.o.env.WINEDEBUG, '-all');
  assert.notEqual(c.o.env.PATH, '/evil');
  assert.notEqual(c.o.env.LD_PRELOAD, '/evil.so');
  assert.notEqual(c.o.env.DYLD_INSERT_LIBRARIES, '/evil.dylib');
  assert.notEqual(c.o.env.WINELOADER, '/evil');
  // inherited loader vars are stripped for env-carrying wine launches
  assert.equal(c.o.env.LD_PRELOAD, undefined);
  assert.equal(c.o.env.DYLD_INSERT_LIBRARIES, undefined);
});

test('processes.start without env (or with only bad keys) leaves the child env untouched', async () => {
  assert.equal((await startWith(undefined)).o.env, undefined);
  assert.equal((await startWith({ LD_PRELOAD: '/evil.so' })).o.env, undefined);
});

test('processes.start rejects non-string / NUL / non-object env values without spawning', async () => {
  for (const env of [{ WINEPREFIX: 5 }, { WINEPREFIX: 'a\0b' }, { WINEDEBUG: null }, { WINEDLLOVERRIDES: {} }, ['x'], 'x']) {
    let spawned = 0;
    const pm = createProcessManager({ spawn: () => { spawned++; return fakeChild(); } });
    await assert.rejects(pm.start({ gameId: 'g', coreId: 'project64', command: 'wine', args: [], env }), /Could not start|env/i, JSON.stringify(env));
    assert.equal(spawned, 0);
  }
});
