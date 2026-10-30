'use strict';
// IPC handlers + argument validation (plan.md §3.3/§3.4). No top-level Electron require:
// ipcMain/dialog/shell are injected by main.js, so validators are unit-testable under plain Node.
const nodeFs = require('fs');
const nodePath = require('path');
const nodeOs = require('os');
const nodeUrl = require('url');
const { CORES, getCore, describeCore, resolveExecutable } = require('./cores');
const { getSystem, coreForSystem, EXTENSIONS } = require('./systems');
const { scanFoldersAsync } = require('./library');

const MAX_PATH_LEN = 4096;
const MAX_URL_LEN = 2048;
const GAME_ID_RE = /^[0-9a-f]{12}$/;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RENDERER_INDEX_URL = nodeUrl.pathToFileURL(nodePath.join(__dirname, '../renderer/index.html')).href;
const PICK_KINDS = Object.freeze(['exe', 'rom']);

/** path module matching `platform`, so Windows paths are handled correctly even when validated on another host. */
const pathFor = (platform) => (platform === 'win32' ? nodePath.win32 : nodePath.posix);
/** Normalises a path for equality checks: case-insensitive on Windows (NTFS), exact elsewhere. */
const pathKey = (p, platform) => (platform === 'win32' ? p.toLowerCase() : p);

// ---------- validators (exported) ----------

function assertString(value, name, { max = 256, allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (!allowEmpty && value.length === 0) throw new Error(`${name} must not be empty`);
  if (value.length > max) throw new Error(`${name} is too long`);
  if (value.includes('\0')) throw new Error(`${name} contains an invalid character`);
  return value;
}

function validateGameId(gameId, games) {
  assertString(gameId, 'Game id', { max: 64 });
  if (!GAME_ID_RE.test(gameId)) throw new Error('Invalid game id');
  const game = (games || []).find((g) => g.id === gameId);
  if (!game) throw new Error('That game is no longer in your library. Try rescanning.');
  return game;
}

function validateCoreId(coreId) {
  assertString(coreId, 'Core id', { max: 32 });
  const core = getCore(coreId);
  if (!core) throw new Error('Unknown emulator core');
  return core;
}

function validateSessionId(sessionId) {
  assertString(sessionId, 'Session id', { max: 64 });
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('Invalid session id');
  return sessionId;
}

function validatePickKind(kind) {
  if (!PICK_KINDS.includes(kind)) throw new Error('Pick kind must be "exe" or "rom"');
  return kind;
}

/** Absolute path string check only (no I/O). */
function validateAbsolutePath(p, name = 'Path', { platform = process.platform } = {}) {
  assertString(p, name, { max: MAX_PATH_LEN });
  const P = pathFor(platform);
  if (!P.isAbsolute(p)) throw new Error(`${name} must be an absolute path`);
  return P.resolve(p);
}

function validateFolderPath(p, { fs = nodeFs, homedir, platform = process.platform } = {}) {
  const P = pathFor(platform);
  const abs = validateAbsolutePath(p, 'Folder path', { platform });
  if (platform === 'win32' && /^\\\\[?.]\\/.test(abs)) throw new Error('Choose the folder using its normal path (not a \\\\?\\ or \\\\.\\ device path)');
  // Refuse the filesystem root (a drive such as C:\) and the home folder itself: scanning them walks a huge tree.
  // A UNC share root (\\nas\roms) is allowed: that is the normal way to point at a network ROM share.
  const root = P.parse(abs).root;
  const isUncShareRoot = platform === 'win32' && /^\\\\[^\\]+\\[^\\]+\\?$/.test(root);
  if (root === abs && !isUncShareRoot) throw new Error('Choose a more specific folder than the root of the drive');
  let home = homedir;
  if (home === undefined) { try { home = nodeOs.homedir(); } catch { home = null; } }
  if (typeof home === 'string' && home.length > 0 && P.isAbsolute(home)) {
    if (pathKey(P.resolve(home), platform) === pathKey(abs, platform)) throw new Error('Choose a more specific folder than your home folder');
  }
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error('That folder does not exist'); }
  if (!st.isDirectory()) throw new Error('That path is not a folder');
  return abs;
}

