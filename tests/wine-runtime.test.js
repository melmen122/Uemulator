'use strict';
// Wine runtime resolution (built / userData runtime / PATH), prefix creation order in game:launch,
// and the processes.js exit-vs-close handling.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { resolveExecutable, getCore } = require('../src/main/cores');
const ipc = require('../src/main/ipc');
const { createStore } = require('../src/main/store');
const { createProcessManager } = require('../src/main/processes');

const posix = process.platform !== 'win32';
const pj = getCore('project64');
const BIN = '/app/bin';
const UD = '/ud';
const PJ = '/x/Project64.exe';
const BUILT = `${BIN}/wine/bin/wine`;
const RUNTIME = `${UD}/runtime/wine/bin/wine`;
const deps = (existing, extra = {}) => ({
  existsSync: (p) => existing.includes(p), platform: 'darwin', which: () => null,
  binDir: BIN, userDataDir: UD, homedir: '/h', env: {}, ...extra,
});
const settings = { corePaths: { project64: PJ } };

// ---- 1. resolveExecutable wineSource ----
test('wineCandidates: built first, then userData runtime; unset dirs skipped', () => {
  assert.deepEqual(pj.wineCandidates({ binDir: BIN, userDataDir: UD }), [BUILT, RUNTIME]);
  assert.deepEqual(pj.wineCandidates({ binDir: BIN }), [BUILT]);
  assert.deepEqual(pj.wineCandidates({ userDataDir: UD }), [RUNTIME]);
  assert.deepEqual(pj.wineCandidates({}), []);
});

test('wineSource runtime when only the userData candidate exists (binDir nonexistent)', () => {
  const r = resolveExecutable(pj, settings, deps([PJ, RUNTIME], { binDir: '/nonexistent/bin' }));
  assert.equal(r.status, 'ready');
  assert.equal(r.wine, RUNTIME);
  assert.equal(r.wineSource, 'runtime');
});

test('built wins over runtime when both exist', () => {
  const r = resolveExecutable(pj, settings, deps([PJ, BUILT, RUNTIME]));
  assert.equal(r.wine, BUILT);
  assert.equal(r.wineSource, 'built');
});

test('runtime wins over PATH wine', () => {
  const r = resolveExecutable(pj, settings, deps([PJ, RUNTIME], { which: () => '/usr/bin/wine' }));
  assert.equal(r.wine, RUNTIME);
  assert.equal(r.wineSource, 'runtime');
});

test('path wine when no bundled candidate exists', () => {
  const r = resolveExecutable(pj, settings, deps([PJ], { which: (n) => (n === 'wine' ? '/usr/bin/wine' : null) }));
  assert.equal(r.status, 'ready');
  assert.equal(r.wine, '/usr/bin/wine');
  assert.equal(r.wineSource, 'path');
});

test('no wine anywhere: missing with build:cores detail (darwin) and apt hint (linux)', () => {
  const a = resolveExecutable(pj, settings, deps([PJ]));
  assert.equal(a.status, 'missing');
  assert.equal(a.wine, null);
  assert.equal(a.wineSource, null);
  assert.match(a.detail, /npm run build:cores -- project64/);
  const b = resolveExecutable(pj, settings, deps([PJ], { platform: 'linux' }));
  assert.equal(b.status, 'missing');
  assert.match(b.detail, /Wine not found/);
});

test('userDataDir undefined/empty/non-string is ignored without throwing', () => {
  for (const bad of [undefined, '', null, 5, {}, [], true]) {
    let r;
    assert.doesNotThrow(() => { r = resolveExecutable(pj, settings, deps([PJ, RUNTIME], { userDataDir: bad })); }, String(bad));
    assert.equal(r.status, 'missing', String(bad));
    assert.equal(r.wine, null);
  }
  const ok = resolveExecutable(pj, settings, deps([PJ, BUILT], { userDataDir: '' }));
  assert.equal(ok.wineSource, 'built');
});

test('linux: runtime wine resolves too', () => {
  const r = resolveExecutable(pj, settings, deps([PJ, RUNTIME], { platform: 'linux' }));
  assert.equal(r.status, 'ready');
  assert.equal(r.wineSource, 'runtime');
});

