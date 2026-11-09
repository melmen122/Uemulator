'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sw = require('../src/main/switch2');
const { scanFolders, scanFoldersAsync, gameId } = require('../src/main/library');
const { createStore } = require('../src/main/store');
const { detectSystem } = require('../src/main/systems');

const S2 = '0400C3F00006E000';
const S1 = '0100ABCDEF123000';
const OTHER = '0500000000000000';

// Builds a valid PFS0 head with the given entry names (all zero-length files).
function pfs0(names) {
  const strs = Buffer.concat(names.map((n) => Buffer.from(n + '\0')));
  const head = Buffer.alloc(16 + names.length * 0x18);
  head.write('PFS0', 0, 'latin1');
  head.writeUInt32LE(names.length, 4);
  head.writeUInt32LE(strs.length, 8);
  let off = 0;
  names.forEach((n, i) => {
    const e = 16 + i * 0x18;
    head.writeBigUInt64LE(0n, e);
    head.writeBigUInt64LE(0n, e + 8);
    head.writeUInt32LE(off, e + 16);
    off += Buffer.byteLength(n) + 1;
  });
  return Buffer.concat([head, strs]);
}
const tikName = (id) => `${id}${'0'.repeat(16)}.tik`; // 32 hex + .tik
const nspWith = (id) => pfs0(['a.nca', tikName(id), 'b.cnmt.nca']);

// ---- classifyTitleId ----
test('classifyTitleId', () => {
  assert.equal(sw.classifyTitleId(S2), 'switch2');
  assert.equal(sw.classifyTitleId(S2.toLowerCase()), 'switch2');
  assert.equal(sw.classifyTitleId(S1), 'switch');
  assert.equal(sw.classifyTitleId(S1.toLowerCase()), 'switch');
  for (const bad of [OTHER, '0200000000000000', S2.slice(1), S2 + '0', '04ZZC3F00006E000', '', null, undefined, 5, {}, ['0400C3F00006E000']]) {
    assert.equal(sw.classifyTitleId(bad), null, String(bad));
  }
});

// ---- titleIdFromName ----
test('titleIdFromName: bracketed ID, uppercased', () => {
  assert.equal(sw.titleIdFromName('Game [0400c3f00006e000] [v0].nsp'), S2);
  assert.equal(sw.titleIdFromName(`Game [${S1}].nsp`), S1);
});

test('titleIdFromName: first bracket that classifies wins; others skipped', () => {
  assert.equal(sw.titleIdFromName(`G [${OTHER}] [${S2}] [${S1}]`), S2);
  assert.equal(sw.titleIdFromName(`G [${S1}] [${S2}]`), S1);
});

test('titleIdFromName: unbracketed / wrong-length / unclassified -> null', () => {
  assert.equal(sw.titleIdFromName(`Game ${S2}.nsp`), null);
  assert.equal(sw.titleIdFromName(`Game [${S2.slice(1)}].nsp`), null);
  assert.equal(sw.titleIdFromName(`Game [${S2}0].nsp`), null);
  assert.equal(sw.titleIdFromName(`Game [${OTHER}].nsp`), null);
  assert.equal(sw.titleIdFromName('Game.nsp'), null);
  assert.equal(sw.titleIdFromName(''), null);
});

// ---- titleIdFromPath ----
test('titleIdFromPath: basename first, then ancestors nearest first, both separators', () => {
  assert.equal(sw.titleIdFromPath(`/r/Game [${S2}].nsp`), S2);
  assert.equal(sw.titleIdFromPath(`/r/Game [${S2}]/disc.xci`), S2);
  assert.equal(sw.titleIdFromPath(`C:\\r\\Game [${S2}]\\disc.xci`), S2);
  assert.equal(sw.titleIdFromPath(`/r/G [${S1}]/x [${S2}]/disc.xci`), S2); // nearest ancestor
  assert.equal(sw.titleIdFromPath(`/r/G [${S1}]/x [${S2}]/disc [${S1}].xci`), S1); // basename beats ancestors
  assert.equal(sw.titleIdFromPath(`/r/G [${S2}]/a/b/disc.xci`), S2); // 3 ancestors reach
  assert.equal(sw.titleIdFromPath(`/G [${S2}]/a/b/c/disc.xci`), null); // 4 up is too far
  assert.equal(sw.titleIdFromPath('/r/plain/game.nsp'), null);
});

// ---- parsePfs0TitleId ----
test('parsePfs0TitleId: reads the .tik name', () => {
  assert.equal(sw.parsePfs0TitleId(nspWith(S2)), S2);
  assert.equal(sw.parsePfs0TitleId(nspWith(S2.toLowerCase())), S2);
  assert.equal(sw.parsePfs0TitleId(nspWith(S1)), S1);
  assert.equal(sw.PFS0_HEAD_BYTES, 65536);
});

