'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ipc = require('../src/main/ipc');
const { createStore } = require('../src/main/store');

const games = [{ id: 'abcdef012345', title: 'G', path: '/r/g.gba', system: 'gba' }];

test('validateGameId: type, format, membership', () => {
  assert.equal(ipc.validateGameId('abcdef012345', games), games[0]);
  for (const bad of [undefined, null, 5, {}, [], '', 'x'.repeat(100), 'ABCDEF012345', '../../etc/passwd', 'abcdef01234', 'abcdef0123456']) {
    assert.throws(() => ipc.validateGameId(bad, games), Error, String(bad));
  }
  assert.throws(() => ipc.validateGameId('000000000000', games), /library/);
  assert.throws(() => ipc.validateGameId('abcdef012345', []));
});

test('validateCoreId: known only', () => {
  assert.equal(ipc.validateCoreId('mgba').id, 'mgba');
  for (const bad of [undefined, null, 1, '', 'nes', 'MGBA', 'x'.repeat(100), '__proto__', 'constructor']) {
    assert.throws(() => ipc.validateCoreId(bad), Error, String(bad));
  }
});

test('validateAbsolutePath: rejects non-string, overlong, relative, NUL, empty', () => {
  assert.equal(ipc.validateAbsolutePath('/a/b/../c'), path.resolve('/a/c'));
  for (const bad of [undefined, null, 5, {}, [], '', 'rel/path', './x', '../x', 'x'.repeat(5000), '/a\0b']) {
    assert.throws(() => ipc.validateAbsolutePath(bad), Error, String(bad).slice(0, 20));
  }
  assert.throws(() => ipc.validateAbsolutePath('/' + 'a'.repeat(5000)));
});

