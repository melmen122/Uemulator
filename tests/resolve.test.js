'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveExecutable, getCore, defaultWhich, listCores, describeCore } = require('../src/main/cores');

const BIN = '/app/bin';
const mkDeps = (existing, extra = {}) => ({
  existsSync: (p) => existing.includes(p),
  platform: 'darwin',
  which: () => null,
  binDir: BIN,
  homedir: '/Users/u',
  env: {},
  ...extra,
});
const mgba = getCore('mgba');

test('override wins over built bin and system', () => {
  const built = mgba.candidates({ platform: 'darwin', binDir: BIN, homedir: '/Users/u', env: {} })[0];
  const r = resolveExecutable(mgba, { corePaths: { mgba: '/my/mgba' } }, mkDeps(['/my/mgba', built, '/Applications/mGBA.app/Contents/MacOS/mGBA']));
  assert.deepEqual(r, { status: 'ready', exe: '/my/mgba', source: 'override' });
});

test('missing override file falls through to candidates', () => {
  const sys = '/Applications/mGBA.app/Contents/MacOS/mGBA';
  const r = resolveExecutable(mgba, { corePaths: { mgba: '/gone/mgba' } }, mkDeps([sys]));
  assert.equal(r.status, 'ready');
  assert.equal(r.exe, sys);
  assert.equal(r.source, 'system');
});

test('missing override and nothing else -> missing, no exe', () => {
  const r = resolveExecutable(mgba, { corePaths: { mgba: '/gone/mgba' } }, mkDeps([]));
  assert.deepEqual(r, { status: 'missing', exe: null, source: null });
});

test('null/empty override ignored', () => {
  assert.equal(resolveExecutable(mgba, { corePaths: { mgba: null } }, mkDeps([])).status, 'missing');
  assert.equal(resolveExecutable(mgba, { corePaths: { mgba: '' } }, mkDeps([])).status, 'missing');
  assert.equal(resolveExecutable(mgba, {}, mkDeps([])).status, 'missing');
  assert.equal(resolveExecutable(mgba, undefined, mkDeps([])).status, 'missing');
});

test('built bin preferred over system install', () => {
  const ctx = { platform: 'darwin', binDir: BIN, homedir: '/Users/u', env: {} };
  const built = mgba.candidates(ctx)[0];
  const sys = '/Applications/mGBA.app/Contents/MacOS/mGBA';
  const r = resolveExecutable(mgba, {}, mkDeps([sys, built]));
  assert.equal(r.exe, built);
  assert.equal(r.source, 'built');
});

test('which fallback reports source path', () => {
  const r = resolveExecutable(mgba, {}, mkDeps([], { which: (n) => (n === 'mgba' ? '/somewhere/mgba' : null) }));
  assert.deepEqual(r, { status: 'ready', exe: '/somewhere/mgba', source: 'path' });
});

test('candidates beat which', () => {
  const sys = '/Applications/mGBA.app/Contents/MacOS/mGBA';
  const r = resolveExecutable(mgba, {}, mkDeps([sys], { which: () => '/p/mgba' }));
  assert.equal(r.source, 'system');
});

const PJ = '/x/Project64.exe';
const wineOnPath = (n) => (n === 'wine' ? '/usr/bin/wine' : null);

test('project64 on darwin: nothing present is missing (not unsupported)', () => {
  const r = resolveExecutable(getCore('project64'), {}, mkDeps([]));
  assert.equal(r.status, 'missing');
  assert.equal(r.exe, null);
  assert.equal(r.wine, null);
});

test('project64 on darwin: exe without wine is missing; wine without exe is missing', () => {
  const pj = getCore('project64');
  const a = resolveExecutable(pj, { corePaths: { project64: PJ } }, mkDeps([PJ]));
  assert.equal(a.status, 'missing');
  assert.equal(a.wine, null);
  const b = resolveExecutable(pj, {}, mkDeps([], { which: wineOnPath }));
  assert.equal(b.status, 'missing');
  assert.equal(b.wine, '/usr/bin/wine');
  assert.equal(b.exe, null);
});

test('project64 on darwin with PATH wine + .exe override is ready and reports wine', () => {
  const r = resolveExecutable(getCore('project64'), { corePaths: { project64: PJ } }, mkDeps([PJ], { which: wineOnPath }));
  assert.equal(r.status, 'ready');
  assert.equal(r.exe, PJ);
  assert.equal(r.source, 'override');
  assert.equal(r.wine, '/usr/bin/wine');
  assert.equal(r.wineSource, 'path');
});