test('parsePfs0TitleId: no usable tik -> null', () => {
  assert.equal(sw.parsePfs0TitleId(pfs0(['a.nca', 'b.nca'])), null);
  assert.equal(sw.parsePfs0TitleId(nspWith(OTHER)), null);
  assert.equal(sw.parsePfs0TitleId(pfs0([`${S2}.tik`])), null); // not 32 hex
  assert.equal(sw.parsePfs0TitleId(pfs0([tikName(S2).replace('.tik', '.cert')])), null);
  assert.equal(sw.parsePfs0TitleId(pfs0([])), null);
});

test('parsePfs0TitleId: hostile input never throws', () => {
  const good = nspWith(S2);
  const cases = [
    null, undefined, 'PFS0', 42, {}, new Uint8Array(good), [1, 2],
    Buffer.alloc(0), Buffer.from('PFS0'), good.subarray(0, 15), good.subarray(0, 16 + 0x18 - 1),
    Buffer.concat([Buffer.from('XXXX'), good.subarray(4)]),
  ];
  const huge = Buffer.from(good); huge.writeUInt32LE(0xffffffff, 4);
  cases.push(huge);
  const cap = Buffer.from(good); cap.writeUInt32LE(5000, 4);
  cases.push(cap);
  const strHuge = Buffer.from(good); strHuge.writeUInt32LE(0xffffffff, 8);
  cases.push(strHuge);
  const strBig = Buffer.from(good); strBig.writeUInt32LE(good.length * 2, 8);
  cases.push(strBig);
  const nameOob = Buffer.from(good); nameOob.writeUInt32LE(0x7fffffff, 16 + 0x18 + 16); // tik entry name offset
  cases.push(nameOob);
  const nameEnd = Buffer.from(good); nameEnd.writeUInt32LE(0xffffffff, 16 + 0x18 + 16);
  cases.push(nameEnd);
  const unterminated = Buffer.from(good.subarray(0, good.length - 1)); // last name loses its NUL
  cases.push(unterminated);
  cases.push(Buffer.alloc(70000, 0xff));
  cases.push(Buffer.alloc(70000));
  for (const [i, c] of cases.entries()) {
    let r;
    assert.doesNotThrow(() => { r = sw.parsePfs0TitleId(c); }, `case ${i}`);
    assert.ok(r === null || sw.classifyTitleId(r), `case ${i}: ${r}`);
  }
  // the specifically corrupt ones yield null
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) {
    if (i === 13 || i === 15 || i === 14) continue; // tolerant parsers may still find the intact tik
    assert.equal(sw.parsePfs0TitleId(cases[i]), null, `case ${i}`);
  }
});

// ---- detectSwitchGeneration ----
test('detectSwitchGeneration', () => {
  assert.equal(sw.detectSwitchGeneration({ path: `/r/G [${S2}].nsp` }), 'switch2');
  assert.equal(sw.detectSwitchGeneration({ path: '/r/g.nsp', head: nspWith(S2) }), 'switch2');
  assert.equal(sw.detectSwitchGeneration({ path: '/r/g.nsp', head: nspWith(S1) }), 'switch');
  assert.equal(sw.detectSwitchGeneration({ path: '/r/g.nsp' }), 'switch');
  assert.equal(sw.detectSwitchGeneration({ path: '/r/g.nsp', head: Buffer.from('junk') }), 'switch');
  assert.equal(sw.detectSwitchGeneration({ path: `/r/G [${S1}].nsp`, head: null }), 'switch');
});

// ---- scanning ----
let root;
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-sw2-')); });
test.afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const touch = (rel, content = 'x') => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};
const byBase = (games) => Object.fromEntries(games.map((g) => [path.basename(g.path), g]));
const both = async (fn) => { await fn('sync', async (...a) => scanFolders(...a)); await fn('async', scanFoldersAsync); };

