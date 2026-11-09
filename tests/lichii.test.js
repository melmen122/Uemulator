'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { detectSystem, getSystem, coreForSystem, coresForSystem, SYSTEMS } = require('../src/main/systems');
const lichii = require('../src/main/cores/lichii');
const ryujinx = require('../src/main/cores/ryujinx');
const { windowsInstallCandidates } = require('../src/main/cores/winpaths');
const cores = require('../src/main/cores');
const ipc = require('../src/main/ipc');
const { createStore, validateSettingsPatch, defaultSettings } = require('../src/main/store');

const NASTY = [
  '/g/My Game/game.nsp',
  '/g/it\'s "quoted"/game.nsp',
  '/g/日本語 ゲーム/game.nsp',
  '/g/a; rm -rf ~ && echo $(whoami)/game.nsp',
  '-game.nsp',
  '--no-gui',
  '-f',
];

// ---- adapter ----
test('lichii metadata', () => {
  assert.equal(lichii.id, 'lichii');
  assert.equal(lichii.name, 'Lichii');
  assert.deepEqual(lichii.systems, ['switch']);
  assert.equal(lichii.homepage, 'https://github.com/zortos293/Lichii');
  assert.equal(lichii.license, 'GPL-3.0-or-later');
  assert.deepEqual(lichii.pathNames, ['lichii']);
  assert.deepEqual(lichii.bundleExecutables, ['lichii']);
  assert.deepEqual(lichii.platforms, ryujinx.platforms);
});

test('lichii candidates: darwin', () => {
  assert.deepEqual(lichii.candidates({ platform: 'darwin', binDir: '/app/bin', homedir: '/Users/u', env: {} }), [
    '/app/bin/lichii/lichii.app/Contents/MacOS/lichii',
    '/Applications/lichii.app/Contents/MacOS/lichii',
    '/Users/u/Applications/lichii.app/Contents/MacOS/lichii',
  ]);
});

test('lichii candidates: linux', () => {
  assert.deepEqual(lichii.candidates({ platform: 'linux', binDir: '/app/bin', homedir: '/home/u', env: {} }), ['/app/bin/lichii/lichii']);
});

test('lichii candidates: win32 built exe first, then standard install locations', () => {
  const env = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  const c = { platform: 'win32', binDir: 'C:\\app\\bin', homedir: 'C:\\Users\\u', env };
  const got = lichii.candidates(c);
  assert.equal(got[0], 'C:\\app\\bin\\lichii\\lichii.exe');
  assert.deepEqual(got.slice(1), windowsInstallCandidates({ env, homedir: 'C:\\Users\\u' }, ['Lichii'], 'lichii.exe'));
  assert.ok(got.includes('C:\\Program Files\\Lichii\\lichii.exe'));
});

test('lichii: exact argv is [-f] -g <path>', () => {
  const exe = '/usr/bin/lichii';
  assert.deepEqual(lichii.buildArgs('/r/x.nsp', { exe }), { command: exe, args: ['-g', '/r/x.nsp'] });
  assert.deepEqual(lichii.buildArgs('/r/x.nsp', { exe, fullscreen: false }).args, ['-g', '/r/x.nsp']);
  assert.deepEqual(lichii.buildArgs('/r/x.nsp', { exe, fullscreen: true }), { command: exe, args: ['-f', '-g', '/r/x.nsp'] });
});

test('lichii: path is its own argv element, last, verbatim', () => {
  const exe = '/usr/bin/lichii';
  for (const p of NASTY) {
    for (const fullscreen of [false, true]) {
      const r = lichii.buildArgs(p, { exe, fullscreen });
      assert.equal(r.command, exe);
      assert.ok(r.args.every((a) => typeof a === 'string'));
      assert.equal(r.args[r.args.length - 1], p);
      assert.equal(r.args.length, fullscreen ? 3 : 2);
      assert.equal(r.args[r.args.length - 2], '-g'); // path is always the value of -g
    }
  }
});

test('lichii: rejects empty/NUL/non-string path and missing exe', () => {
  const exe = '/usr/bin/lichii';
  assert.throws(() => lichii.buildArgs('', { exe }));
  assert.throws(() => lichii.buildArgs('a\0b', { exe }));
  assert.throws(() => lichii.buildArgs(null, { exe }));
  assert.throws(() => lichii.buildArgs('/r/x.nsp', {}));
  assert.throws(() => lichii.buildArgs('/r/x.nsp'));
});

test('lichii: buildArgs is pure and returns no env', () => {
  const o = { exe: '/usr/bin/lichii', fullscreen: true };
  const r = lichii.buildArgs('/r/x.nsp', o);
  assert.deepEqual(r, lichii.buildArgs('/r/x.nsp', o));
  assert.deepEqual(o, { exe: '/usr/bin/lichii', fullscreen: true });
  assert.ok(r.env === undefined || Object.keys(r.env).length === 0);
});

