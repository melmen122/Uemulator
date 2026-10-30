'use strict';
// ROM folder scanning. Pure of Electron; the fs implementation is injectable for tests.
const nodeFs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');
const { detectSystem } = require('./systems');

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
  const cleaned = noExt.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || base;
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
      if (depth < st.maxDepth) {
        yield* walk(st, full, depth + 1);
        if (st.stop) return;
      }
    } else if (isFile) {
      const system = detectSystem(full);
      if (!system) continue;
      if (!size) {
        try { size = (yield ['stat', full]).size; } catch { continue; }
      }
      const id = gameId(full);
      if (st.found.has(id)) continue;
      const old = st.prev.get(id);
      st.found.set(id, {
        id,
        title: titleFromPath(full),
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

function syncIo(fs) {
  return {
    realpath: (p) => fs.realpathSync(p),
    readdir: (p) => fs.readdirSync(p, { withFileTypes: true }),
    stat: (p) => fs.statSync(p),
    tick: () => undefined,
  };
}

function asyncIo(fsp) {
  return {
    realpath: (p) => fsp.realpath(p),
    readdir: (p) => fsp.readdir(p, { withFileTypes: true }),
    stat: (p) => fsp.stat(p),
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

module.exports = { scanFolders, scanFoldersAsync, gameId, titleFromPath, MAX_DEPTH, MAX_ENTRIES };