test('scan classifies by name, by PFS0 tik, and defaults to switch', async () => {
  const a = touch(`Named [${S2}].nsp`, 'junk');
  touch('Tik2.nsp', nspWith(S2));
  touch('Tik1.nsp', nspWith(S1));
  touch('Plain.nsp', 'not a pfs0');
  touch('Empty.nsp', '');
  touch(`Old [${S1}].nsp`, nspWith(S2)); // name classifies as switch -> no byte read needed
  await both(async (kind, scan) => {
    const m = byBase(await scan([root]));
    assert.equal(m[`Named [${S2}].nsp`].system, 'switch2', kind);
    assert.equal(m['Tik2.nsp'].system, 'switch2', kind);
    assert.equal(m['Tik1.nsp'].system, 'switch', kind);
    assert.equal(m['Plain.nsp'].system, 'switch', kind);
    assert.equal(m['Empty.nsp'].system, 'switch', kind);
    assert.equal(m[`Old [${S1}].nsp`].system, 'switch', kind);
    assert.equal(m[`Named [${S2}].nsp`].id, gameId(a), kind);
  });
});

test('scan: .xci/.nca/.nro are name-based only and never opened', async () => {
  touch('A.xci', nspWith(S2));
  touch(`B [${S2}].xci`);
  touch(`C [${S2}].nro`);
  touch(`D/[${S2}]/disc.nca`);
  touch('E.nro', nspWith(S2));
  await both(async (kind, scan) => {
    const opened = [];
    const spy = { ...fs, openSync: (p, ...r) => { opened.push(p); return fs.openSync(p, ...r); } };
    const games = await scan([root], { fs: spy });
    const m = byBase(games);
    assert.equal(m['A.xci'].system, 'switch', kind);
    assert.equal(m['E.nro'].system, 'switch', kind);
    assert.equal(m[`B [${S2}].xci`].system, 'switch2', kind);
    assert.equal(m[`C [${S2}].nro`].system, 'switch2', kind);
    assert.equal(m['disc.nca'].system, 'switch2', kind);
    assert.deepEqual(opened.filter((p) => !p.endsWith('.nsp')), [], kind);
  });
});

test('scan: a name-classified .nsp is not read; an unclassified one is', async () => {
  touch(`N [${S2}].nsp`, nspWith(S1));
  touch('U.nsp', nspWith(S2));
  await both(async (kind, scan) => {
    const opened = [];
    const spy = { ...fs, openSync: (p, ...r) => { opened.push(path.basename(p)); return fs.openSync(p, ...r); } };
    await scan([root], { fs: spy });
    assert.ok(opened.includes('U.nsp'), kind);
    assert.ok(!opened.includes(`N [${S2}].nsp`), kind);
  });
});

test('scan: unreadable / garbage / directory-named .nsp does not crash', async () => {
  touch('Garbage.nsp', Buffer.alloc(100000, 0xff));
  touch(`Bad [${S2}].nsp`, 'garbage');
  const p = touch('Locked.nsp', nspWith(S2));
  const throwing = { ...fs, openSync: (f, ...r) => { if (f === p) throw new Error('EACCES'); return fs.openSync(f, ...r); } };
  await both(async (kind, scan) => {
    const m = byBase(await scan([root], { fs: throwing }));
    assert.equal(m['Garbage.nsp'].system, 'switch', kind);
    assert.equal(m[`Bad [${S2}].nsp`].system, 'switch2', kind);
    assert.equal(m['Locked.nsp'].system, 'switch', kind);
  });
});

test('scan: rescan keeps lastPlayed/favorite and id on switch2 games', async () => {
  const f = touch('T.nsp', nspWith(S2));
  await both(async (kind, scan) => {
    const prev = [{ id: gameId(f), lastPlayed: 123, favorite: true }];
    const [g] = await scan([root], { previous: prev });
    assert.equal(g.system, 'switch2', kind);
    assert.equal(g.lastPlayed, 123, kind);
    assert.equal(g.favorite, true, kind);
    assert.equal(g.id, gameId(f), kind);
  });
});

// ---- store sanitising ----
test('store library: switch path may carry system switch or switch2; other systems strict', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-sw2s-'));
  try {
    const mk = (id, p, system) => ({ id, title: 't', path: p, system, size: 1, lastPlayed: null, favorite: false });
    const st = createStore({ dir });
    assert.equal(detectSystem('/g/a.nsp'), 'switch');
    st.setLibrary({ folders: [], games: [
      mk('aaaaaaaaaaaa', '/g/a.nsp', 'switch'),
      mk('bbbbbbbbbbbb', '/g/b.nsp', 'switch2'),
      mk('cccccccccccc', '/g/c.nsp', 'ps3'),
      mk('dddddddddddd', '/g/d.gba', 'switch2'),
      mk('eeeeeeeeeeee', '/g/e.xci', 'switch2'),
    ] });
    const ids = (s) => s.getLibrary().games.map((g) => g.id).sort();
    assert.deepEqual(ids(st), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'eeeeeeeeeeee']);
    assert.deepEqual(ids(createStore({ dir })), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'eeeeeeeeeeee']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
