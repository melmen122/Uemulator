'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, validateSettingsPatch, defaultSettings } = require('../src/main/store');

let dir;
test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-store-')); });
test.afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('defaults on first load match plan shape', () => {
  const s = createStore({ dir }).getSettings();
  assert.equal(s.fullscreen, false);
  assert.equal(s.gbCore, 'mgba');
  assert.equal(s.theme, 'system');
  assert.deepEqual(Object.keys(s.corePaths).sort(), ['azahar', 'mgba', 'project64', 'pyboy', 'rpcs3', 'ryujinx']);
  assert.ok(Object.values(s.corePaths).every((v) => v === null));
  assert.deepEqual(createStore({ dir }).getLibrary(), { folders: [], games: [] });
});

test('first load does not create a file; set persists and reloads', () => {
  const st = createStore({ dir });
  assert.equal(fs.existsSync(st.file), false);
  st.setSettings({ fullscreen: true, gbCore: 'pyboy', theme: 'dark', corePaths: { mgba: '/x/mgba' } });
  assert.ok(fs.existsSync(st.file));
  const s = createStore({ dir }).getSettings();
  assert.equal(s.fullscreen, true);
  assert.equal(s.gbCore, 'pyboy');
  assert.equal(s.theme, 'dark');
  assert.equal(s.corePaths.mgba, '/x/mgba');
  assert.equal(s.corePaths.pyboy, null);
});

test('corePaths patch merges per key and null resets', () => {
  const st = createStore({ dir });
  st.setSettings({ corePaths: { mgba: '/a' } });
  st.setSettings({ corePaths: { azahar: '/b' } });
  assert.equal(st.getSettings().corePaths.mgba, '/a');
  st.setSettings({ corePaths: { mgba: null } });
  assert.equal(st.getSettings().corePaths.mgba, null);
  assert.equal(st.getSettings().corePaths.azahar, '/b');
});

test('library round-trips', () => {
  const st = createStore({ dir });
  st.setLibrary({ folders: [path.join(dir, 'roms')], games: [{ id: 'abcdef012345', title: 'T', path: '/r/t.gba', system: 'gba', size: 3, lastPlayed: 5, favorite: true }] });
  const lib = createStore({ dir }).getLibrary();
  assert.equal(lib.folders[0], path.join(dir, 'roms'));
  assert.equal(lib.games[0].favorite, true);
  assert.equal(lib.games[0].lastPlayed, 5);
});

test('invalid patches are rejected and leave state unchanged', () => {
  const st = createStore({ dir });
  const bad = [
    null, [], 'x', 5,
    { bogus: 1 },
    { fullscreen: 'yes' },
    { gbCore: 'vba' },
    { theme: 'neon' },
    { corePaths: 'x' },
    { corePaths: { unknown: '/x' } },
    { corePaths: { mgba: 5 } },
    { corePaths: { mgba: '' } },
    { corePaths: { mgba: 'a\0b' } },
    { corePaths: { mgba: 'x'.repeat(5000) } },
    { fullscreen: true, theme: 'neon' },
    JSON.parse('{"__proto__": {"x": 1}}'),
  ];
  for (const p of bad) assert.throws(() => st.setSettings(p), Error, JSON.stringify(p));
  assert.deepEqual(st.getSettings(), defaultSettings());
  assert.equal(fs.existsSync(st.file), false);
});

test('validateSettingsPatch accepts valid enums', () => {
  assert.deepEqual(validateSettingsPatch({ theme: 'light', gbCore: 'pyboy' }), { theme: 'light', gbCore: 'pyboy' });
  assert.deepEqual(validateSettingsPatch({}), {});
});

test('corrupt JSON falls back to defaults without crashing, and store remains usable', () => {
  fs.writeFileSync(path.join(dir, 'uemulator.json'), '{not json');
  const st = createStore({ dir });
  assert.deepEqual(st.getSettings(), defaultSettings());
  st.setSettings({ theme: 'dark' });
  assert.equal(createStore({ dir }).getSettings().theme, 'dark');
});

test('valid JSON with wrong shapes / invalid values is tolerated', () => {
  const file = path.join(dir, 'uemulator.json');
  fs.writeFileSync(file, '[1,2]');
  assert.deepEqual(createStore({ dir }).getSettings(), defaultSettings());
  fs.writeFileSync(file, JSON.stringify({ settings: { theme: 'neon', gbCore: 'pyboy', evil: 1, fullscreen: 'x' }, library: { folders: ['rel', 5], games: [{ nope: 1 }, 7] } }));
  const st = createStore({ dir });
  assert.equal(st.getSettings().theme, 'system');
  assert.equal(st.getSettings().gbCore, 'pyboy');
  assert.equal(st.getSettings().fullscreen, false);
  assert.deepEqual(st.getLibrary(), { folders: [], games: [] });
});

test('atomic write leaves no temp files and valid JSON', () => {
  const st = createStore({ dir });
  st.setSettings({ fullscreen: true });
  st.setSettings({ fullscreen: false });
  assert.deepEqual(fs.readdirSync(dir), ['uemulator.json']);
  JSON.parse(fs.readFileSync(st.file, 'utf8'));
});

test('getSettings returns a copy', () => {
  const st = createStore({ dir });
  const s = st.getSettings();
  s.theme = 'dark';
  s.corePaths.mgba = '/hax';
  assert.equal(st.getSettings().theme, 'system');
  assert.equal(st.getSettings().corePaths.mgba, null);
});

test('creates missing directory on save', () => {
  const nested = path.join(dir, 'a', 'b');
  const st = createStore({ dir: nested });
  st.setSettings({ fullscreen: true });
  assert.ok(fs.existsSync(path.join(nested, 'uemulator.json')));
});
