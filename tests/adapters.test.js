'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mgba = require('../src/main/cores/mgba');
const pyboy = require('../src/main/cores/pyboy');
const project64 = require('../src/main/cores/project64');
const azahar = require('../src/main/cores/azahar');
const ryujinx = require('../src/main/cores/ryujinx');
const lichii = require('../src/main/cores/lichii');

const NASTY = [
  '/roms/My Game.gba',
  '/roms/it\'s "quoted".gba',
  '/roms/日本語 ゲーム.gba',
  '/roms/a; rm -rf ~ && echo $(whoami).gba',
  '-rom.gba',
  '--fullscreen',
];

test('metadata', () => {
  assert.deepEqual([mgba.id, pyboy.id, project64.id, azahar.id, ryujinx.id, lichii.id], ['mgba', 'pyboy', 'project64', 'azahar', 'ryujinx', 'lichii']);
  assert.deepEqual(mgba.systems.sort(), ['gb', 'gba', 'gbc']);
  assert.deepEqual(pyboy.systems.sort(), ['gb', 'gbc']);
  assert.deepEqual(project64.systems, ['n64']);
  assert.ok(project64.platforms.includes('darwin') && project64.platforms.includes('win32'));
  assert.deepEqual(azahar.systems, ['3ds']);
  assert.deepEqual(ryujinx.systems, ['switch']);
  assert.deepEqual(lichii.systems, ['switch', 'switch2']);
  for (const c of [mgba, pyboy, azahar, ryujinx, lichii]) {
    for (const p of ['darwin', 'win32', 'linux']) assert.ok(c.platforms.includes(p), `${c.id} ${p}`);
  }
});

const generic = [
  ['mgba', mgba, '-f', '/usr/bin/mgba'],
  ['azahar', azahar, '-f', '/usr/bin/azahar'],
  ['ryujinx', ryujinx, '--fullscreen', '/usr/bin/Ryujinx'],
  ['lichii', lichii, '-f', '/usr/bin/lichii'],
];

for (const [name, core, flag, exe] of generic) {
  test(`${name}: ROM is its own argv element, last, intact`, () => {
    for (const rom of NASTY) {
      const r = core.buildArgs(rom, { exe });
      assert.equal(r.command, exe);
      assert.ok(Array.isArray(r.args));
      assert.equal(r.args[r.args.length - 1], rom);
      assert.equal(r.args.filter((a) => a === rom).length, 1);
      assert.ok(r.args.every((a) => typeof a === 'string'));
    }
  });
  test(`${name}: fullscreen flag ${flag} only when true`, () => {
    assert.ok(core.buildArgs('/r/x', { exe, fullscreen: true }).args.includes(flag));
    assert.ok(!core.buildArgs('/r/x', { exe, fullscreen: false }).args.includes(flag));
    assert.ok(!core.buildArgs('/r/x', { exe }).args.includes(flag));
    // flag must precede ROM
    const a = core.buildArgs('/r/x', { exe, fullscreen: true }).args;
    assert.ok(a.indexOf(flag) < a.indexOf('/r/x'));
  });
  test(`${name}: rejects empty/NUL/non-string ROM and missing exe`, () => {
    assert.throws(() => core.buildArgs('', { exe }));
    assert.throws(() => core.buildArgs('a\0b', { exe }));
    assert.throws(() => core.buildArgs(null, { exe }));
    assert.throws(() => core.buildArgs('/r/x', {}));
  });
  test(`${name}: buildArgs is pure`, () => {
    const o = { exe, fullscreen: true };
    assert.deepEqual(core.buildArgs('/r/x', o), core.buildArgs('/r/x', o));
    assert.deepEqual(o, { exe, fullscreen: true });
  });
}

test('pyboy: venv python runs `-m pyboy` then ROM; fullscreen adds nothing', () => {
  const exe = '/app/bin/pyboy/venv/bin/python';
  for (const rom of NASTY) {
    const r = pyboy.buildArgs(rom, { exe });
    assert.equal(r.command, exe);
    assert.deepEqual(r.args, ['-m', 'pyboy', rom]);
  }
  assert.deepEqual(pyboy.buildArgs('/r/x.gb', { exe, fullscreen: true }).args, ['-m', 'pyboy', '/r/x.gb']);
  assert.throws(() => pyboy.buildArgs('/r/x.gb', {}));
  assert.throws(() => pyboy.buildArgs('', { exe }));
});

test('pyboy: a `pyboy` console script is run directly without -m', () => {
  assert.deepEqual(pyboy.buildArgs('/r/x.gb', { exe: '/usr/local/bin/pyboy' }).args, ['/r/x.gb']);
});

test('pyboy candidates: bundled embedded python first, then the venv python', () => {
  assert.deepEqual(pyboy.candidates({ platform: 'linux', binDir: '/b' }), ['/b/pyboy/venv/bin/python']);
  const w = pyboy.candidates({ platform: 'win32', binDir: 'C:\\b' });
  assert.equal(w.length, 2);
  assert.match(w[0], /pyboy\\python\\python\.exe$/);
  assert.match(w[1], /venv\\Scripts\\python\.exe$/);
});

