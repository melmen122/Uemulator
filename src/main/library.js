'use strict';
// ROM folder scanning. Pure of Electron; the fs implementation is injectable for tests.
const nodeFs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');
const { detectSystem, isUsrdirEboot } = require('./systems');

const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(['node_modules']);
/** Hard cap on directory entries visited per scan (keeps a huge/runaway tree from hanging the app). */
const MAX_ENTRIES = 200000;
/** The async scan yields to the event loop every this many entries. */
const YIELD_EVERY = 500;

/** Stable game id: first 12 hex chars of sha1(absolute path). */
function gameId(absPath) {
  return crypto.createHash('sha1').update(nodePath.resolve(absPath)).digest('hex').slice(0, 12);
}

/** Filename without extension, underscores -> spaces, whitespace collapsed. */
function titleFromPath(filePath) {
  const base = nodePath.basename(filePath);
  const noExt = base.slice(0, base.length - nodePath.extname(base).length);
  return cleanTitle(noExt) || cleanTitle(base, false) || 'Untitled';
}

// ---- PlayStation 3 (EBOOT.BIN) titles ----------------------------------------------------------
/** Max bytes read from a PARAM.SFO (real files are 1-3 KB; this is a hard bound). */
const SFO_MAX_BYTES = 64 * 1024;
const SFO_MAX_ENTRIES = 256;
const PS3_WRAPPER_DIRS = new Set(['usrdir', 'ps3_game']);

/** Max title length in code points. */
const TITLE_MAX_CHARS = 128;

/**
 * Shared title cleaner: drops control (\p{Cc}) and format/bidi (\p{Cf}) characters, collapses whitespace,
 * trims and caps at TITLE_MAX_CHARS code points. Returns '' when nothing is left (callers pick a fallback).
 */
function cleanTitle(raw, underscores = true) {
  let t = String(raw).replace(/\0/g, '').replace(/[\t\n\v\f\r]/g, ' ');
  if (underscores) t = t.replace(/_/g, ' ');
  t = t.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  const cps = Array.from(t);
  return cps.length > TITLE_MAX_CHARS ? cps.slice(0, TITLE_MAX_CHARS).join('').trim() : t;
}

/**
 * Game-folder name for an EBOOT.BIN: the nearest ancestor directory that is not USRDIR / PS3_GAME,
 * e.g. /g/Demon's Souls/PS3_GAME/USRDIR/EBOOT.BIN -> "Demon's Souls", /g/BLUS12345/USRDIR/EBOOT.BIN -> "BLUS12345".
 * Never returns "EBOOT".
 */