function validateLaunchOptions(opts) {
  if (opts === undefined || opts === null) return {};
  if (typeof opts !== 'object' || Array.isArray(opts)) throw new Error('Launch options must be an object');
  for (const key of Object.keys(opts)) {
    if (key !== 'coreId') throw new Error(`Unknown launch option "${String(key).slice(0, 40)}"`);
  }
  if (opts.coreId === undefined || opts.coreId === null) return {};
  assertString(opts.coreId, 'Core id', { max: 32 });
  return { coreId: opts.coreId };
}

function validateExternalUrl(url) {
  assertString(url, 'URL', { max: MAX_URL_LEN });
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http and https links can be opened');
  return parsed.toString();
}

/**
 * Resolve a macOS .app bundle to its main executable (Contents/MacOS/<exe>).
 * Preference: Info.plist CFBundleExecutable, then the core's known bundle names, then the only file.
 */
function resolveAppBundle(appPath, core, { fs = nodeFs } = {}) {
  const macosDir = nodePath.join(appPath, 'Contents', 'MacOS');
  let names;
  try { names = fs.readdirSync(macosDir); } catch { throw new Error('That .app bundle has no Contents/MacOS folder'); }
  const safe = (n) => typeof n === 'string' && n.length > 0 && !/[\\/\0]/.test(n) && names.includes(n);
  try {
    const plist = fs.readFileSync(nodePath.join(appPath, 'Contents', 'Info.plist'), 'utf8');
    const m = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    if (m && safe(m[1])) return nodePath.join(macosDir, m[1]);
  } catch { /* binary or missing plist: fall through */ }
  for (const n of (core && core.bundleExecutables) || []) {
    if (safe(n)) return nodePath.join(macosDir, n);
  }
  if (names.length === 1 && safe(names[0])) return nodePath.join(macosDir, names[0]);
  throw new Error('Could not find the executable inside that .app bundle');
}

/**
 * Validate a user-chosen executable for a core and return the path to store.
 * Must be absolute, exist, and be a file. macOS/Linux: a .app bundle is resolved to its inner executable and
 * the X_OK bit is required (except for .exe, which wine runs). Windows: must be a .exe (no shell, so .bat/.cmd/.lnk
 * cannot be launched) and bundle logic never applies.
 */
function validateCorePath(p, core, { fs = nodeFs, platform = process.platform } = {}) {
  const abs = validateAbsolutePath(p, 'Executable path', { platform });
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error('That file does not exist'); }
  let exe = abs;
  if (st.isDirectory()) {
    if (platform === 'win32') throw new Error('Choose an .exe file, not a folder');
    if (!/\.app$/i.test(abs)) throw new Error('Choose an executable file or a .app bundle');
    exe = resolveAppBundle(abs, core, { fs });
    try { st = fs.statSync(exe); } catch { throw new Error('The .app bundle executable is missing'); }
  }
  if (!st.isFile()) throw new Error('That path is not a file');
  if (platform === 'win32') {
    if (!/\.exe$/i.test(exe)) throw new Error('Choose an .exe file (shortcuts and .bat/.cmd scripts cannot be launched)');
  } else if (!/\.exe$/i.test(exe)) {
    try { fs.accessSync(exe, nodeFs.constants.X_OK); } catch { throw new Error('That file is not executable'); }
  }
  return exe;
}

// ---------- handlers ----------

/**
 * Build channel -> handler map. `ctx`:
 *  { store, processes, dialog, shell, getWindow, fs?, platform?, resolveDeps?, userDataDir? }
 * userDataDir (the dir the store uses) hosts the wine prefix: <userDataDir>/wine/<coreId>.
 * Handlers receive plain args (no IPC event) and throw readable Errors.
 */
