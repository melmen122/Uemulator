'use strict';
// Windows (win32) behaviour, exercised from any host: every path is a win32 string compared as a string,
// fs/env/spawn are injected, and no real Windows tool is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const cores = require('../src/main/cores');
const ipc = require('../src/main/ipc');
const library = require('../src/main/library');
const { createStore } = require('../src/main/store');
const { createProcessManager, taskkillPath } = require('../src/main/processes');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. isExecutableFile ----
const fakeFs = (files, dirs = []) => ({
  statSync: (p) => {
    if (dirs.includes(p)) return { isFile: () => false, isDirectory: () => true };
    if (files.includes(p)) return { isFile: () => true, isDirectory: () => false };
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
  accessSync: () => undefined, // Windows reports X_OK for everything; the extension must decide
});

test('isExecutableFile win32: .exe/.EXE/.com are executable', () => {
  const files = ['C:\\a\\x.exe', 'C:\\a\\X.EXE', 'C:\\a\\old.com'];
  for (const f of files) assert.equal(cores.isExecutableFile(f, { fs: fakeFs(files), platform: 'win32' }), true, f);
});

test('isExecutableFile win32: .lnk/.bat/.cmd, directories and missing files are not', () => {
  const files = ['C:\\a\\x.lnk', 'C:\\a\\x.bat', 'C:\\a\\x.cmd', 'C:\\a\\noext'];
  const f = fakeFs(files, ['C:\\a\\dir.exe']);
  for (const p of [...files, 'C:\\a\\dir.exe', 'C:\\a\\missing.exe']) {
    assert.equal(cores.isExecutableFile(p, { fs: f, platform: 'win32' }), false, p);
  }
});

test('isExecutableFile posix: X_OK decides, extension does not', () => {
  const base = fakeFs(['/a/tool', '/a/tool.exe']);
  const noExec = { ...base, accessSync: () => { throw new Error('EACCES'); } };
  assert.equal(cores.isExecutableFile('/a/tool', { fs: base, platform: 'linux' }), true);
  assert.equal(cores.isExecutableFile('/a/tool.exe', { fs: noExec, platform: 'linux' }), false);
  assert.equal(cores.isExecutableFile('/a/tool.bat', { fs: fakeFs(['/a/tool.bat']), platform: 'linux' }), true);
  assert.equal(cores.isExecutableFile('/a/dir', { fs: fakeFs([], ['/a/dir']), platform: 'linux' }), false);
});

// ---- 2. defaultWhich on win32 ----
test('defaultWhich win32: PATHEXT .exe/.com honoured, .CMD/.BAT ignored', () => {
  const present = new Set(['C:\\t\\wine.CMD', 'C:\\t\\wine.BAT', 'C:\\u\\wine.COM', 'C:\\t\\tool.EXE']);
  const env = { PATH: 'C:\\t;C:\\u', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const existsSync = (p) => present.has(p);
  assert.equal(cores.defaultWhich('wine', { platform: 'win32', env, existsSync }), 'C:\\u\\wine.COM');
  assert.equal(cores.defaultWhich('tool', { platform: 'win32', env, existsSync }), 'C:\\t\\tool.EXE');
  present.delete('C:\\u\\wine.COM');
  assert.equal(cores.defaultWhich('wine', { platform: 'win32', env, existsSync }), null);
});

test('defaultWhich win32: quoted PATH entries work; bare name does not match an extension-less file', () => {
  const present = new Set(['C:\\Program Files\\Tool\\tool.EXE', 'C:\\bare\\tool']);
  const existsSync = (p) => present.has(p);
  const env = { PATH: '"C:\\Program Files\\Tool";C:\\bare' };
  assert.equal(cores.defaultWhich('tool', { platform: 'win32', env, existsSync }), 'C:\\Program Files\\Tool\\tool.EXE');
  present.delete('C:\\Program Files\\Tool\\tool.EXE');
  assert.equal(cores.defaultWhich('tool', { platform: 'win32', env, existsSync }), null);
});

test('defaultWhich win32: empty and path-like names never match', () => {
  assert.equal(cores.defaultWhich('', { platform: 'win32', env: { PATH: 'C:\\t' }, existsSync: () => true }), null);
  assert.equal(cores.defaultWhich('a\\b', { platform: 'win32', env: { PATH: 'C:\\t' }, existsSync: () => true }), null);
});

// ---- 3. win32 candidates() ----
const ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  SystemDrive: 'C:',
};
const ctx = (extra = {}) => ({ platform: 'win32', binDir: 'C:\\app\\bin', homedir: 'C:\\Users\\u', env: ENV, ...extra });

const EXPECT = {
  mgba: { built: 'C:\\app\\bin\\mgba\\bin\\mGBA.exe', sys: 'C:\\Program Files\\mGBA\\mGBA.exe' },
  azahar: { built: 'C:\\app\\bin\\azahar\\azahar.exe', sys: 'C:\\Program Files\\Azahar\\azahar.exe' },
  ryujinx: { built: 'C:\\app\\bin\\ryujinx\\Ryujinx.exe', sys: 'C:\\Program Files\\Ryujinx\\Ryujinx.exe' },
  rpcs3: { built: 'C:\\app\\bin\\rpcs3\\rpcs3.exe', sys: 'C:\\Program Files\\RPCS3\\rpcs3.exe' },
  project64: { built: 'C:\\app\\bin\\project64\\Project64.exe', sys: 'C:\\Program Files\\Project64 3.0\\Project64.exe' },
};

for (const [id, exp] of Object.entries(EXPECT)) {
  test(`${id} win32 candidates: built first, then Program Files, absolute win32 paths, no duplicates`, () => {
    const c = cores.getCore(id).candidates(ctx());
    assert.equal(c[0], exp.built);
    assert.ok(c.includes(exp.sys), `${exp.sys} in ${JSON.stringify(c)}`);
    assert.ok(c.indexOf(exp.built) < c.indexOf(exp.sys));
    assert.equal(new Set(c).size, c.length);
    for (const p of c) assert.match(p, /^[A-Za-z]:\\/, p);
    assert.ok(c.some((p) => p.startsWith('C:\\Users\\u\\AppData\\Local\\')), 'per-user install location');
    assert.ok(c.every((p) => !p.includes('/')), 'no posix separators');
  });

  test(`${id} win32 candidates: non-absolute / missing env bases are skipped`, () => {
    const bad = { ProgramFiles: 'Program Files', 'ProgramFiles(x86)': '', LOCALAPPDATA: '%LOCALAPPDATA%', SystemDrive: undefined };
    const c = cores.getCore(id).candidates(ctx({ env: bad, homedir: '' }));
    assert.deepEqual(c, [exp.built, ...c.slice(1)]);
    for (const p of c.slice(1)) assert.match(p, /^[A-Za-z]:\\/, p);
    assert.ok(!c.some((p) => /Program Files|%LOCALAPPDATA%/.test(p)), JSON.stringify(c));
    assert.deepEqual(cores.getCore(id).candidates(ctx({ env: {}, homedir: '', binDir: undefined })), []);
  });
}

test('mgba win32 candidates cover the cmake-install bin\\ layout and the unpacked-zip layout', () => {
  const c = cores.getCore('mgba').candidates(ctx());
  assert.deepEqual(c.slice(0, 3), ['C:\\app\\bin\\mgba\\bin\\mGBA.exe', 'C:\\app\\bin\\mgba\\mGBA.exe', 'C:\\app\\bin\\mgba\\mgba.exe']);
});

test('project64 win32 candidates include the official installer path', () => {
  assert.ok(cores.getCore('project64').candidates(ctx()).includes('C:\\Program Files (x86)\\Project64 3.0\\Project64.exe'));
});

test('project64 candidates are empty off win32', () => {
  assert.deepEqual(cores.getCore('project64').candidates({ platform: 'linux', binDir: '/b', homedir: '/h', env: {} }), []);
});

test('pyboy win32 has exactly one candidate: venv\\Scripts\\python.exe', () => {
  assert.deepEqual(cores.getCore('pyboy').candidates(ctx()), ['C:\\app\\bin\\pyboy\\venv\\Scripts\\python.exe']);
});

test('windows candidates resolve through resolveExecutable (built is source "built", Program Files is "system")', () => {
  const pj = cores.getCore('mgba');
  const deps = (present) => ({ platform: 'win32', binDir: 'C:\\app\\bin', homedir: 'C:\\Users\\u', env: ENV, existsSync: (p) => present.includes(p), which: () => null });
  const built = cores.resolveExecutable(pj, {}, deps(['C:\\app\\bin\\mgba\\bin\\mGBA.exe', 'C:\\Program Files\\mGBA\\mGBA.exe']));
  assert.deepEqual({ s: built.status, src: built.source, exe: built.exe }, { s: 'ready', src: 'built', exe: 'C:\\app\\bin\\mgba\\bin\\mGBA.exe' });
  const sys = cores.resolveExecutable(pj, {}, deps(['C:\\Program Files\\mGBA\\mGBA.exe']));
  assert.deepEqual({ src: sys.source, exe: sys.exe }, { src: 'system', exe: 'C:\\Program Files\\mGBA\\mGBA.exe' });
});

// ---- 4. Project64 on win32 ----
test('project64 win32: ready from an override .exe; wine is never used', () => {
  const pj = cores.getCore('project64');
  let whichCalls = 0;
  const r = cores.resolveExecutable(pj, { corePaths: { project64: 'C:\\Emus\\Project64.exe' } }, {
    platform: 'win32', binDir: 'C:\\app\\bin', homedir: 'C:\\Users\\u', env: {},
    existsSync: (p) => p === 'C:\\Emus\\Project64.exe',
    which: (n) => { whichCalls++; return n === 'wine' ? 'C:\\wine\\wine.exe' : null; },
  });
  assert.equal(r.status, 'ready');
  assert.equal(r.exe, 'C:\\Emus\\Project64.exe');
  assert.equal(r.source, 'override');
  assert.equal(r.wine, undefined);
  assert.equal(r.wineSource, undefined);
  assert.equal(whichCalls, 0);
});

test('project64 win32: missing exe is "missing" even when which(wine) is truthy', () => {
  const r = cores.resolveExecutable(cores.getCore('project64'), {}, {
    platform: 'win32', binDir: 'C:\\app\\bin', homedir: 'C:\\Users\\u', env: {}, existsSync: () => false, which: () => 'C:\\wine\\wine.exe',
  });
  assert.equal(r.status, 'missing');
  assert.equal(r.wine, undefined);
});

test('project64 win32 buildArgs: command is the exe, ROM last, no env, wine options ignored', () => {
  const pj = cores.getCore('project64');
  const out = pj.buildArgs('D:\\Roms\\Mario 64.z64', { exe: 'C:\\Emus\\Project64.exe', platform: 'win32', wine: 'C:\\wine\\wine.exe', prefixDir: 'C:\\p' });
  assert.deepEqual(out, { command: 'C:\\Emus\\Project64.exe', args: ['D:\\Roms\\Mario 64.z64'] });
  assert.equal('env' in out, false);
});

// ---- 5. validators ----
const dirFs = { statSync: () => ({ isDirectory: () => true, isFile: () => false }) };
const HOME = 'C:\\Users\\Me';
const folder = (p, extra = {}) => ipc.validateFolderPath(p, { fs: dirFs, platform: 'win32', homedir: HOME, ...extra });

test('validateFolderPath win32: refuses drive roots, home (case-insensitive, trailing slash) and device paths', () => {
  for (const bad of ['C:\\', 'd:\\', 'C:/', 'c:\\users\\me', 'C:\\USERS\\ME\\', 'C:\\Users\\Me\\', '\\\\?\\C:\\x', '\\\\.\\x', '\\\\?\\UNC\\nas\\roms']) {
    assert.throws(() => folder(bad), Error, bad);
  }
});

test('validateFolderPath win32: accepts normal folders and UNC shares', () => {
  assert.equal(folder('D:\\Roms'), 'D:\\Roms');
  assert.equal(folder('\\\\nas\\roms'), '\\\\nas\\roms\\'); // path.win32.resolve normalises a share root to a trailing slash
  assert.equal(folder('\\\\nas\\roms\\ps3'), '\\\\nas\\roms\\ps3');
  assert.equal(folder('C:\\Users\\Me\\Roms'), 'C:\\Users\\Me\\Roms');
});

test('validateFolderPath win32: relative, missing and non-directory paths are refused', () => {
  assert.throws(() => folder('roms'), /absolute/);
  assert.throws(() => folder('D:\\x', { fs: { statSync: () => { throw new Error('ENOENT'); } } }), /does not exist/);
  assert.throws(() => folder('D:\\x', { fs: { statSync: () => ({ isDirectory: () => false }) } }), /not a folder/);
});

const fileFs = (isDir = false) => ({ statSync: () => ({ isDirectory: () => isDir, isFile: () => !isDir }), accessSync: () => { throw new Error('X_OK must not matter'); } });
const corePath = (p, f = fileFs()) => ipc.validateCorePath(p, cores.getCore('mgba'), { fs: f, platform: 'win32' });

test('validateCorePath win32: accepts .exe/.EXE without an X_OK check', () => {
  assert.equal(corePath('C:\\Emus\\mGBA.exe'), 'C:\\Emus\\mGBA.exe');
  assert.equal(corePath('C:\\Emus\\MGBA.EXE'), 'C:\\Emus\\MGBA.EXE');
});

test('validateCorePath win32: refuses .lnk/.bat/.cmd and extension-less files with a readable message', () => {
  for (const bad of ['C:\\Emus\\mGBA.lnk', 'C:\\Emus\\run.bat', 'C:\\Emus\\run.cmd', 'C:\\Emus\\mgba']) {
    assert.throws(() => corePath(bad), /\.exe/, bad);
  }
});

test('validateCorePath win32: a folder (even named .app or .exe) is refused with a readable message', () => {
  for (const d of ['C:\\Emus', 'C:\\Emus\\mGBA.app', 'C:\\Emus\\dir.exe']) {
    assert.throws(() => corePath(d, fileFs(true)), /not a folder|\.exe/, d);
  }
  assert.throws(() => corePath('mGBA.exe'), /absolute/);
});

// ---- 6. IPC on win32 ----
function mkHandlers(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-win-'));
  const store = createStore({ dir });
  const h = ipc.createHandlers({ store, processes: {}, dialog: {}, shell: {}, getWindow: () => null, platform: 'win32', fs: dirFs, homedir: HOME, ...extra });
  return { h, store, dir };
}

test('win32 library:addFolder treats differently-cased paths as one folder', async () => {
  const { h, store, dir } = mkHandlers();
  try {
    await h['library:addFolder']('D:\\Roms');
    await h['library:addFolder']('d:\\roms');
    await h['library:addFolder']('D:\\ROMS\\');
    assert.deepEqual(store.getLibrary().folders, ['D:\\Roms']);
    await h['library:addFolder']('D:\\Other');
    assert.equal(store.getLibrary().folders.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('win32 library:removeFolder is case-insensitive', async () => {
  const { h, store, dir } = mkHandlers();
  try {
    await h['library:addFolder']('D:\\Roms');
    await h['library:addFolder']('D:\\Keep');
    await h['library:removeFolder']('d:\\ROMS');
    assert.deepEqual(store.getLibrary().folders, ['D:\\Keep']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('posix library:addFolder stays case-sensitive', async () => {
  const { h, store, dir } = mkHandlers({ platform: 'linux', homedir: '/home/me' });
  try {
    await h['library:addFolder']('/roms');
    await h['library:addFolder']('/ROMS');
    assert.deepEqual(store.getLibrary().folders, ['/roms', '/ROMS']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function registerWin(rendererUrl, platform = 'win32') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-win-'));
  const reg = {};
  ipc.registerIpc({ handle: (c, f) => { reg[c] = f; } }, {
    store: createStore({ dir }), processes: { list: () => ['ok'] }, dialog: {}, shell: {}, getWindow: () => null, platform, rendererUrl,
  });
  return { reg, dir };
}

test('win32 registerIpc: file URL differing only in case is accepted; others still rejected', () => {
  const { reg, dir } = registerWin('file:///C:/App/Renderer/index.html');
  try {
    const ok = (url) => reg['game:sessions']({ senderFrame: { url } });
    assert.deepEqual(ok('file:///C:/App/Renderer/index.html'), ['ok']);
    assert.deepEqual(ok('file:///c:/app/renderer/INDEX.html'), ['ok']);
    assert.deepEqual(ok('FILE:///c:/app/renderer/index.html#/x?y=1'.replace('FILE', 'file')), ['ok']);
    assert.throws(() => ok('http://c:/app/renderer/index.html'), Error);
    assert.throws(() => ok('http://localhost/index.html'), Error);
    assert.throws(() => ok('file:///C:/App/Renderer/other.html'), Error);
    assert.throws(() => reg['game:sessions']({ senderFrame: null }), Error);
    assert.throws(() => reg['game:sessions']({}), Error);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('posix registerIpc: URL case differences are rejected', () => {
  const { reg, dir } = registerWin('file:///app/Index.html', 'linux');
  try {
    assert.deepEqual(reg['game:sessions']({ senderFrame: { url: 'file:///app/Index.html' } }), ['ok']);
    assert.throws(() => reg['game:sessions']({ senderFrame: { url: 'file:///app/index.html' } }), Error);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 7. processes: taskkill ----
const SYSROOT = 'D:\\Win';
const TK = 'D:\\Win\\System32\\taskkill.exe';

function withSystemRoot(fn) {
  return async () => {
    const saved = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
    process.env.SystemRoot = SYSROOT;
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}

function gameChild(pid = 4242) {
  const c = new EventEmitter();
  c.pid = pid;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kills = [];
  c.kill = (sig) => { c.kills.push(sig); return true; };
  return c;
}

function tkChild() {
  const c = new EventEmitter();
  c.unref = () => {};
  return c;
}

/** Process manager whose first spawn is the game and later spawns are taskkill (recorded). */
async function setup({ platform = 'win32', pid = 4242, killGraceMs = 25, tkFactory = tkChild, spawnTk } = {}) {
  const game = gameChild(pid);
  const tkCalls = [];
  const tks = [];
  let first = true;
  const spawn = (cmd, args, o) => {
    if (first) { first = false; return game; }
    tkCalls.push({ cmd, args, o });
    if (spawnTk) return spawnTk(cmd, args, o);
    const t = tkFactory();
    tks.push(t);
    return t;
  };
  const pm = createProcessManager({ spawn, platform, killGraceMs, flushIntervalMs: 1 });
  const p = pm.start({ gameId: 'g', coreId: 'mgba', command: 'x', args: [] });
  game.emit('spawn');
  const { sessionId } = await p;
  return { pm, game, tkCalls, tks, sessionId };
}

test('taskkillPath is absolute under SystemRoot and never a bare name', () => {
  assert.equal(taskkillPath({ SystemRoot: 'D:\\Win' }), TK);
  assert.equal(taskkillPath({ windir: 'E:\\W' }), 'E:\\W\\System32\\taskkill.exe');
  assert.equal(taskkillPath({}), 'C:\\Windows\\System32\\taskkill.exe');
});

test('win32 stop: graceful taskkill /T first, then /T /F after killGraceMs', withSystemRoot(async () => {
  const { pm, game, tkCalls, sessionId } = await setup();
  assert.equal(pm.stop(sessionId), true);
  assert.equal(tkCalls.length, 1);
  assert.equal(tkCalls[0].cmd, TK);
  assert.deepEqual(tkCalls[0].args, ['/PID', '4242', '/T']);
  assert.equal(tkCalls[0].o.shell, false);
  assert.deepEqual(game.kills, [], 'child.kill is not used when taskkill starts');
  await sleep(80);
  assert.equal(tkCalls.length, 2);
  assert.equal(tkCalls[1].cmd, TK);
  assert.deepEqual(tkCalls[1].args, ['/PID', '4242', '/T', '/F']);
  assert.equal(tkCalls[1].o.shell, false);
  game.emit('close', 0, null);
}));

test('win32 stop: no forced taskkill once the game has exited within the grace period', withSystemRoot(async () => {
  const { pm, game, tkCalls, sessionId } = await setup();
  pm.stop(sessionId);
  game.emit('close', 0, null);
  await sleep(80);
  assert.equal(tkCalls.length, 1);
}));

test('win32 stop: a non-zero exit of the graceful taskkill escalates immediately', withSystemRoot(async () => {
  const { pm, game, tkCalls, tks, sessionId } = await setup();
  pm.stop(sessionId);
  assert.equal(tkCalls.length, 1);
  tks[0].emit('exit', 128);
  assert.equal(tkCalls.length, 2);
  assert.deepEqual(tkCalls[1].args, ['/PID', '4242', '/T', '/F']);
  game.emit('close', 0, null);
}));

test('win32 stop: a zero exit of the graceful taskkill does not escalate early', withSystemRoot(async () => {
  const { pm, game, tkCalls, tks, sessionId } = await setup();
  pm.stop(sessionId);
  tks[0].emit('exit', 0);
  assert.equal(tkCalls.length, 1);
  game.emit('close', 0, null);
}));

test('win32 stop: taskkill spawn error event falls back to child.kill()', withSystemRoot(async () => {
  const { pm, game, tks, sessionId } = await setup();
  pm.stop(sessionId);
  assert.deepEqual(game.kills, []);
  tks[0].emit('error', new Error('ENOENT'));
  assert.equal(game.kills.length, 1);
  game.emit('close', 0, null);
}));

test('win32 stop: taskkill spawn throwing falls back to child.kill() and does not throw', withSystemRoot(async () => {
  const { pm, game, sessionId } = await setup({ spawnTk: () => { throw new Error('EACCES'); } });
  assert.doesNotThrow(() => pm.stop(sessionId));
  assert.equal(game.kills.length, 1);
  game.emit('close', 0, null);
}));

test('win32 killAll forces taskkill /F after its timeout', withSystemRoot(async () => {
  const { pm, game, tkCalls } = await setup({ killGraceMs: 60000 });
  const done = pm.killAll(30);
  assert.deepEqual(tkCalls.map((c) => c.args), [['/PID', '4242', '/T']]);
  await done;
  assert.deepEqual(tkCalls.map((c) => c.args), [['/PID', '4242', '/T'], ['/PID', '4242', '/T', '/F']]);
  game.emit('close', 0, null);
}));

test('win32 killAll resolves without forcing when the game exits in time', withSystemRoot(async () => {
  const { pm, game, tkCalls } = await setup();
  const done = pm.killAll(2000);
  game.emit('close', 0, null);
  await done;
  assert.equal(tkCalls.length, 1);
}));

test('darwin/linux never spawn taskkill; SIGTERM then SIGKILL', withSystemRoot(async () => {
  for (const platform of ['darwin', 'linux']) {
    const { pm, game, tkCalls, sessionId } = await setup({ platform });
    pm.stop(sessionId);
    await sleep(80);
    assert.equal(tkCalls.length, 0, platform);
    assert.deepEqual(game.kills, ['SIGTERM', 'SIGKILL'], platform);
    game.emit('close', 0, null);
  }
}));

test('win32: a non-integer pid never reaches taskkill args (falls back to child.kill)', withSystemRoot(async () => {
  for (const pid of ['4242; calc', '4242', 4242.5, -1, 0, null, NaN]) {
    const game = gameChild(pid);
    const calls = [];
    const pm = createProcessManager({ spawn: (cmd, args) => { if (cmd === TK) { calls.push(args); return tkChild(); } return game; }, platform: 'win32', killGraceMs: 10, flushIntervalMs: 1 });
    const p = pm.start({ gameId: 'g', coreId: 'mgba', command: 'x', args: [] });
    game.emit('spawn');
    const { sessionId } = await p;
    pm.stop(sessionId);
    await sleep(40);
    assert.deepEqual(calls, [], `pid ${String(pid)}`);
    assert.ok(game.kills.length >= 1, `pid ${String(pid)} falls back to child.kill`);
    game.emit('close', 0, null);
  }
}));

// ---- 8. library ----
const dirent = (name, kind) => ({
  name,
  isDirectory: () => kind === 'dir',
  isFile: () => kind === 'file',
  isSymbolicLink: () => kind === 'link',
});

/** tree: dir -> [[name, kind]...]; real: path -> canonical path (default identity). */
function fakeLibFs(tree, real = {}, linkTargets = {}) {
  const reads = [];
  return {
    reads,
    realpathSync: (p) => real[p] || p,
    readdirSync: (p) => {
      reads.push(p);
      if (!tree[p]) throw new Error('ENOENT');
      return tree[p].map(([n, k]) => dirent(n, k));
    },
    statSync: (p) => {
      if (linkTargets[p] === 'dir') return { isDirectory: () => true, isFile: () => false, size: 0 };
      return { isDirectory: () => false, isFile: () => true, size: 7 };
    },
  };
}

test('library skips $RECYCLE.BIN and System Volume Information in any case', () => {
  const tree = {
    '/roms': [['$RECYCLE.BIN', 'dir'], ['$Recycle.Bin', 'dir'], ['System Volume Information', 'dir'], ['SYSTEM VOLUME INFORMATION', 'dir'], ['ok', 'dir']],
    '/roms/$RECYCLE.BIN': [['x.gba', 'file']],
    '/roms/$Recycle.Bin': [['x.gba', 'file']],
    '/roms/System Volume Information': [['x.gba', 'file']],
    '/roms/SYSTEM VOLUME INFORMATION': [['x.gba', 'file']],
    '/roms/ok': [['good.gba', 'file']],
  };
  const f = fakeLibFs(tree);
  const games = library.scanFolders(['/roms'], { fs: f });
  assert.deepEqual(games.map((g) => g.path), ['/roms/ok/good.gba']);
  assert.deepEqual(f.reads.sort(), ['/roms', '/roms/ok']);
});

test('library visits a symlink loop once', () => {
  const tree = { '/roms': [['loop', 'link'], ['a.gba', 'file']] };
  const f = fakeLibFs(tree, { '/roms/loop': '/roms' }, { '/roms/loop': 'dir' });
  const games = library.scanFolders(['/roms'], { fs: f });
  assert.deepEqual(games.map((g) => g.path), ['/roms/a.gba']);
  assert.deepEqual(f.reads, ['/roms']);
});

test('library on win32 counts a differently-cased duplicate directory once; on posix both are scanned', () => {
  const tree = {
    '/roms': [['one', 'dir'], ['two', 'dir']],
    '/roms/one': [['x.gba', 'file']],
    '/roms/two': [['x.gba', 'file']],
  };
  const real = { '/roms/one': '/roms/Shared', '/roms/two': '/roms/shared' };
  const win = library.scanFolders(['/roms'], { fs: fakeLibFs(tree, real), platform: 'win32' });
  assert.equal(win.length, 1);
  const posix = library.scanFolders(['/roms'], { fs: fakeLibFs(tree, real), platform: 'linux' });
  assert.equal(posix.length, 2);
});

test('library async scan applies the same win32 rules', async () => {
  const tree = {
    '/roms': [['one', 'dir'], ['two', 'dir'], ['$RECYCLE.BIN', 'dir']],
    '/roms/one': [['x.gba', 'file']],
    '/roms/two': [['x.gba', 'file']],
    '/roms/$RECYCLE.BIN': [['y.gba', 'file']],
  };
  const real = { '/roms/one': '/roms/Shared', '/roms/two': '/roms/shared' };
  const games = await library.scanFoldersAsync(['/roms'], { fs: fakeLibFs(tree, real), platform: 'win32' });
  assert.equal(games.length, 1);
});

// ---- 9. PID-reuse guard ----
test('win32: after the child emitted exit (before close) stop() returns true but spawns no taskkill', async () => {
  const { pm, game, tkCalls, sessionId } = await setup();
  game.emit('exit', 0, null);
  assert.equal(pm.stop(sessionId), true, 'session still registered until close');
  assert.equal(tkCalls.length, 0);
  await sleep(80); // the grace timer must not force-kill a possibly reused pid either
  assert.equal(tkCalls.length, 0);
  game.emit('close', 0, null);
});

test('win32: a graceful taskkill failing (128) after the child exited does not escalate to /F', async () => {
  const { pm, game, tkCalls, tks, sessionId } = await setup();
  pm.stop(sessionId);
  assert.equal(tkCalls.length, 1);
  game.emit('exit', 0, null);
  tks[0].emit('exit', 128);
  assert.equal(tkCalls.length, 1);
  await sleep(80);
  assert.equal(tkCalls.length, 1, 'no delayed /F either');
  game.emit('close', 0, null);
});

test('win32: killAll after exit-before-close spawns no taskkill', async () => {
  const { pm, game, tkCalls } = await setup({ killGraceMs: 60000 });
  game.emit('exit', 0, null);
  const done = pm.killAll(30);
  await sleep(60);
  assert.equal(tkCalls.length, 0);
  game.emit('close', 0, null);
  await done;
  assert.equal(tkCalls.length, 0);
});

test('win32: while the child is alive escalation is unchanged (graceful, immediate on failure)', async () => {
  const { pm, game, tkCalls, tks, sessionId } = await setup({ killGraceMs: 60000 });
  pm.stop(sessionId);
  tks[0].emit('exit', 128);
  assert.deepEqual(tkCalls.map((c) => c.args), [['/PID', '4242', '/T'], ['/PID', '4242', '/T', '/F']]);
  game.emit('close', 0, null);
});

// ---- 10. stop dedupe ----
test('win32: repeated stop() spawns one graceful taskkill and one escalation', async () => {
  const { pm, game, tkCalls, sessionId } = await setup();
  assert.equal(pm.stop(sessionId), true);
  assert.equal(pm.stop(sessionId), true);
  assert.equal(pm.stop(sessionId), true);
  assert.equal(tkCalls.length, 1);
  await sleep(80);
  assert.deepEqual(tkCalls.map((c) => c.args), [['/PID', '4242', '/T'], ['/PID', '4242', '/T', '/F']]);
  game.emit('close', 0, null);
});

test('posix: repeated stop() sends a single SIGTERM then a single SIGKILL', async () => {
  for (const platform of ['linux', 'darwin']) {
    const { pm, game, sessionId } = await setup({ platform });
    pm.stop(sessionId); pm.stop(sessionId); pm.stop(sessionId);
    assert.deepEqual(game.kills, ['SIGTERM'], platform);
    await sleep(80);
    assert.deepEqual(game.kills, ['SIGTERM', 'SIGKILL'], platform);
    game.emit('close', 0, null);
  }
});

// ---- 11. taskkillPath SystemRoot validation ----
test('taskkillPath honours an absolute drive-letter SystemRoot', () => {
  assert.equal(taskkillPath({ SystemRoot: 'D:\\Windows' }), 'D:\\Windows\\System32\\taskkill.exe');
});

test('taskkillPath falls back to C:\\Windows for relative, UNC, empty or unset SystemRoot', () => {
  const FALLBACK = 'C:\\Windows\\System32\\taskkill.exe';
  for (const v of ['..\\evil', 'Windows', '\\\\attacker\\share\\Windows', '', undefined, '   ']) {
    assert.equal(taskkillPath({ SystemRoot: v }), FALLBACK, JSON.stringify(v));
  }
  assert.equal(taskkillPath({}), FALLBACK);
});

// ---- 12. winpaths: no SystemDrive-root install guesses ----
test('mgba/azahar/ryujinx/rpcs3/project64 win32 candidates never sit directly under the drive root', () => {
  for (const id of Object.keys(EXPECT)) {
    const c = cores.getCore(id).candidates(ctx());
    assert.ok(!c.some((p) => /^C:\\[^\\]+\\[^\\]+$/.test(p) && !p.startsWith('C:\\Users')), `${id}: ${JSON.stringify(c)}`);
    assert.ok(!c.includes('C:\\RPCS3\\rpcs3.exe') && !c.includes('C:\\azahar\\azahar.exe'), id);
    assert.ok(c.some((p) => p.startsWith('C:\\Program Files\\')), id);
    assert.ok(c.some((p) => p.startsWith('C:\\Program Files (x86)\\')), id);
    assert.ok(c.some((p) => p.startsWith('C:\\Users\\u\\AppData\\Local\\Programs\\')), id);
    assert.ok(c.some((p) => p.startsWith('C:\\Users\\u\\AppData\\Local\\') && !p.includes('\\Programs\\')), id);
    assert.ok(c.some((p) => p.startsWith('C:\\Users\\u\\') && !p.startsWith('C:\\Users\\u\\AppData')), `${id} home-based`);
    assert.equal(c[0], EXPECT[id].built);
  }
});

// ---- 13. windowsHide ----
async function startHide(extra) {
  const game = gameChild();
  const calls = [];
  const pm = createProcessManager({ spawn: (cmd, args, o) => { calls.push(o); return game; }, platform: 'win32', flushIntervalMs: 1 });
  const p = pm.start({ gameId: 'g', coreId: 'x', command: 'x', args: [], ...extra });
  game.emit('spawn');
  await p;
  game.emit('close', 0, null);
  return calls[0];
}

test('processes.start passes windowsHide: true only when asked, always shell: false', async () => {
  const on = await startHide({ windowsHide: true });
  assert.equal(on.windowsHide, true);
  assert.equal(on.shell, false);
  const off = await startHide({});
  assert.equal(off.shell, false);
  assert.ok(!off.windowsHide, 'not set by default');
  assert.ok(!(await startHide({ windowsHide: false })).windowsHide);
});

test('only the pyboy adapter asks for windowsHide (core.windowsHide flag)', () => {
  assert.equal(cores.getCore('pyboy').windowsHide, true);
  for (const id of ['mgba', 'azahar', 'ryujinx', 'rpcs3', 'project64']) {
    assert.notEqual(cores.getCore(id).windowsHide, true, id);
  }
});

test('game:launch on win32 forwards windowsHide for pyboy but not for mgba', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-win-'));
  try {
    const store = createStore({ dir });
    const mk = (id, p, system) => ({ id, title: id, path: p, system, lastPlayed: null, favorite: false, size: 1 });
    store.setLibrary({ folders: [], games: [mk('abcdef012345', '/r/g.gb', 'gb'), mk('abcdef012346', '/r/g.gba', 'gba')] });
    const started = [];
    const PY = 'C:\\app\\bin\\pyboy\\venv\\Scripts\\python.exe';
    const MG = 'C:\\app\\bin\\mgba\\bin\\mGBA.exe';
    const h = ipc.createHandlers({
      store, processes: { start: async (x) => { started.push(x); return { pid: 1, sessionId: 's' }; }, list: () => [] },
      dialog: {}, shell: {}, getWindow: () => null, platform: 'win32', homedir: HOME,
      fs: { ...fs, statSync: (p) => ({ isFile: () => true, isDirectory: () => false }) },
      resolveDeps: { platform: 'win32', existsSync: (p) => p === PY || p === MG, which: () => null, binDir: 'C:\\app\\bin', homedir: HOME, env: {} },
    });
    await h['game:launch']('abcdef012345', { coreId: 'pyboy' });
    await h['game:launch']('abcdef012346', { coreId: 'mgba' });
    assert.equal(started[0].command, PY);
    assert.equal(started[0].windowsHide, true);
    assert.equal(started[1].command, MG);
    assert.ok(!started[1].windowsHide);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
