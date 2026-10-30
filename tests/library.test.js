'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { scanFolders, gameId, titleFromPath } = require('../src/main/library');

let root;
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-lib-')); });
test.afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const touch = (rel, content = 'rom') => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};

test('finds nested ROMs with correct system, size, and defaults', () => {
  const a = touch('a/Super_Mario_64.z64', '12345');
  const b = touch('a/b/c/Pokemon.GBA');
  touch('x.gb');
  const games = scanFolders([root]);
  assert.equal(games.length, 3);
  const g = games.find((x) => x.path === a);
  assert.equal(g.system, 'n64');
  assert.equal(g.title, 'Super Mario 64');
  assert.equal(g.size, 5);
  assert.equal(g.lastPlayed, null);
  assert.equal(g.favorite, false);
  assert.equal(games.find((x) => x.path === b).system, 'gba');
});

test('id is first 12 hex of sha1(abs path) and stable across scans', () => {
  const p = touch('g.gba');
  const [g1] = scanFolders([root]);
  const [g2] = scanFolders([root]);
  assert.equal(g1.id, crypto.createHash('sha1').update(p).digest('hex').slice(0, 12));
  assert.match(g1.id, /^[0-9a-f]{12}$/);
  assert.equal(g1.id, g2.id);
  assert.equal(gameId(p), g1.id);
});

test('ignores dotfiles, dot dirs, node_modules, unknown extensions, no-ext files', () => {
  touch('.hidden.gba');
  touch('.cache/a.gba');
  touch('node_modules/pkg/a.gba');
  touch('notes.txt');
  touch('README');
  touch('keep.nsp');
  const games = scanFolders([root]);
  assert.deepEqual(games.map((g) => path.basename(g.path)), ['keep.nsp']);
});

test('a directory named like a ROM (Foo.app) is not a game', () => {
  fs.mkdirSync(path.join(root, 'Foo.app', 'Contents'), { recursive: true });
  touch('Foo.app/Contents/inner.gba');
  assert.deepEqual(scanFolders([root]), []);
});

test('symlink loop does not hang or duplicate', () => {
  touch('d/game.gba');
  try { fs.symlinkSync(root, path.join(root, 'd', 'loop'), 'dir'); } catch { return; }
  const games = scanFolders([root]);
  assert.equal(games.length, 1);
});

test('broken symlink is skipped without throwing', () => {
  touch('ok.gb');
  try { fs.symlinkSync(path.join(root, 'nope.gba'), path.join(root, 'broken.gba')); } catch { return; }
  assert.equal(scanFolders([root]).length, 1);
});

test('depth limit stops deep trees', () => {
  const deep = Array.from({ length: 15 }, (_, i) => `d${i}`).join('/');
  touch(`${deep}/deep.gba`);
  touch('shallow.gba');
  const games = scanFolders([root]);
  assert.deepEqual(games.map((g) => path.basename(g.path)), ['shallow.gba']);
});

test('favorite and lastPlayed preserved across rescans via previous', () => {
  const p = touch('g.gba');
  const first = scanFolders([root]);
  first[0].favorite = true;
  first[0].lastPlayed = 1700000000000;
  const second = scanFolders([root], { previous: first });
  assert.equal(second[0].id, first[0].id);
  assert.equal(second[0].favorite, true);
  assert.equal(second[0].lastPlayed, 1700000000000);
  // without previous it resets
  assert.equal(scanFolders([root])[0].favorite, false);
  assert.ok(p);
});

test('removed files disappear; new files appear; stale previous entries are not resurrected', () => {
  const a = touch('a.gba');
  touch('b.gba');
  const first = scanFolders([root]);
  fs.rmSync(a);
  touch('c.gba');
  const second = scanFolders([root], { previous: first });
  assert.deepEqual(second.map((g) => path.basename(g.path)), ['b.gba', 'c.gba']);
});

test('overlapping folders do not duplicate games', () => {
  touch('sub/g.gba');
  const games = scanFolders([root, path.join(root, 'sub')]);
  assert.equal(games.length, 1);
});

test('bad folder inputs are tolerated', () => {
  touch('g.gba');
  assert.equal(scanFolders([path.join(root, 'missing'), 'relative/dir', null, 5]).length, 0);
  assert.equal(scanFolders([]).length, 0);
  assert.equal(scanFolders(undefined).length, 0);
});

test('results sorted by title', () => {
  touch('zeta.gba'); touch('Alpha.gba'); touch('mid.gba');
  assert.deepEqual(scanFolders([root]).map((g) => g.title), ['Alpha', 'mid', 'zeta']);
});

test('titleFromPath cleans underscores and strips only the last extension', () => {
  assert.equal(titleFromPath('/x/Legend_of__Zelda.v64'), 'Legend of Zelda');
  assert.equal(titleFromPath('/x/Game.v1.2.gba'), 'Game.v1.2');
});

test('injectable fs is used', () => {
  const calls = [];
  const fake = {
    realpathSync: (p) => p,
    readdirSync: (d) => { calls.push(d); return []; },
    statSync: () => { throw new Error('no'); },
  };
  assert.deepEqual(scanFolders([root], { fs: fake }), []);
  assert.equal(calls[0], path.resolve(root));
});
