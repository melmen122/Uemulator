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

test('project64 on darwin is unsupported without a configured exe', () => {
  const pj = getCore('project64');
  assert.deepEqual(resolveExecutable(pj, {}, mkDeps([])), { status: 'unsupported', exe: null, source: null });
  // .exe override but no wine -> still unsupported
  const r = resolveExecutable(pj, { corePaths: { project64: '/x/Project64.exe' } }, mkDeps(['/x/Project64.exe']));
  assert.equal(r.status, 'unsupported');
});

test('project64 on darwin with wine + .exe override is ready', () => {
  const pj = getCore('project64');
  const r = resolveExecutable(pj, { corePaths: { project64: '/x/Project64.exe' } },
    mkDeps(['/x/Project64.exe'], { which: (n) => (n === 'wine' ? '/usr/bin/wine' : null) }));
  assert.deepEqual(r, { status: 'ready', exe: '/x/Project64.exe', source: 'override' });
});

test('project64 with non-.exe override on darwin stays unsupported even with wine', () => {
  const pj = getCore('project64');
  const r = resolveExecutable(pj, { corePaths: { project64: '/x/pj64' } },
    mkDeps(['/x/pj64'], { which: () => '/usr/bin/wine' }));
  assert.equal(r.status, 'unsupported');
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