// ---- registry / systems ----
test('registry lists seven cores ending with lichii', () => {
  assert.equal(cores.CORES.length, 7);
  assert.equal(cores.CORES[cores.CORES.length - 1], lichii);
  assert.equal(cores.CORES[cores.CORES.length - 2].id, 'rpcs3');
  assert.deepEqual(cores.listCores().map((c) => c.id).sort(), ['azahar', 'lichii', 'mgba', 'project64', 'pyboy', 'rpcs3', 'ryujinx']);
  assert.equal(cores.getCore('lichii'), lichii);
  const d = cores.describeCore(lichii, {}, { existsSync: () => false, platform: 'linux', which: () => null, binDir: '/n', homedir: '/h', env: {} });
  assert.equal(d.license, 'GPL-3.0-or-later');
});

test('switch system: ryujinx default, lichii alternative; system set unchanged', () => {
  const sw = getSystem('switch');
  assert.equal(sw.coreId, 'ryujinx');
  assert.deepEqual(sw.altCores, ['lichii']);
  assert.deepEqual(coresForSystem('switch'), ['ryujinx', 'lichii']);
  assert.equal(SYSTEMS.length, 7);
  assert.deepEqual(sw.extensions, ['.nsp', '.xci', '.nca', '.nro']);
  assert.equal(detectSystem('/r/a.nsp'), 'switch');
});

test('coreForSystem(switch) honours settings.switchCore, falls back to ryujinx', () => {
  assert.equal(coreForSystem('switch', { switchCore: 'lichii' }), 'lichii');
  assert.equal(coreForSystem('switch', { switchCore: 'ryujinx' }), 'ryujinx');
  assert.equal(coreForSystem('switch', {}), 'ryujinx');
  assert.equal(coreForSystem('switch'), 'ryujinx');
  assert.equal(coreForSystem('switch', undefined), 'ryujinx');
  assert.equal(coreForSystem('switch', { switchCore: 'mgba' }), 'ryujinx');
  assert.equal(coreForSystem('switch', { switchCore: 'pyboy' }), 'ryujinx');
});

test('switchCore does not leak to other systems; gbCore does not affect switch', () => {
  const s = { switchCore: 'lichii' };
  assert.equal(coreForSystem('gb', s), 'mgba');
  assert.equal(coreForSystem('gba', s), 'mgba');
  assert.equal(coreForSystem('3ds', s), 'azahar');
  assert.equal(coreForSystem('n64', s), 'project64');
  assert.equal(coreForSystem('ps3', s), 'rpcs3');
  assert.equal(coreForSystem('switch', { gbCore: 'pyboy' }), 'ryujinx');
});

// ---- resolution ----
const mkDeps = (existing, extra = {}) => ({
  existsSync: (p) => existing.includes(p),
  platform: 'linux',
  which: () => null,
  binDir: '/app/bin',
  homedir: '/Users/u',
  env: {},
  ...extra,
});

test('lichii resolveExecutable: override > built > PATH > missing', () => {
  const built = '/app/bin/lichii/lichii';
  assert.deepEqual(
    cores.resolveExecutable(lichii, { corePaths: { lichii: '/my/lichii' } }, mkDeps(['/my/lichii', built])),
    { status: 'ready', exe: '/my/lichii', source: 'override' });
  assert.deepEqual(cores.resolveExecutable(lichii, {}, mkDeps([built])), { status: 'ready', exe: built, source: 'built' });
  assert.deepEqual(cores.resolveExecutable(lichii, { corePaths: { lichii: '/gone' } }, mkDeps([built])), { status: 'ready', exe: built, source: 'built' });
  assert.deepEqual(
    cores.resolveExecutable(lichii, {}, mkDeps([], { which: (n) => (n === 'lichii' ? '/somewhere/lichii' : null) })),
    { status: 'ready', exe: '/somewhere/lichii', source: 'path' });
  assert.deepEqual(cores.resolveExecutable(lichii, {}, mkDeps([])), { status: 'missing', exe: null, source: null });
});

test('lichii resolveExecutable: macOS system app bundle is found as system', () => {
  const sys = '/Applications/lichii.app/Contents/MacOS/lichii';
  assert.deepEqual(cores.resolveExecutable(lichii, {}, mkDeps([sys], { platform: 'darwin' })), { status: 'ready', exe: sys, source: 'system' });
});

// ---- store ----
let dir;
test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-lichii-')); });
test.afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('store: switchCore defaults to ryujinx; corePaths has lichii = null', () => {
  assert.equal(defaultSettings().switchCore, 'ryujinx');
  const s = createStore({ dir }).getSettings();
  assert.equal(s.switchCore, 'ryujinx');
  assert.equal(s.corePaths.lichii, null);
});