function createHandlers(ctx) {
  const { store, processes, dialog, shell, getWindow } = ctx;
  const fs = ctx.fs || nodeFs;
  const platform = ctx.platform || process.platform;
  const resolveDeps = ctx.resolveDeps || {};

  const showOpen = (options) => {
    const win = getWindow && getWindow();
    return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
  };
  const coreView = (core) => describeCore(core, store.getSettings(), resolveDeps);

  // Scans are async (the main process stays responsive) and serialised so two scans never interleave.
  // When the caller injected a sync `fs` (tests) it is wrapped; otherwise fs.promises is used.
  let scanChain = Promise.resolve();
  function rescan() {
    const run = async () => {
      const lib = store.getLibrary();
      const games = await scanFoldersAsync(lib.folders, { fs: ctx.fs, fsp: ctx.fsp, previous: lib.games });
      // Keep favourites / lastPlayed changed while the scan was running.
      const latest = new Map(store.getLibrary().games.map((g) => [g.id, g]));
      for (const g of games) {
        const cur = latest.get(g.id);
        if (cur) { g.favorite = !!cur.favorite; g.lastPlayed = typeof cur.lastPlayed === 'number' ? cur.lastPlayed : null; }
      }
      return store.setLibrary({ games });
    };
    const next = scanChain.then(run, run);
    scanChain = next.catch(() => {});
    return next;
  }

  return {
    'cores:list': () => CORES.map(coreView),

    'cores:setPath': (id, p) => {
      const core = validateCoreId(id);
      if (p === null) {
        store.setSettings({ corePaths: { [core.id]: null } });
      } else {
        const exe = validateCorePath(p, core, { fs, platform });
        store.setSettings({ corePaths: { [core.id]: exe } });
      }
      return coreView(core);
    },

    'dialog:pickFile': async (kind) => {
      validatePickKind(kind);
      const filters = kind === 'rom'
        ? [{ name: 'ROMs', extensions: [...EXTENSIONS.map((e) => e.slice(1)), 'bin'] }, { name: 'All files', extensions: ['*'] }]
        : [{ name: 'Executables', extensions: platform === 'win32' ? ['exe'] : ['*'] }];
      const res = await showOpen({ properties: ['openFile'], filters });
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
    },

    'dialog:pickFolder': async () => {
      const res = await showOpen({ properties: ['openDirectory'] });
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
    },

    'library:get': () => store.getLibrary(),

    'library:addFolder': async (p) => {
      const abs = validateFolderPath(p, { fs, homedir: ctx.homedir, platform });
      const { folders } = store.getLibrary();
      // Windows paths are case-insensitive: "D:\Roms" and "d:\roms" are the same folder.
      if (!folders.some((f) => pathKey(f, platform) === pathKey(abs, platform))) store.setLibrary({ folders: [...folders, abs] });
      return rescan();
    },

    'library:removeFolder': async (p) => {
      assertString(p, 'Folder path', { max: MAX_PATH_LEN });
      const abs = pathFor(platform).resolve(p);
      const { folders } = store.getLibrary();
      store.setLibrary({ folders: folders.filter((f) => pathKey(f, platform) !== pathKey(abs, platform) && f !== p) });
      return rescan();
    },

    'library:rescan': () => rescan(),

    'library:favorite': (gameId) => {
      const lib = store.getLibrary();
      const game = validateGameId(gameId, lib.games);
      game.favorite = !game.favorite;
      store.setLibrary({ games: lib.games });
      return { ...game };
    },

    'game:launch': async (gameId, options) => {
      const lib = store.getLibrary();
      const game = validateGameId(gameId, lib.games);
      const opts = validateLaunchOptions(options);
      const settings = store.getSettings();
      const system = getSystem(game.system);
      if (!system) throw new Error('Unknown system for that game');

      const coreId = opts.coreId || coreForSystem(game.system, settings);
      const core = validateCoreId(coreId);
      if (!core.systems.includes(game.system)) {
        throw new Error(`${core.name} cannot run ${system.name} games`);
      }

      let st;
      try { st = fs.statSync(game.path); } catch { st = null; }
      if (!st || !st.isFile()) throw new Error('The ROM file is missing. It may have been moved or deleted.');

      const r = resolveExecutable(core, settings, resolveDeps);
      if (r.status === 'unsupported') throw new Error(`${core.name} is not supported on this operating system.`);
      if (r.status !== 'ready') {
        throw new Error(r.detail
          ? `${core.name} is not installed. ${r.detail}`
          : `${core.name} is not installed. Set its path on the Cores page or run "npm run build:cores ${core.id}".`);
      }

      const buildOpts = { exe: r.exe, fullscreen: !!settings.fullscreen, platform };
      if (core.wine && platform !== 'win32') {
        // Wine-run core: the binary comes from resolution; the prefix lives under the app's userData dir.
        if (r.wine) buildOpts.wine = r.wine;
        if (typeof ctx.userDataDir === 'string' && ctx.userDataDir.length > 0) {
          buildOpts.prefixDir = nodePath.join(ctx.userDataDir, 'wine', core.id);
        }
      }
      const { command, args, env } = core.buildArgs(game.path, buildOpts);
      // Create the prefix only after buildArgs accepted the request.
      if (buildOpts.prefixDir) fs.mkdirSync(buildOpts.prefixDir, { recursive: true, mode: 0o700 });
      const session = await processes.start({ gameId: game.id, coreId: core.id, command, args, env, windowsHide: core.windowsHide === true });

      const fresh = store.getLibrary();
      const g = fresh.games.find((x) => x.id === game.id);
      if (g) { g.lastPlayed = Date.now(); store.setLibrary({ games: fresh.games }); }
      return { pid: session.pid, sessionId: session.sessionId };
    },

    'game:stop': (sessionId) => {
      validateSessionId(sessionId);
      processes.stop(sessionId); // idempotent: a session that already exited is fine
      return true;
    },

    'game:sessions': () => processes.list(),

    'settings:get': () => store.getSettings(),
    'settings:set': (patch) => {
      // Executable paths are only accepted through cores:setPath (which runs validateCorePath).
      if (patch !== null && typeof patch === 'object' && !Array.isArray(patch)
          && Object.prototype.hasOwnProperty.call(patch, 'corePaths')) {
        throw new Error('Core paths can only be changed with cores:setPath');
      }
      return store.setSettings(patch);
    },

    'shell:openExternal': async (url) => {
      const safe = validateExternalUrl(url);
      await shell.openExternal(safe);
      return true;
    },
  };
}