function ps3FolderTitle(ebootPath) {
  let dir = nodePath.dirname(ebootPath);
  for (;;) {
    const name = nodePath.basename(dir);
    if (!name) break; // reached the filesystem root
    if (!PS3_WRAPPER_DIRS.has(name.toLowerCase())) return cleanTitle(name) || cleanTitle(name, false) || 'PlayStation 3 Game';
    const up = nodePath.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return 'PlayStation 3 Game';
}

/** Directory holding PARAM.SFO for an EBOOT.BIN in <...>/USRDIR/: its parent (PS3_GAME or <TITLEID>). */
function ps3SfoPath(ebootPath) {
  return nodePath.join(nodePath.dirname(nodePath.dirname(ebootPath)), 'PARAM.SFO');
}

/**
 * Extract TITLE from a PARAM.SFO buffer (binary "\0PSF" format: 20-byte header, 16-byte index entries,
 * key table, data table). Bounds-checked; returns null for anything malformed.
 * @param {Buffer|Uint8Array} buf
 * @returns {string|null}
 */
function parseSfoTitle(buf) {
  try {
    if (!buf || buf.length < 20 || buf.length > SFO_MAX_BYTES) return null;
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (b.readUInt32BE(0) !== 0x00505346) return null; // "\0PSF"
    const keyStart = b.readUInt32LE(8);
    const dataStart = b.readUInt32LE(12);
    const count = b.readUInt32LE(16);
    if (count > SFO_MAX_ENTRIES || 20 + count * 16 > b.length) return null;
    for (let i = 0; i < count; i++) {
      const e = 20 + i * 16;
      const keyOff = keyStart + b.readUInt16LE(e);
      const fmt = b.readUInt16LE(e + 2);
      const len = b.readUInt32LE(e + 4);
      const dataOff = dataStart + b.readUInt32LE(e + 12);
      if (keyOff >= b.length) continue;
      let keyEnd = keyOff;
      while (keyEnd < b.length && keyEnd - keyOff < 32 && b[keyEnd] !== 0) keyEnd++;
      if (b.toString('latin1', keyOff, keyEnd) !== 'TITLE') continue;
      if ((fmt !== 0x0204 && fmt !== 0x0004) || dataOff > b.length || len > b.length - dataOff) return null;
      const title = cleanTitle(b.toString('utf8', dataOff, dataOff + len), false);
      return title || null;
    }
  } catch { /* malformed: fall through */ }
  return null;
}

// ---- shared scan logic -------------------------------------------------------------------------
// The walk is a generator that yields I/O requests ([op, ...args]); a driver executes them either
// synchronously (scanFolders) or with fs.promises (scanFoldersAsync). Everything else (filtering,
// depth, symlink loops, ids, titles, ordering, preserve-previous) is therefore shared.

function* walk(st, dir, depth) {
  if (st.stop) return;
  let real;
  try { real = yield ['realpath', dir]; } catch { return; }
  if (st.visitedDirs.has(real)) return;
  st.visitedDirs.add(real);

  let entries;
  try { entries = yield ['readdir', dir]; } catch { return; }
  const inUsrdir = nodePath.basename(dir).toLowerCase() === 'usrdir';

  for (const entry of entries) {
    if (++st.visited > st.maxEntries) { st.truncated = true; st.stop = true; return; }
    if (st.visited % YIELD_EVERY === 0) yield ['tick'];

    const name = entry.name;
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const full = nodePath.join(dir, name);

    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    let size = 0;
    if (entry.isSymbolicLink()) {
      let stat;
      try { stat = yield ['stat', full]; } catch { continue; } // broken link
      isDir = stat.isDirectory();
      isFile = stat.isFile();
      size = stat.size;
    }

    if (isDir) {
      // macOS bundles (Foo.app) are directories, never ROMs; don't descend into them.
      if (/\.app$/i.test(name)) continue;
      // Inside a PS3 USRDIR only EBOOT.BIN matters; its asset subtrees can hold 100k+ files.
      if (inUsrdir) continue;
      if (depth < st.maxDepth) {
        yield* walk(st, full, depth + 1);
        if (st.stop) return;
      }
    } else if (isFile) {
      const system = detectSystem(full);
      if (!system) continue;
      // EBOOT.BIN only counts inside a USRDIR folder (avoids random matches).
      if (system === 'ps3' && nodePath.basename(full).toLowerCase() === 'eboot.bin' && !isUsrdirEboot(full)) continue;
      if (!size) {
        try { size = (yield ['stat', full]).size; } catch { continue; }
      }
      const id = gameId(full);
      if (st.found.has(id)) continue;
      const old = st.prev.get(id);
      let title;
      if (system === 'ps3' && nodePath.basename(full).toLowerCase() === 'eboot.bin') {
        title = ps3FolderTitle(full);
        try { // optional: prefer the TITLE from the sibling PARAM.SFO; any failure keeps the folder name
          const sfoPath = ps3SfoPath(full);
          // stat (follows symlinks) first: opening a FIFO/device would block forever and wedge the scan.
          const sfoStat = yield ['stat', sfoPath];
          if (sfoStat && typeof sfoStat.isFile === 'function' && sfoStat.isFile()) {
            const sfo = yield ['readHead', sfoPath, SFO_MAX_BYTES];
            title = parseSfoTitle(sfo) || title;
          }
        } catch { /* fall back silently */ }
      } else {
        title = titleFromPath(full);
      }
      st.found.set(id, {
        id,
        title,
        path: full,
        system,
        size,
        lastPlayed: old && typeof old.lastPlayed === 'number' ? old.lastPlayed : null,
        favorite: !!(old && old.favorite),
      });
    }
  }
}

function* scanGen(folders, opts) {
  const st = {
    maxDepth: Number.isInteger(opts.maxDepth) ? opts.maxDepth : MAX_DEPTH,
    maxEntries: Number.isInteger(opts.maxEntries) && opts.maxEntries >= 0 ? opts.maxEntries : MAX_ENTRIES,
    prev: new Map((opts.previous || []).map((g) => [g.id, g])),
    found: new Map(), // id -> game
    visitedDirs: new Set(), // real paths, guards against symlink loops
    visited: 0,
    truncated: false,
    stop: false,
  };
  for (const folder of folders || []) {
    if (typeof folder !== 'string' || !nodePath.isAbsolute(folder)) continue;
    yield* walk(st, nodePath.resolve(folder), 0);
    if (st.stop) break;
  }
  const games = [...st.found.values()].sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
  // Non-enumerable so the result still behaves (and deep-equals) like a plain array.
  Object.defineProperty(games, 'truncated', { value: st.truncated, enumerable: false });
  return games;
}

/** Read-only, non-blocking open: never hangs on a FIFO even if the path changes after the stat check. */
const OPEN_FLAGS = nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NONBLOCK || 0);