test('store: switchCore accepts ryujinx/lichii, rejects anything else, persists', () => {
  assert.deepEqual(validateSettingsPatch({ switchCore: 'lichii' }), { switchCore: 'lichii' });
  assert.deepEqual(validateSettingsPatch({ switchCore: 'ryujinx' }), { switchCore: 'ryujinx' });
  const st = createStore({ dir });
  for (const bad of ['mgba', '', 'Lichii', null, 5, ['lichii']]) {
    assert.throws(() => st.setSettings({ switchCore: bad }), Error, JSON.stringify(bad));
  }
  assert.equal(st.getSettings().switchCore, 'ryujinx');
  st.setSettings({ switchCore: 'lichii', corePaths: { lichii: '/x/lichii' } });
  const re = createStore({ dir }).getSettings();
  assert.equal(re.switchCore, 'lichii');
  assert.equal(re.corePaths.lichii, '/x/lichii');
});

test('store: invalid switchCore on disk falls back to ryujinx', () => {
  fs.writeFileSync(path.join(dir, 'uemulator.json'), JSON.stringify({ settings: { switchCore: 'mgba' } }));
  assert.equal(createStore({ dir }).getSettings().switchCore, 'ryujinx');
});

// ---- IPC ----
const NSP = '/g/game.nsp';
function harness(settings) {
  const store = createStore({ dir });
  if (settings) store.setSettings(settings);
  store.setLibrary({ folders: [], games: [
    { id: 'bbbbbbbbbbbb', title: 'S', path: NSP, system: 'switch', size: 1, lastPlayed: null, favorite: false },
  ] });
  const started = [];
  const h = ipc.createHandlers({
    store,
    processes: { start: async (x) => { started.push(x); return { pid: 1, sessionId: 's' }; }, stop() {}, list: () => [] },
    dialog: {}, shell: {}, getWindow: () => null,
    fs: { ...fs, statSync: (p) => (p === NSP ? { isFile: () => true, isDirectory: () => false } : fs.statSync(p)) },
    platform: 'linux',
    resolveDeps: { existsSync: (p) => p === '/my/lichii' || p === '/my/ryujinx', platform: 'linux', which: () => null, binDir: '/nobin', homedir: '/h', env: {} },
  });
  return { h, started };
}
const PATHS = { lichii: '/my/lichii', ryujinx: '/my/ryujinx' };

test('game:launch switch routes to ryujinx by default', async () => {
  const t = harness({ corePaths: PATHS });
  await t.h['game:launch']('bbbbbbbbbbbb');
  assert.equal(t.started.length, 1);
  assert.equal(t.started[0].command, '/my/ryujinx');
  assert.deepEqual(t.started[0].args, [NSP]);
});

test('game:launch switch routes to lichii when switchCore=lichii: -g <path>', async () => {
  const t = harness({ corePaths: PATHS, switchCore: 'lichii' });
  await t.h['game:launch']('bbbbbbbbbbbb');
  assert.equal(t.started[0].command, '/my/lichii');
  assert.deepEqual(t.started[0].args, ['-g', NSP]);
});

test('game:launch lichii fullscreen setting adds -f before -g', async () => {
  const t = harness({ corePaths: PATHS, switchCore: 'lichii', fullscreen: true });
  await t.h['game:launch']('bbbbbbbbbbbb');
  assert.deepEqual(t.started[0].args, ['-f', '-g', NSP]);
});

test('game:launch explicit coreId overrides the preference; non-switch cores are rejected', async () => {
  const t = harness({ corePaths: PATHS });
  await t.h['game:launch']('bbbbbbbbbbbb', { coreId: 'lichii' });
  assert.equal(t.started[0].command, '/my/lichii');
  const t2 = harness({ corePaths: PATHS, switchCore: 'lichii' });
  await t2.h['game:launch']('bbbbbbbbbbbb', { coreId: 'ryujinx' });
  assert.equal(t2.started[0].command, '/my/ryujinx');
  await assert.rejects(t.h['game:launch']('bbbbbbbbbbbb', { coreId: 'mgba' }), /cannot run/);
  assert.equal(t.started.length, 1);
});

// ---- build-cores CLI (never builds: --help / --check / usage errors only) ----
const BC = path.join(__dirname, '..', 'scripts', 'build-cores.mjs');
const run = (...args) => spawnSync(process.execPath, [BC, ...args], { encoding: 'utf8', timeout: 60000 });

test('build-cores: lichii is a known core (help lists it; unknown-core error lists it)', () => {
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Cores: .*\blichii\b/);
  const bad = run('nope-core');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Known cores: .*\blichii\b/);
});

test('build-cores: "lichii --check" is accepted and never builds', () => {
  const r = run('lichii', '--check');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /== lichii ==/);
  assert.match(r.stdout, /^lichii\s+(unsupported|skipped|ready)\b/m);
  assert.doesNotMatch(r.stdout, /^lichii\s+(built|failed)\b/m);
});