const stripUrlSuffix = (u) => u.split('#')[0].split('?')[0];
/** Windows file systems are case-insensitive, so file:///C:/App/... and file:///c:/app/... name the same page. */
const urlKey = (u, platform) => (platform === 'win32' && /^file:/i.test(u) ? u.toLowerCase() : u);

/**
 * Register all handlers on an ipcMain-like object. Fails closed: only calls from the app's own
 * renderer index (ctx.rendererUrl overrides the default, for tests) are accepted.
 */
function registerIpc(ipcMain, ctx) {
  const handlers = createHandlers(ctx);
  const platform = ctx.platform || process.platform;
  const allowed = urlKey(stripUrlSuffix(typeof ctx.rendererUrl === 'string' ? ctx.rendererUrl : RENDERER_INDEX_URL), platform);
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args) => {
      const frame = event && event.senderFrame;
      const url = frame && frame.url;
      if (typeof url !== 'string' || url.length === 0 || urlKey(stripUrlSuffix(url), platform) !== allowed) {
        throw new Error('Blocked IPC call from an untrusted page');
      }
      return fn(...args);
    });
  }
  return handlers;
}

module.exports = {
  createHandlers, registerIpc,
  validateGameId, validateCoreId, validateSessionId, validatePickKind, validateAbsolutePath,
  validateFolderPath, validateLaunchOptions, RENDERER_INDEX_URL, validateExternalUrl, validateCorePath, resolveAppBundle,
  assertString, pathFor, pathKey,
};