test('project64 wine64 on PATH is accepted', () => {
  const r = resolveExecutable(getCore('project64'), { corePaths: { project64: PJ } },
    mkDeps([PJ], { which: (n) => (n === 'wine64' ? '/opt/wine64' : null) }));
  assert.equal(r.status, 'ready');
  assert.equal(r.wine, '/opt/wine64');
});

test('project64: built bin/wine is preferred over PATH wine', () => {
  const built = `${BIN}/wine/bin/wine`;
  const r = resolveExecutable(getCore('project64'), { corePaths: { project64: PJ } },
    mkDeps([PJ, built], { which: wineOnPath }));
  assert.equal(r.status, 'ready');
  assert.equal(r.wine, built);
  assert.equal(r.wineSource, 'built');
});

test('project64: non-.exe override is not accepted even with wine', () => {
  const r = resolveExecutable(getCore('project64'), { corePaths: { project64: '/x/pj64' } },
    mkDeps(['/x/pj64'], { which: () => '/usr/bin/wine' }));
  assert.equal(r.status, 'missing');
  assert.equal(r.exe, null);
});

test('project64: .exe check is case-insensitive and statSync (not X_OK) decides regular file', () => {
  const st = (files, dirs = []) => (p) => {
    if (files.includes(p)) return { isFile: () => true };
    if (dirs.includes(p)) return { isFile: () => false };
    throw new Error('ENOENT');
  };
  const pj = getCore('project64');
  const deps = (statSync) => ({ statSync, existsSync: () => false, platform: 'darwin', which: wineOnPath, binDir: BIN, homedir: '/h', env: {} });
  assert.equal(resolveExecutable(pj, { corePaths: { project64: '/x/PROJECT64.EXE' } }, deps(st(['/x/PROJECT64.EXE']))).status, 'ready');
  assert.equal(resolveExecutable(pj, { corePaths: { project64: '/x/dir.exe' } }, deps(st([], ['/x/dir.exe']))).status, 'missing');
  assert.equal(resolveExecutable(pj, { corePaths: { project64: '/x/gone.exe' } }, deps(st([]))).status, 'missing');
});

test('project64 on linux behaves like darwin; other platforms are unsupported', () => {
  const pj = getCore('project64');
  const r = resolveExecutable(pj, { corePaths: { project64: PJ } }, mkDeps([PJ], { platform: 'linux', which: wineOnPath }));
  assert.equal(r.status, 'ready');
  assert.deepEqual(resolveExecutable(pj, {}, mkDeps([], { platform: 'freebsd' })), { status: 'unsupported', exe: null, source: null });
  assert.equal(resolveExecutable(pj, { corePaths: { project64: PJ } }, mkDeps([PJ], { platform: 'freebsd', which: wineOnPath })).status, 'unsupported');
});

test('native core at 0644 is still not ready (regular-file rule is wine-only)', () => {
  const r = resolveExecutable(mgba, { corePaths: { mgba: '/my/mgba' } }, {
    statSync: () => ({ isFile: () => true }), existsSync: () => false, platform: 'darwin', which: () => null, binDir: BIN, homedir: '/h', env: {},
  });
  assert.equal(r.status, 'missing');
});

test('project64 on win32 resolves built bin', () => {
  const pj = getCore('project64');
  const exe = 'C:\\b\\project64\\Project64.exe';
  const r = resolveExecutable(pj, {}, mkDeps([exe], { platform: 'win32', binDir: 'C:\\b' }));
  assert.deepEqual(r, { status: 'ready', exe, source: 'built' });
});

test('defaultWhich searches PATH with injected exists', () => {
  const exists = (p) => p === '/opt/x/tool';
  assert.equal(defaultWhich('tool', { platform: 'linux', env: { PATH: '/usr/bin:/opt/x' }, existsSync: exists }), '/opt/x/tool');
  assert.equal(defaultWhich('nope', { platform: 'linux', env: { PATH: '/usr/bin' }, existsSync: exists }), null);
  assert.equal(defaultWhich('../evil', { platform: 'linux', env: { PATH: '/usr/bin' }, existsSync: () => true }), null);
});

test('registry and describeCore shape', () => {
  assert.deepEqual(listCores().map((c) => c.id).sort(), ['azahar', 'mgba', 'project64', 'pyboy', 'rpcs3', 'ryujinx']);
  assert.equal(getCore('nope'), null);
  const d = describeCore(mgba, {}, mkDeps([]));
  assert.deepEqual(Object.keys(d).sort(), ['exe', 'homepage', 'id', 'license', 'name', 'source', 'status', 'systems']);
  assert.equal(d.status, 'missing');
});
