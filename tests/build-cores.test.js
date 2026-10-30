'use strict';
// Pure helpers exported by scripts/build-cores.mjs (importing it must not run main()).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const posix = process.platform !== 'win32';
const mkdtemp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uemu-bc-')));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'build-cores.mjs')).href);

const tarOk = posix && spawnSync('tar', ['--version']).status === 0 && spawnSync('xz', ['--version']).status === 0;

test('importing build-cores.mjs exposes helpers and does not run main', async () => {
  const m = await load();
  for (const n of ['sha256File', 'assertSafeArchiveListing', 'assertSymlinksContained']) assert.equal(typeof m[n], 'function', n);
});

test('sha256File matches known digests (empty, small, multi-chunk)', async () => {
  const { sha256File } = await load();
  const d = mkdtemp();
  try {
    const empty = path.join(d, 'e');
    fs.writeFileSync(empty, '');
    assert.equal(sha256File(empty), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const abc = path.join(d, 'abc');
    fs.writeFileSync(abc, 'abc');
    assert.equal(sha256File(abc), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const big = path.join(d, 'big');
    const data = crypto.randomBytes((1 << 20) * 2 + 123);
    fs.writeFileSync(big, data);
    assert.equal(sha256File(big), crypto.createHash('sha256').update(data).digest('hex'));
    assert.notEqual(sha256File(abc), sha256File(empty), 'different content, different digest');
    assert.throws(() => sha256File(path.join(d, 'missing')), /ENOENT/);
  } finally { rm(d); }
});

// ---- assertSafeArchiveListing (real .tar.xz built with bsdtar/GNU tar -P) ----
function makeArchive(d, cwdRel, names) {
  const archive = path.join(d, 'a.tar.xz');
  const r = spawnSync('tar', ['-cJPf', archive, ...names], { cwd: path.join(d, cwdRel), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return archive;
}

test('assertSafeArchiveListing accepts normal entries and returns the count', { skip: !tarOk }, async () => {
  const { assertSafeArchiveListing } = await load();
  const d = mkdtemp();
  try {
    fs.mkdirSync(path.join(d, 'w', 'wine', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(d, 'w', 'wine', 'bin', 'wine'), 'x');
    fs.writeFileSync(path.join(d, 'w', 'wine', 'a..b'), 'x'); // ".." inside a name is not a segment
    const archive = makeArchive(d, 'w', ['wine']);
    assert.equal(assertSafeArchiveListing(archive), 4); // wine/, wine/bin/, wine/bin/wine, wine/a..b
  } finally { rm(d); }
});

test('assertSafeArchiveListing refuses absolute, .. and drive-letter / backslash entries', { skip: !tarOk }, async () => {
  const { assertSafeArchiveListing } = await load();
  const d = mkdtemp();
  try {
    fs.mkdirSync(path.join(d, 'w', 'sub'), { recursive: true });
    const absFile = path.join(d, 'w', 'abs');
    fs.writeFileSync(absFile, 'x');
    fs.writeFileSync(path.join(d, 'w', 'ok'), 'x');
    fs.writeFileSync(path.join(d, 'w', 'sub', 'ok2'), 'x');
    fs.writeFileSync(path.join(d, 'w', 'C:\\x'), 'x');
    fs.writeFileSync(path.join(d, 'w', 'a\\..\\b'), 'x');
    fs.writeFileSync(path.join(d, 'outside'), 'x');
    const cases = [
      ['absolute', 'w', [absFile]],
      ['dotdot-leading', 'w/sub', ['../ok']],
      ['dotdot-middle', 'w', ['sub/../ok']],
      ['drive letter', 'w', ['C:\\x']],
      ['backslash traversal', 'w', ['a\\..\\b']],
    ];
    for (const [label, cwd, names] of cases) {
      assert.throws(() => assertSafeArchiveListing(makeArchive(d, cwd, ['ok', ...names].filter((n) => !(n === 'ok' && cwd === 'w/sub')))), /unsafe archive entry/, label);
      fs.rmSync(path.join(d, 'a.tar.xz'), { force: true });
    }
  } finally { rm(d); }
});

test('assertSafeArchiveListing throws on a missing or non-archive file', { skip: !tarOk }, async () => {
  const { assertSafeArchiveListing } = await load();
  const d = mkdtemp();
  try {
    assert.throws(() => assertSafeArchiveListing(path.join(d, 'nope.tar.xz')), /could not list the archive/);
    const junk = path.join(d, 'junk.tar.xz');
    fs.writeFileSync(junk, 'not an archive');
    assert.throws(() => assertSafeArchiveListing(junk), /could not list the archive/);
  } finally { rm(d); }
});

// ---- assertSymlinksContained ----
function tree() {
  const d = mkdtemp();
  const root = path.join(d, 'root');
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'wine'), 'x');
  fs.writeFileSync(path.join(root, 'lib', 'libx.1.dylib'), 'x');
  fs.writeFileSync(path.join(d, 'outside'), 'secret');
  return { d, root };
}

test('assertSymlinksContained: in-tree, sibling-relative and ..-within-tree links pass', { skip: !posix }, async () => {
  const { assertSymlinksContained } = await load();
  const { d, root } = tree();
  try {
    fs.symlinkSync('libx.1.dylib', path.join(root, 'lib', 'libx.dylib'));
    fs.symlinkSync('../bin/wine', path.join(root, 'lib', 'wine-link'));
    fs.symlinkSync('lib', path.join(root, 'libdir'));
    fs.symlinkSync('.', path.join(root, 'self'));
    assert.doesNotThrow(() => assertSymlinksContained(root));
  } finally { rm(d); }
});

test('assertSymlinksContained: empty tree and plain files pass', { skip: !posix }, async () => {
  const { assertSymlinksContained } = await load();
  const { d, root } = tree();
  try { assert.doesNotThrow(() => assertSymlinksContained(root)); } finally { rm(d); }
});

test('assertSymlinksContained refuses absolute-target links (even to an in-tree file)', { skip: !posix }, async () => {
  const { assertSymlinksContained } = await load();
  const { d, root } = tree();
  try {
    fs.symlinkSync(path.join(root, 'bin', 'wine'), path.join(root, 'abs'));
    assert.throws(() => assertSymlinksContained(root), /absolute or empty target/);
  } finally { rm(d); }
});

test('assertSymlinksContained refuses dangling links', { skip: !posix }, async () => {
  const { assertSymlinksContained } = await load();
  const { d, root } = tree();
  try {
    fs.symlinkSync('does-not-exist', path.join(root, 'lib', 'dangling'));
    assert.throws(() => assertSymlinksContained(root), /dangling/);
  } finally { rm(d); }
});

test('assertSymlinksContained refuses a direct escape (l -> ../../outside)', { skip: !posix }, async () => {
  const { assertSymlinksContained } = await load();
  const { d, root } = tree();
  try {
    fs.symlinkSync('../outside', path.join(root, 'l')); // root/l -> d/outside
    assert.throws(() => assertSymlinksContained(root), /leaves the archive/);
    fs.rmSync(path.join(root, 'l'));
    fs.symlinkSync('../../outside', path.join(root, 'lib', 'l2')); // root/lib/l2 -> d/outside
    assert.throws(() => assertSymlinksContained(root), /leaves the archive/);
  } finally { rm(d); }
});

test('assertSymlinksContained refuses the chained escape (top/a -> . plus top/c -> a/../..)', { skip: !posix }, async () => {
  const { assertSymlinksContained } = await load();
  const { d, root } = tree();
  try {
    const top = path.join(root, 'top');
    fs.mkdirSync(top);
    fs.symlinkSync('.', path.join(top, 'a'));
    // Lexically top/c = root/top/a/../.. = root; the kernel resolves a -> top, so a/.. = root and c = d (outside).
    fs.symlinkSync('a/../..', path.join(top, 'c'));
    assert.throws(() => assertSymlinksContained(root), /leaves the archive/);
  } finally { rm(d); }
});

test('assertSymlinksContained: a sibling directory sharing the root prefix is not "inside"', { skip: !posix }, async () => {
  const { assertSymlinksContained } = await load();
  const { d, root } = tree();
  try {
    fs.mkdirSync(path.join(d, 'root-evil'));
    fs.symlinkSync('../../root-evil', path.join(root, 'lib', 'sib'));
    assert.throws(() => assertSymlinksContained(root), /leaves the archive/);
  } finally { rm(d); }
});