function syncIo(fs) {
  return {
    realpath: (p) => fs.realpathSync(p),
    readdir: (p) => fs.readdirSync(p, { withFileTypes: true }),
    stat: (p) => fs.statSync(p),
    readHead: (p, max) => {
      // O_NONBLOCK closes the stat->open race (a swapped-in FIFO opens instead of blocking); fstat re-checks.
      const fd = fs.openSync(p, OPEN_FLAGS);
      try {
        if (!fs.fstatSync(fd).isFile()) return null;
        const buf = Buffer.alloc(max + 1); // +1 so an over-size file is detected (parseSfoTitle rejects > max)
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        return buf.subarray(0, n);
      } finally { fs.closeSync(fd); }
    },
    tick: () => undefined,
  };
}

function asyncIo(fsp) {
  return {
    realpath: (p) => fsp.realpath(p),
    readdir: (p) => fsp.readdir(p, { withFileTypes: true }),
    stat: (p) => fsp.stat(p),
    readHead: async (p, max) => {
      const fh = await fsp.open(p, OPEN_FLAGS);
      try {
        if (!(await fh.stat()).isFile()) return null;
        const buf = Buffer.alloc(max + 1);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        return buf.subarray(0, bytesRead);
      } finally { await fh.close(); }
    },
    tick: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

/**
 * Recursively scan folders for ROMs (synchronous; stops after opts.maxEntries / MAX_ENTRIES entries).
 * @param {string[]} folders absolute folder paths
 * @param {{fs?:object, previous?:Array<{id:string,lastPlayed?:number|null,favorite?:boolean}>, maxDepth?:number, maxEntries?:number}} [opts]
 * @returns {Array<{id,title,path,system,size,lastPlayed,favorite}>} sorted by title; `.truncated` (non-enumerable) is true when the entry cap stopped the walk
 */
function scanFolders(folders, opts = {}) {
  const io = syncIo(opts.fs || nodeFs);
  const gen = scanGen(folders, opts);
  let r = gen.next();
  while (!r.done) {
    const [op, ...args] = r.value;
    let val; let err; let failed = false;
    try { val = io[op](...args); } catch (e) { failed = true; err = e; }
    r = failed ? gen.throw(err) : gen.next(val);
  }
  return r.value;
}

/**
 * Same as scanFolders (identical result shape, ordering, ids, preserve-previous behaviour) but
 * uses fs.promises and yields to the event loop every ~500 entries so the main process stays responsive.
 * opts.fsp supplies a promises-style fs ({realpath, readdir, stat}); otherwise a sync opts.fs is wrapped
 * (tests), otherwise require('fs').promises.
 * @returns {Promise<Array>}
 */
async function scanFoldersAsync(folders, opts = {}) {
  let fsp = opts.fsp;
  if (!fsp && opts.fs) {
    const sio = syncIo(opts.fs);
    fsp = {
      realpath: async (p) => sio.realpath(p),
      readdir: async (p) => sio.readdir(p),
      stat: async (p) => sio.stat(p),
      open: async (p, flags) => { // minimal FileHandle over the sync fs (read/stat/close are used)
        const fd = opts.fs.openSync(p, flags);
        return {
          read: async (buf, off, len, pos) => ({ bytesRead: opts.fs.readSync(fd, buf, off, len, pos) }),
          stat: async () => opts.fs.fstatSync(fd),
          close: async () => opts.fs.closeSync(fd),
        };
      },
    };
  }
  const io = asyncIo(fsp || nodeFs.promises);
  const gen = scanGen(folders, opts);
  let r = gen.next();
  while (!r.done) {
    const [op, ...args] = r.value;
    let val; let err; let failed = false;
    try { val = await io[op](...args); } catch (e) { failed = true; err = e; }
    r = failed ? gen.throw(err) : gen.next(val);
  }
  return r.value;
}

module.exports = { scanFolders, scanFoldersAsync, gameId, titleFromPath, ps3FolderTitle, parseSfoTitle, MAX_DEPTH, MAX_ENTRIES };