test('validateFolderPath: must exist and be a directory', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-ipc-'));
  try {
    const f = path.join(d, 'f.txt');
    fs.writeFileSync(f, 'x');
    assert.equal(ipc.validateFolderPath(d), path.resolve(d));
    assert.throws(() => ipc.validateFolderPath(f), /not a folder/);
    assert.throws(() => ipc.validateFolderPath(path.join(d, 'nope')), /does not exist/);
    assert.throws(() => ipc.validateFolderPath('relative'));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('validateSessionId / validatePickKind', () => {
  assert.equal(ipc.validateSessionId('123e4567-e89b-12d3-a456-426614174000'), '123e4567-e89b-12d3-a456-426614174000');
  for (const bad of [undefined, 5, '', 'abc', '../..', '123e4567-e89b-12d3-a456-42661417400']) {
    assert.throws(() => ipc.validateSessionId(bad), Error);
  }
  assert.equal(ipc.validatePickKind('rom'), 'rom');
  assert.equal(ipc.validatePickKind('exe'), 'exe');
  for (const bad of ['folder', '', null, undefined, 'ROM']) assert.throws(() => ipc.validatePickKind(bad));
});

test('validateLaunchOptions: only coreId allowed', () => {
  assert.deepEqual(ipc.validateLaunchOptions(undefined), {});
  assert.deepEqual(ipc.validateLaunchOptions(null), {});
  assert.deepEqual(ipc.validateLaunchOptions({}), {});
  assert.deepEqual(ipc.validateLaunchOptions({ coreId: 'pyboy' }), { coreId: 'pyboy' });
  assert.throws(() => ipc.validateLaunchOptions({ command: 'rm' }));
  assert.throws(() => ipc.validateLaunchOptions({ exe: '/bin/sh' }));
  assert.throws(() => ipc.validateLaunchOptions({ coreId: 5 }));
  assert.throws(() => ipc.validateLaunchOptions('x'));
  assert.throws(() => ipc.validateLaunchOptions([]));
});

test('validateExternalUrl: http/https only', () => {
  assert.equal(ipc.validateExternalUrl('https://mgba.io'), 'https://mgba.io/');
  assert.equal(ipc.validateExternalUrl('http://example.com/a?b=1'), 'http://example.com/a?b=1');
  for (const bad of [
    'file:///etc/passwd', 'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,hi',
    'vscode://x', 'ms-msdt:/id', 'smb://host/share', 'ftp://example.com', 'about:blank',
    'mailto:a@b.c', '//example.com', 'example.com', '', ' ', 'not a url',
    5, null, undefined, {}, 'https://' + 'a'.repeat(3000),
  ]) {
    assert.throws(() => ipc.validateExternalUrl(bad), Error, String(bad).slice(0, 30));
  }
});

test('validateCorePath: absolute, exists, is executable file', { skip: process.platform === 'win32' }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-ipc-'));
  try {
    const core = ipc.validateCoreId('mgba');
    const exe = path.join(d, 'mgba'); fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
    const plain = path.join(d, 'plain'); fs.writeFileSync(plain, 'x', { mode: 0o644 });
    assert.equal(ipc.validateCorePath(exe, core), exe);
    assert.throws(() => ipc.validateCorePath(plain, core), /not executable/);
    assert.throws(() => ipc.validateCorePath(path.join(d, 'nope'), core), /does not exist/);
    assert.throws(() => ipc.validateCorePath('rel/mgba', core));
    assert.throws(() => ipc.validateCorePath(d, core), /\.app/); // plain directory
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('validateCorePath resolves a .app bundle to its inner executable', { skip: process.platform === 'win32' }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-ipc-'));
  try {
    const core = ipc.validateCoreId('mgba');
    const macos = path.join(d, 'mGBA.app', 'Contents', 'MacOS');
    fs.mkdirSync(macos, { recursive: true });
    fs.writeFileSync(path.join(macos, 'mGBA'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(ipc.validateCorePath(path.join(d, 'mGBA.app'), core), path.join(macos, 'mGBA'));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ---- handlers ----
function harness(extraGames = games, settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-ipc-'));
  const store = createStore({ dir });
  if (settings) store.setSettings(settings);
  store.setLibrary({ folders: [], games: extraGames.map((g) => ({ lastPlayed: null, favorite: false, size: 1, ...g })) });
  const started = [];
  const opened = [];
  const h = ipc.createHandlers({
    store,
    processes: { start: async (x) => { started.push(x); return { pid: 1, sessionId: 's' }; }, stop() {}, list: () => [] },
    dialog: {}, shell: { openExternal: async (u) => { opened.push(u); } }, getWindow: () => null,
    fs: { ...fs, statSync: (p) => (p === '/r/g.gba' || p === '/r/g.nsp' || p === '/r/g.z64' ? { isFile: () => true, isDirectory: () => false } : fs.statSync(p)) },
    platform: 'linux',
    resolveDeps: { existsSync: (p) => p === '/usr/bin/mgba-qt' || p === '/usr/bin/Ryujinx', platform: 'linux', which: () => null, binDir: '/nobin', homedir: '/h', env: {} },
  });
  return { h, store, started, opened, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('game:launch rejects unknown gameId, raw paths, and wrong coreId', async () => {
  const t = harness();
  try {
    await assert.rejects(t.h['game:launch']('000000000000'));
    await assert.rejects(t.h['game:launch']('/bin/sh'));
    await assert.rejects(t.h['game:launch']('abcdef012345', { coreId: 'nope' }));
    await assert.rejects(t.h['game:launch']('abcdef012345', { coreId: 'ryujinx' }), /cannot run/);
    await assert.rejects(t.h['game:launch']('abcdef012345', { coreId: 'project64' }), /cannot run/);
    await assert.rejects(t.h['game:launch']('abcdef012345', { command: '/bin/sh' }));
    assert.equal(t.started.length, 0);
  } finally { t.cleanup(); }
});

test('game:launch spawns resolved exe with ROM as a separate arg and stamps lastPlayed', async () => {
  const t = harness();
  try {
    const r = await t.h['game:launch']('abcdef012345');
    assert.deepEqual(r, { pid: 1, sessionId: 's' });
    assert.equal(t.started.length, 1);
    assert.equal(t.started[0].command, '/usr/bin/mgba-qt');
    assert.deepEqual(t.started[0].args, ['/r/g.gba']);
    assert.equal(typeof t.store.getLibrary().games[0].lastPlayed, 'number');
  } finally { t.cleanup(); }
});

test('game:launch passes fullscreen setting and reports missing core', async () => {
  const t = harness(games, { fullscreen: true });
  try {
    await t.h['game:launch']('abcdef012345');
    assert.deepEqual(t.started[0].args, ['-f', '/r/g.gba']);
    const t2 = harness([{ id: '111111111111', path: '/r/g.nsp', system: 'switch' }], { fullscreen: true });
    try {
      await t2.h['game:launch']('111111111111');
      assert.deepEqual(t2.started[0].args, ['--fullscreen', '/r/g.nsp']);
    } finally { t2.cleanup(); }
  } finally { t.cleanup(); }
});

test('game:launch with missing ROM file or uninstalled core throws readable error', async () => {
  const t = harness([{ id: '222222222222', path: '/r/gone.gba', system: 'gba' }]);
  try { await assert.rejects(t.h['game:launch']('222222222222'), /missing/); } finally { t.cleanup(); }
  const t2 = harness([{ id: '333333333333', path: '/r/g.gba', system: 'gba' }]);
  try {
    const h = ipc.createHandlers({
      store: t2.store, processes: { start: async () => { throw new Error('no'); } }, dialog: {}, shell: {}, getWindow: () => null,
      fs: { statSync: () => ({ isFile: () => true }) }, platform: 'linux',
      resolveDeps: { existsSync: () => false, platform: 'linux', which: () => null, binDir: '/n', homedir: '/h', env: {} },
    });
    await assert.rejects(h['game:launch']('333333333333'), /not installed/);
  } finally { t2.cleanup(); }
});

test('game:launch for n64 on linux without wine/exe reports not installed (wine hint)', async () => {
  const t = harness([{ id: '444444444444', path: '/r/g.z64', system: 'n64' }]);
  try { await assert.rejects(t.h['game:launch']('444444444444'), /not installed.*Wine|Wine/i); } finally { t.cleanup(); }
});

test('library:favorite toggles and persists; rejects unknown id', async () => {
  const t = harness();
  try {
    assert.equal(t.h['library:favorite']('abcdef012345').favorite, true);
    assert.equal(t.store.getLibrary().games[0].favorite, true);
    assert.equal(t.h['library:favorite']('abcdef012345').favorite, false);
    assert.throws(() => t.h['library:favorite']('000000000000'));
  } finally { t.cleanup(); }
});

test('shell:openExternal only forwards http(s)', async () => {
  const t = harness();
  try {
    assert.equal(await t.h['shell:openExternal']('https://mgba.io'), true);
    assert.deepEqual(t.opened, ['https://mgba.io/']);
    await assert.rejects(t.h['shell:openExternal']('file:///etc/passwd'));
    await assert.rejects(t.h['shell:openExternal']('javascript:alert(1)'));
    assert.equal(t.opened.length, 1);
  } finally { t.cleanup(); }
});

test('settings:set rejects unknown keys; cores:setPath rejects bad input', async () => {
  const t = harness();
  try {
    assert.throws(() => t.h['settings:set']({ evil: 1 }));
    assert.throws(() => t.h['cores:setPath']('nope', '/x'));
    assert.throws(() => t.h['cores:setPath']('mgba', 'relative'));
    assert.throws(() => t.h['cores:setPath']('mgba', 5));
    assert.equal(t.h['cores:setPath']('mgba', null).id, 'mgba');
    await assert.rejects(t.h['dialog:pickFile']('folder'));
    assert.throws(() => t.h['game:stop']('not-a-session'));
  } finally { t.cleanup(); }
});

test('library:addFolder rejects relative and missing paths', async () => {
  const t = harness();
  try {
    await assert.rejects(async () => t.h['library:addFolder']('relative'));
    await assert.rejects(async () => t.h['library:addFolder']('/definitely/not/here'));
    await assert.rejects(async () => t.h['library:addFolder'](5));
  } finally { t.cleanup(); }
});

test('registerIpc blocks calls from non-file frames', async () => {
  const t = harness();
  try {
    const reg = {};
    ipc.registerIpc({ handle: (c, f) => { reg[c] = f; } }, {
      store: t.store, processes: { list: () => [] }, dialog: {}, shell: {}, getWindow: () => null,
      rendererUrl: 'file:///app/index.html',
    });
    assert.deepEqual(reg['game:sessions']({ senderFrame: { url: 'file:///app/index.html' } }), []);
    assert.throws(() => reg['game:sessions']({ senderFrame: { url: 'https://evil.example/' } }), /untrusted/);
  } finally { t.cleanup(); }
});

// ---- project64 via wine on a fake darwin host ----
function wineHarness({ withWine = true, exeMode = 0o644 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-wine-'));
  const userData = path.join(dir, 'userData');
  fs.mkdirSync(userData);
  const exe = path.join(dir, 'My Games', 'Project64.exe');
  fs.mkdirSync(path.dirname(exe));
  fs.writeFileSync(exe, 'MZ', { mode: exeMode });
  const fakeWine = '/fake/wine/bin/wine';
  const store = createStore({ dir: userData });
  store.setSettings({ corePaths: { project64: exe } });
  store.setLibrary({ folders: [], games: [{ id: 'aaaaaaaaaaaa', title: 'N', path: '/r/g.z64', system: 'n64', lastPlayed: null, favorite: false, size: 1 }] });
  const started = [];
  const h = ipc.createHandlers({
    store,
    processes: { start: async (x) => { started.push(x); return { pid: 1, sessionId: 's' }; }, stop() {}, list: () => [] },
    dialog: {}, shell: {}, getWindow: () => null,
    fs: { ...fs, statSync: (p) => (p === '/r/g.z64' ? { isFile: () => true, isDirectory: () => false } : fs.statSync(p)) },
    platform: 'darwin',
    userDataDir: userData,
    resolveDeps: { platform: 'darwin', which: (n) => (withWine && n === 'wine' ? fakeWine : null), binDir: '/nobin', homedir: '/h', env: {} },
  });
  return { h, started, userData, exe, fakeWine, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('game:launch n64/project64 on darwin spawns wine with [exe, rom] and a prefix under userData', { skip: process.platform === 'win32' }, async () => {
  const t = wineHarness();
  try {
    assert.deepEqual(await t.h['game:launch']('aaaaaaaaaaaa', { coreId: 'project64' }), { pid: 1, sessionId: 's' });
    assert.equal(t.started.length, 1);
    const s = t.started[0];
    assert.equal(s.command, t.fakeWine);
    assert.deepEqual(s.args, [t.exe, '/r/g.z64']);
    assert.equal(s.env.WINEDEBUG, '-all');
    assert.equal(s.env.WINEDLLOVERRIDES, 'mscoree,mshtml=');
    const prefix = s.env.WINEPREFIX;
    assert.equal(typeof prefix, 'string');
    const rel = path.relative(t.userData, prefix);
    assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), `prefix ${prefix} inside userData`);
    assert.ok(fs.statSync(prefix).isDirectory());
    // default core for n64 also works without an explicit coreId
    await t.h['game:launch']('aaaaaaaaaaaa');
    assert.equal(t.started.length, 2);
    assert.equal(t.started[1].command, t.fakeWine);
  } finally { t.cleanup(); }
});

test('game:launch n64 without wine gives a readable Wine error and does not spawn', { skip: process.platform === 'win32' }, async () => {
  const t = wineHarness({ withWine: false });
  try {
    await assert.rejects(t.h['game:launch']('aaaaaaaaaaaa'), /Wine/);
    assert.equal(t.started.length, 0);
    assert.deepEqual(fs.readdirSync(t.userData).filter((n) => n === 'wine'), []); // no prefix created for a failed launch
  } finally { t.cleanup(); }
});

test('validateLaunchOptions still rejects env/args/extra/wine/prefixDir from the renderer', () => {
  for (const key of ['env', 'args', 'extra', 'wine', 'prefixDir', 'command']) {
    assert.throws(() => ipc.validateLaunchOptions({ coreId: 'project64', [key]: key === 'env' ? { WINEPREFIX: '/x' } : ['x'] }), Error, key);
  }
});

test('game:launch rejects renderer-supplied env and spawns nothing', { skip: process.platform === 'win32' }, async () => {
  const t = wineHarness();
  try {
    await assert.rejects(t.h['game:launch']('aaaaaaaaaaaa', { coreId: 'project64', env: { LD_PRELOAD: '/evil.so' } }));
    assert.equal(t.started.length, 0);
  } finally { t.cleanup(); }
});
