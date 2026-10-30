'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mgba = require('../src/main/cores/mgba');
const pyboy = require('../src/main/cores/pyboy');
const project64 = require('../src/main/cores/project64');
const azahar = require('../src/main/cores/azahar');
const ryujinx = require('../src/main/cores/ryujinx');

const NASTY = [
  '/roms/My Game.gba',
  '/roms/it\'s "quoted".gba',
  '/roms/日本語 ゲーム.gba',
  '/roms/a; rm -rf ~ && echo $(whoami).gba',
  '-rom.gba',
  '--fullscreen',
];

test('metadata', () => {
  assert.deepEqual([mgba.id, pyboy.id, project64.id, azahar.id, ryujinx.id], ['mgba', 'pyboy', 'project64', 'azahar', 'ryujinx']);
  assert.deepEqual(mgba.systems.sort(), ['gb', 'gba', 'gbc']);
  assert.deepEqual(pyboy.systems.sort(), ['gb', 'gbc']);
  assert.deepEqual(project64.systems, ['n64']);
  assert.ok(project64.platforms.includes('darwin') && project64.platforms.includes('win32'));
  assert.deepEqual(azahar.systems, ['3ds']);
  assert.deepEqual(ryujinx.systems, ['switch']);
  for (const c of [mgba, pyboy, azahar, ryujinx]) {
    for (const p of ['darwin', 'win32', 'linux']) assert.ok(c.platforms.includes(p), `${c.id} ${p}`);
  }
});

const generic = [
  ['mgba', mgba, '-f', '/usr/bin/mgba'],
  ['azahar', azahar, '-f', '/usr/bin/azahar'],
  ['ryujinx', ryujinx, '--fullscreen', '/usr/bin/Ryujinx'],
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

test('pyboy candidates point at the venv python', () => {
  assert.deepEqual(pyboy.candidates({ platform: 'linux', binDir: '/b' }), ['/b/pyboy/venv/bin/python']);
  const w = pyboy.candidates({ platform: 'win32', binDir: 'C:\\b' });
  assert.equal(w.length, 1);
  assert.match(w[0], /venv\\Scripts\\python\.exe$/);
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
  for (const [core, exe] of [[mgba, '/usr/bin/mgba'], [azahar, '/usr/bin/azahar'], [ryujinx, '/usr/bin/Ryujinx'], [pyboy, '/usr/bin/pyboy']]) {
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
  for (const c of [mgba, pyboy, azahar, ryujinx]) {
    const list = c.candidates(ctx);
    assert.ok(list.length > 0, c.id);
    assert.ok(list.every((p) => typeof p === 'string' && p.startsWith('/')), c.id);
    assert.ok(list[0].startsWith('/app/bin/' + c.id), `${c.id} built bin first`);
  }
  assert.deepEqual(project64.candidates(ctx), []);
  assert.ok(project64.candidates({ platform: 'win32', binDir: 'C:\\b', env: {} })[0].startsWith('C:\\b\\project64'));
});