test('project64: non-win32 with .exe uses wine, args are [exe, rom]', () => {
  for (const platform of ['darwin', 'linux']) {
    for (const rom of NASTY) {
      const r = project64.buildArgs(rom, { exe: '/opt/pj64/Project64.exe', platform });
      assert.equal(r.command, 'wine');
      assert.deepEqual(r.args, ['/opt/pj64/Project64.exe', rom]);
      assert.equal(r.args[r.args.length - 1], rom);
    }
  }
  assert.equal(project64.buildArgs('/r/x.z64', { exe: '/p/PROJECT64.EXE', platform: 'linux' }).command, 'wine');
});

test('project64: non-win32 uses opts.wine and sets the wine env', () => {
  for (const rom of NASTY) {
    const r = project64.buildArgs(rom, { exe: '/opt/My PJ64/Project64.exe', platform: 'darwin', wine: '/app/bin/wine/bin/wine', prefixDir: '/ud/wine/project64' });
    assert.equal(r.command, '/app/bin/wine/bin/wine');
    assert.deepEqual(r.args, ['/opt/My PJ64/Project64.exe', rom]);
    assert.deepEqual(r.env, { WINEPREFIX: '/ud/wine/project64', WINEDEBUG: '-all', WINEDLLOVERRIDES: 'mscoree,mshtml=' });
  }
});

test('project64: WINEPREFIX omitted without prefixDir; bad wine/prefix rejected', () => {
  const r = project64.buildArgs('/r/x.z64', { exe: '/p/Project64.exe', platform: 'linux' });
  assert.equal(r.command, 'wine');
  assert.deepEqual(r.env, { WINEDEBUG: '-all', WINEDLLOVERRIDES: 'mscoree,mshtml=' });
  assert.ok(!('WINEPREFIX' in r.env));
  const base = { exe: '/p/Project64.exe', platform: 'linux' };
  assert.throws(() => project64.buildArgs('/r/x.z64', { ...base, wine: 'a\0b' }));
  assert.throws(() => project64.buildArgs('/r/x.z64', { ...base, wine: '' }));
  assert.throws(() => project64.buildArgs('/r/x.z64', { ...base, prefixDir: 'a\0b' }));
  assert.throws(() => project64.buildArgs('/r/x.z64', { ...base, prefixDir: '' }));
});

test('other adapters return no env', () => {
  for (const [core, exe] of [[mgba, '/usr/bin/mgba'], [azahar, '/usr/bin/azahar'], [ryujinx, '/usr/bin/Ryujinx'], [lichii, '/usr/bin/lichii'], [pyboy, '/usr/bin/pyboy']]) {
    const r = core.buildArgs('/r/x', { exe });
    assert.ok(r.env === undefined || Object.keys(r.env).length === 0, core.id);
  }
});

test('project64: non-win32 without .exe is refused', () => {
  assert.throws(() => project64.buildArgs('/r/x.z64', { exe: '/usr/bin/foo', platform: 'darwin' }));
});

test('project64: win32 runs exe directly; fullscreen ignored', () => {
  const r = project64.buildArgs('C:\\roms\\Mario 64.z64', { exe: 'C:\\pj\\Project64.exe', platform: 'win32', fullscreen: true });
  assert.deepEqual(r, { command: 'C:\\pj\\Project64.exe', args: ['C:\\roms\\Mario 64.z64'] });
  assert.equal(r.env, undefined);
  assert.throws(() => project64.buildArgs('', { exe: 'x.exe', platform: 'win32' }));
});

test('candidates return absolute-ish strings and honor binDir first', () => {
  const ctx = { platform: 'darwin', binDir: '/app/bin', homedir: '/Users/u', env: {} };
  for (const c of [mgba, pyboy, azahar, ryujinx, lichii]) {
    const list = c.candidates(ctx);
    assert.ok(list.length > 0, c.id);
    assert.ok(list.every((p) => typeof p === 'string' && p.startsWith('/')), c.id);
    assert.ok(list[0].startsWith('/app/bin/' + c.id), `${c.id} built bin first`);
  }
  assert.deepEqual(project64.candidates(ctx), []);
  assert.ok(project64.candidates({ platform: 'win32', binDir: 'C:\\b', env: {} })[0].startsWith('C:\\b\\project64'));
});

