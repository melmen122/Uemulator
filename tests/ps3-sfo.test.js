'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { scanFolders, scanFoldersAsync, parseSfoTitle } = require('../src/main/library');

const LIB = path.resolve(__dirname, '../src/main/library.js');
const posix = process.platform !== 'win32';

let root;
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-sfo-')); });
test.afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const touch = (rel, content = 'x') => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};

// Minimal valid PARAM.SFO with a single UTF-8 TITLE entry (same layout as rpcs3.test.js).
function sfo(title, { fmt = 0x0204 } = {}) {
  const key = Buffer.from('TITLE\0');
  const data = Buffer.from(title + '\0');
  const keyStart = 20 + 16;
  const dataStart = keyStart + key.length;
  const b = Buffer.alloc(dataStart + data.length);
  b.writeUInt32BE(0x00505346, 0);
  b.writeUInt32LE(0x101, 4);
  b.writeUInt32LE(keyStart, 8);
  b.writeUInt32LE(dataStart, 12);
  b.writeUInt32LE(1, 16);
  b.writeUInt16LE(0, 20); b.writeUInt16LE(fmt, 22);
  b.writeUInt32LE(data.length, 24); b.writeUInt32LE(data.length, 28); b.writeUInt32LE(0, 32);
  key.copy(b, keyStart); data.copy(b, dataStart);
  return b;
}

// Runs a scan in a child process so a blocking open() on a FIFO cannot hang the test runner.
function scanInChild(kind) {
  const script = `
    const lib = require(${JSON.stringify(LIB)});
    const root = ${JSON.stringify(root)};
    (async () => {
      const r = ${kind === 'async' ? 'await lib.scanFoldersAsync([root])' : 'lib.scanFolders([root])'};
      process.stdout.write(JSON.stringify(r));
    })().catch((e) => { console.error(e); process.exit(2); });`;
  const r = cp.spawnSync(process.execPath, ['-e', script], { timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8' });
  if (r.error && r.error.code === 'ETIMEDOUT') assert.fail(`${kind} scan HUNG (killed after 5s) on non-regular PARAM.SFO`);
  assert.equal(r.status, 0, `${kind} scan failed: status=${r.status} signal=${r.signal} stderr=${r.stderr}`);
  return JSON.parse(r.stdout);
}

function expectOneGame(title) {
  for (const kind of ['sync', 'async']) {
    const games = scanInChild(kind);
    assert.equal(games.length, 1, `${kind}: ${JSON.stringify(games)}`);
    assert.equal(games[0].system, 'ps3');
    assert.equal(games[0].title, title, kind);
  }
}

const mkGame = () => touch('Game/PS3_GAME/USRDIR/EBOOT.BIN');
const sfoPath = () => path.join(root, 'Game/PS3_GAME/PARAM.SFO');

// ---- non-regular PARAM.SFO ----
test('scan: PARAM.SFO that is a FIFO does not hang; title from folder', { skip: !posix, timeout: 20000 }, () => {
  mkGame();
  cp.execFileSync('mkfifo', [sfoPath()]);
  expectOneGame('Game');
});

test('scan: PARAM.SFO that is a directory falls back to folder title', { skip: !posix, timeout: 20000 }, () => {
  mkGame();
  fs.mkdirSync(sfoPath());
  expectOneGame('Game');
});

test('scan: PARAM.SFO symlinked to a FIFO does not hang', { skip: !posix, timeout: 20000 }, () => {
  mkGame();
  const fifo = path.join(root, 'elsewhere.fifo');
  cp.execFileSync('mkfifo', [fifo]);
  fs.symlinkSync(fifo, sfoPath());
  expectOneGame('Game');
});

test('scan: PARAM.SFO symlinked to a real regular SFO still gives the SFO title', { skip: !posix }, async () => {
  mkGame();
  const real = path.join(root, 'real.sfo');
  fs.writeFileSync(real, sfo('Linked Title'));
  fs.symlinkSync(real, sfoPath());
  assert.equal(scanFolders([root])[0].title, 'Linked Title');
  assert.equal((await scanFoldersAsync([root]))[0].title, 'Linked Title');
});

// ---- title cleaning ----
const cps = (s) => [...s].length;
const both = async (fn) => { fn(scanFolders([root])); fn(await scanFoldersAsync([root])); };

test('SFO title: control and format characters stripped, whitespace collapsed and trimmed', async () => {
  mkGame();
  fs.writeFileSync(sfoPath(), sfo('  \u0001Hel‮lo​   Wor⁦ld\u007f\u0085  '));
  await both((g) => assert.equal(g[0].title, 'Hello World'));
  assert.equal(parseSfoTitle(sfo('‮A​  B⁦')), 'A B');
});

test('SFO title: 5000 chars capped at exactly 128 code points', async () => {
  mkGame();
  fs.writeFileSync(sfoPath(), sfo('a'.repeat(5000)));
  await both((g) => { assert.equal(cps(g[0].title), 128); assert.equal(g[0].title, 'a'.repeat(128)); });
});

test('SFO title: emoji cap is on a code point boundary (no lone surrogate)', async () => {
  mkGame();
  fs.writeFileSync(sfoPath(), sfo('\u{1F600}'.repeat(3000)));
  await both((g) => {
    const t = g[0].title;
    assert.equal(cps(t), 128);
    assert.equal(t, '\u{1F600}'.repeat(128));
    assert.equal(Buffer.from(t, 'utf8').toString('utf8'), t);
  });
  const t = parseSfoTitle(sfo('\u{1F600}'.repeat(300)));
  assert.equal(cps(t), 128);
  assert.equal(Buffer.from(t, 'utf8').toString('utf8'), t);
});

test('SFO title that is empty after cleaning falls back to folder name', async () => {
  mkGame();
  fs.writeFileSync(sfoPath(), sfo('‮​⁦  \u0001\u007f'));
  await both((g) => assert.equal(g[0].title, 'Game'));
});

test('SFO title: curly apostrophe and underscores are preserved', async () => {
  mkGame();
  fs.writeFileSync(sfoPath(), sfo('Demon’s Souls (Test)'));
  await both((g) => assert.equal(g[0].title, 'Demon’s Souls (Test)'));
  assert.equal(parseSfoTitle(sfo('A_B')), 'A_B');
});

test('folder title: control/format chars stripped, whitespace collapsed, underscores become spaces', async () => {
  touch('Ga‮me​ \u0001_  One⁦/PS3_GAME/USRDIR/EBOOT.BIN');
  await both((g) => assert.equal(g[0].title, 'Game One'));
});

test('folder title: capped at 128 code points; curly apostrophe preserved', async () => {
  touch(`${'b'.repeat(200)}/USRDIR/EBOOT.BIN`);
  touch('Demon’s Souls (Test)/USRDIR/EBOOT.BIN');
  await both((g) => {
    const titles = g.map((x) => x.title).sort();
    assert.deepEqual(titles, ['Demon’s Souls (Test)', 'b'.repeat(128)].sort());
  });
});

test('folder title: name made only of stripped characters does not yield an empty title', async () => {
  touch('‮​/USRDIR/EBOOT.BIN');
  await both((g) => {
    assert.equal(g.length, 1);
    assert.ok(g[0].title.length > 0);
    assert.doesNotMatch(g[0].title, /[\u0000-\u001f\u007f-\u009f​‮]/);
  });
});