test('real fs: .exe override at 0644 is required and accepted; wine must be executable', { skip: !posix }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-wine-'));
  try {
    const ud = path.join(d, 'ud');
    const wine = path.join(ud, 'runtime', 'wine', 'bin', 'wine');
    fs.mkdirSync(path.dirname(wine), { recursive: true });
    fs.writeFileSync(wine, '#!/bin/sh\n', { mode: 0o755 });
    const exe = path.join(d, 'Project64.exe');
    fs.writeFileSync(exe, 'MZ', { mode: 0o644 });
    const base = { platform: 'linux', which: () => null, binDir: path.join(d, 'nobin'), userDataDir: ud, homedir: d, env: {} };
    const ok = resolveExecutable(pj, { corePaths: { project64: exe } }, base);
    assert.equal(ok.status, 'ready');
    assert.equal(ok.exe, exe);
    assert.equal(ok.wine, wine);
    assert.equal(ok.wineSource, 'runtime');
    // Without any override the user-supplied .exe is still required.
    const noExe = resolveExecutable(pj, {}, base);
    assert.equal(noExe.status, 'missing');
    assert.equal(noExe.exe, null);
    // A non-executable wine is not a candidate.
    fs.chmodSync(wine, 0o644);
    assert.equal(resolveExecutable(pj, { corePaths: { project64: exe } }, base).status, 'missing');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ---- 2. ipc game:launch prefix creation ----
function launchHarness(romPath, resolveExtra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-pfx-'));
  const userDataDir = path.join(dir, 'userData');
  fs.mkdirSync(userDataDir);
  const store = createStore({ dir: path.join(dir, 'store') });
  store.setLibrary({ folders: [], games: [{ id: 'abcdef012345', title: 'G', path: romPath, system: 'n64', lastPlayed: null, favorite: false, size: 1 }] });
  const started = [];
  const realFs = { ...fs, statSync: (p) => (p === romPath ? { isFile: () => true, isDirectory: () => false } : fs.statSync(p)) };
  const h = ipc.createHandlers({
    store,
    processes: { start: async (x) => { started.push(x); return { pid: 1, sessionId: 's' }; }, stop() {}, list: () => [] },
    dialog: {}, shell: {}, getWindow: () => null, fs: realFs, platform: 'darwin', userDataDir,
    resolveDeps: {
      existsSync: (p) => p === PJ || p === '/usr/bin/wine', platform: 'darwin',
      which: (n) => (n === 'wine' ? '/usr/bin/wine' : null), binDir: '/nobin', userDataDir, homedir: '/h', env: {}, ...resolveExtra,
    },
  });
  store.setSettings({ corePaths: { project64: PJ } });
  return { h, started, userDataDir, prefix: path.join(userDataDir, 'wine', 'project64'), store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('game:launch (wine core): buildArgs failure creates no prefix directory', async () => {
  const t = launchHarness('/r/g.z64', { which: (n) => (n === 'wine' ? '/usr/bin/wi\0ne' : null) });
  try {
    await assert.rejects(t.h['game:launch']('abcdef012345', { coreId: 'project64' }), /Invalid wine path/);
    assert.equal(t.started.length, 0);
    assert.equal(fs.existsSync(path.join(t.userDataDir, 'wine')), false);
    assert.equal(fs.existsSync(t.prefix), false);
  } finally { t.cleanup(); }
});

test('game:launch (wine core): ROM path with NUL is rejected and no prefix is created', async () => {
  const t = launchHarness('/r/g\0.z64');
  try {
    await assert.rejects(t.h['game:launch']('abcdef012345', { coreId: 'project64' }), /Invalid ROM path/);
    assert.equal(t.started.length, 0);
    assert.equal(fs.existsSync(path.join(t.userDataDir, 'wine')), false);
  } finally { t.cleanup(); }
});

test('game:launch (wine core): success creates the prefix with mode 0700 and passes WINEPREFIX', async () => {
  const t = launchHarness('/r/g.z64');
  try {
    await t.h['game:launch']('abcdef012345', { coreId: 'project64' });
    assert.equal(t.started.length, 1);
    assert.equal(t.started[0].command, '/usr/bin/wine');
    assert.deepEqual(t.started[0].args, [PJ, '/r/g.z64']);
    assert.equal(t.started[0].env.WINEPREFIX, t.prefix);
    const st = fs.statSync(t.prefix);
    assert.ok(st.isDirectory());
    if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o700);
  } finally { t.cleanup(); }
});

// ---- 3. processes: exit without close ----
function fakeChild() {
  const c = new EventEmitter();
  c.pid = 77;
  const mk = () => { const s = new EventEmitter(); s.destroyed = false; s.destroy = () => { s.destroyed = true; }; s.setEncoding = () => {}; return s; };
  c.stdout = mk();
  c.stderr = mk();
  c.kill = () => true;
  return c;
}
const GRACE = 20; // tiny exitCloseGraceMs so the fallback path is fast
async function started() {
  const child = fakeChild();
  const events = [];
  const pm = createProcessManager({ spawn: () => child, emit: (e) => events.push(e), flushIntervalMs: 1, exitCloseGraceMs: GRACE });
  const p = pm.start({ gameId: 'g', coreId: 'project64', command: 'wine', args: [] });
  child.emit('spawn');
  const { sessionId } = await p;
  return { child, events, pm, sessionId };
}
const exits = (events) => events.filter((e) => e.type === 'exit');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('exit without close: session still ends after the grace period and pipes are destroyed', async () => {
  const { child, events, pm, sessionId } = await started();
  child.stdout.emit('data', 'last line\n');
  child.emit('exit', 0, null);
  // Not finished immediately: the grace period waits for stdio to drain.
  assert.equal(pm.size, 1);
  assert.equal(exits(events).length, 0);
  await sleep(GRACE * 6);
  assert.equal(pm.size, 0);
  assert.deepEqual(pm.list(), []);
  const ex = exits(events);
  assert.equal(ex.length, 1);
  assert.equal(ex[0].sessionId, sessionId);
  assert.equal(ex[0].code, 0);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.ok(events.some((e) => e.type === 'log' && e.line === 'last line'));
});

test('close before exit: exactly one exit event, even when exit follows (no late duplicate)', async () => {
  const { child, events, pm } = await started();
  child.emit('close', 3, null);
  assert.equal(pm.size, 0);
  assert.equal(exits(events).length, 1);
  assert.equal(exits(events)[0].code, 3);
  child.emit('exit', 3, null);
  await sleep(GRACE * 6);
  assert.equal(exits(events).length, 1);
});

test('exit then close within the grace period: one exit event, no second one from the fallback', async () => {
  const { child, events, pm } = await started();
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  assert.equal(pm.size, 0);
  assert.equal(exits(events).length, 1);
  await sleep(GRACE * 6);
  assert.equal(exits(events).length, 1);
});

// ---- 4. no log event after the exit event ----
const noLogAfterExit = (events) => {
  const i = events.findIndex((e) => e.type === 'exit');
  assert.ok(i >= 0, 'exit event present');
  assert.equal(events.slice(i + 1).filter((e) => e.type === 'log').length, 0);
};

test('close path: trailing partial line is flushed before exit and no log follows exit', async () => {
  const { child, events, pm } = await started();
  child.stdout.emit('data', 'full\npartial');
  child.stderr.emit('data', 'err-partial');
  child.emit('close', 0, null);
  assert.equal(pm.size, 0);
  assert.equal(exits(events).length, 1);
  noLogAfterExit(events);
  // Late stream events after the session finished must not produce logs either.
  child.stdout.emit('data', 'late\n');
  child.stdout.emit('end');
  child.stdout.emit('close');
  await sleep(GRACE * 4);
  noLogAfterExit(events);
  assert.equal(exits(events).length, 1);
});

test('exit without close: partial line is flushed as a log BEFORE exit; nothing logs after exit', async () => {
  const { child, events, pm, sessionId } = await started();
  child.stdout.emit('data', 'complete line\nno newline tail');
  child.emit('exit', 0, null);
  assert.equal(exits(events).length, 0);
  await sleep(GRACE * 6);
  const lines = events.filter((e) => e.type === 'log').map((e) => e.line);
  assert.ok(lines.includes('complete line'));
  assert.ok(lines.includes('no newline tail'), 'partial line flushed');
  const exitIdx = events.findIndex((e) => e.type === 'exit');
  const tailIdx = events.findIndex((e) => e.type === 'log' && e.line === 'no newline tail');
  assert.ok(tailIdx >= 0 && tailIdx < exitIdx, 'partial log precedes exit');
  assert.equal(exits(events).length, 1);
  assert.equal(exits(events)[0].sessionId, sessionId);
  noLogAfterExit(events);
  // Pipes were destroyed; a straggling chunk from a grandchild must not log after exit.
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  child.stdout.emit('data', 'zombie\n');
  child.stdout.emit('close');
  await sleep(GRACE * 4);
  noLogAfterExit(events);
  assert.equal(pm.size, 0);
  assert.deepEqual(pm.list(), []);
});

test('exit without close: partial line on stderr is also flushed before exit', async () => {
  const { child, events } = await started();
  child.stderr.emit('data', 'wine: warning without newline');
  child.emit('exit', 1, null);
  await sleep(GRACE * 6);
  const tailIdx = events.findIndex((e) => e.type === 'log' && e.line === 'wine: warning without newline');
  const exitIdx = events.findIndex((e) => e.type === 'exit');
  assert.ok(tailIdx >= 0 && tailIdx < exitIdx);
  assert.equal(exits(events)[0].code, 1);
  noLogAfterExit(events);
});