// ---- ryujinx keysDirs / preflight ----
const swGame = { system: 'switch' };
const fakeStat = (files, dirs = []) => ({
  statSync: (p) => {
    if (dirs.includes(p)) return { isFile: () => false, isDirectory: () => true, size: 0 };
    if (p in files) return { isFile: () => true, isDirectory: () => false, size: files[p] };
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
});

test('ryujinx keysDirs: per platform', () => {
  assert.deepEqual(ryujinx.keysDirs({ platform: 'darwin', homedir: '/Users/u', env: {} }), ['/Users/u/Library/Application Support/Ryujinx/system', '/Users/u/.switch']);
  assert.deepEqual(ryujinx.keysDirs({ platform: 'linux', homedir: '/home/u', env: {} }), ['/home/u/.config/Ryujinx/system', '/home/u/.switch']);
  assert.deepEqual(ryujinx.keysDirs({ platform: 'linux', homedir: '/home/u', env: { XDG_CONFIG_HOME: '/xdg' } }), ['/xdg/Ryujinx/system', '/home/u/.switch']);
  assert.deepEqual(ryujinx.keysDirs({ platform: 'win32', homedir: 'C:\\Users\\u', env: { APPDATA: 'D:\\Roam' } }), ['D:\\Roam\\Ryujinx\\system', 'C:\\Users\\u\\.switch']);
  assert.deepEqual(ryujinx.keysDirs({ platform: 'win32', homedir: 'C:\\Users\\u', env: {} }), ['C:\\Users\\u\\AppData\\Roaming\\Ryujinx\\system', 'C:\\Users\\u\\.switch']);
});

test('ryujinx keysDirs win32: a portable dir next to the exe takes priority; a portable file or missing dir does not', () => {
  const base = { platform: 'win32', homedir: 'C:\\Users\\u', env: { APPDATA: 'D:\\Roam' }, exe: 'C:\\R\\Ryujinx.exe' };
  assert.deepEqual(
    ryujinx.keysDirs({ ...base, fs: fakeStat({}, ['C:\\R\\portable']) }),
    ['C:\\R\\portable\\system', 'D:\\Roam\\Ryujinx\\system', 'C:\\Users\\u\\.switch']);
  const noPortable = ['D:\\Roam\\Ryujinx\\system', 'C:\\Users\\u\\.switch'];
  assert.deepEqual(ryujinx.keysDirs({ ...base, fs: fakeStat({}) }), noPortable);
  assert.deepEqual(ryujinx.keysDirs({ ...base, fs: fakeStat({ 'C:\\R\\portable': 1 }) }), noPortable);
  assert.deepEqual(ryujinx.keysDirs({ ...base }), noPortable);
});

test('ryujinx preflight: missing prod.keys is an error naming the first keys dir', () => {
  const ctx = { platform: 'linux', homedir: '/home/u', env: {}, exe: '/x/Ryujinx', fs: fakeStat({}) };
  const msg = ryujinx.preflight(swGame, ctx);
  assert.equal(typeof msg, 'string');
  assert.match(msg, /prod\.keys/);
  assert.ok(msg.includes('/home/u/.config/Ryujinx/system'), msg);
});

test('ryujinx preflight: empty prod.keys is an error, non-empty is accepted', () => {
  const f = '/home/u/.config/Ryujinx/system/prod.keys';
  const ctx = { platform: 'linux', homedir: '/home/u', env: {}, exe: '/x/Ryujinx' };
  assert.match(ryujinx.preflight(swGame, { ...ctx, fs: fakeStat({ [f]: 0 }) }), /prod\.keys/);
  assert.equal(ryujinx.preflight(swGame, { ...ctx, fs: fakeStat({ [f]: 12 }) }), null);
});

test('ryujinx preflight win32: keys in the portable dir count; %APPDATA% keys count; a directory named prod.keys does not', () => {
  const base = { platform: 'win32', homedir: 'C:\\Users\\u', env: { APPDATA: 'D:\\Roam' }, exe: 'C:\\R\\Ryujinx.exe' };
  const portableKeys = 'C:\\R\\portable\\system\\prod.keys';
  const roamKeys = 'D:\\Roam\\Ryujinx\\system\\prod.keys';
  assert.equal(ryujinx.preflight(swGame, { ...base, fs: fakeStat({ [portableKeys]: 3 }, ['C:\\R\\portable']) }), null);
  assert.equal(ryujinx.preflight(swGame, { ...base, fs: fakeStat({ [roamKeys]: 3 }) }), null);
  const userKeys = 'C:\\Users\\u\\.switch\\prod.keys';
  assert.equal(ryujinx.preflight(swGame, { ...base, fs: fakeStat({ [userKeys]: 3 }) }), null, 'keys only in ~/.switch pass');
  assert.notEqual(ryujinx.preflight(swGame, { ...base, fs: fakeStat({ [userKeys]: 0 }) }), null, 'empty ~/.switch keys do not');
  const msg = ryujinx.preflight(swGame, { ...base, fs: fakeStat({}, ['C:\\R\\portable', roamKeys]) });
  assert.ok(msg && msg.includes('C:\\R\\portable\\system'), msg);
});

test('ryujinx preflight: non-switch systems and missing game are not checked; a throwing fs never throws', () => {
  const ctx = { platform: 'linux', homedir: '/h', env: {}, exe: '/x/Ryujinx', fs: fakeStat({}) };
  assert.equal(ryujinx.preflight({ system: 'gba' }, ctx), null);
  assert.equal(ryujinx.preflight(null, ctx), null);
  assert.equal(ryujinx.preflight(swGame, { ...ctx, fs: { statSync() { throw new Error('boom'); } } }) === null, false);
});
