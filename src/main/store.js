'use strict';
// JSON persistence for settings + library, in app.getPath('userData') (injectable for tests).
// No top-level Electron require.
const nodeFs = require('fs');
const nodePath = require('path');
const { CORES } = require('./cores');
const { detectSystem } = require('./systems');

const FILE_NAME = 'uemulator.json';
const THEMES = Object.freeze(['system', 'light', 'dark']);
const GB_CORE_IDS = Object.freeze(['mgba', 'pyboy']);
const MAX_PATH_LEN = 4096;

function defaultSettings() {
  const corePaths = {};
  for (const c of CORES) corePaths[c.id] = null;
  return { fullscreen: false, gbCore: 'mgba', corePaths, theme: 'system' };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate a settings patch (partial settings). Returns a normalised copy; throws a readable Error.
 * corePaths is a partial map merged per key by the store.
 */
function validateSettingsPatch(patch) {
  if (!isPlainObject(patch)) throw new Error('Settings patch must be an object');
  const out = {};
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    switch (key) {
      case 'fullscreen':
        if (typeof value !== 'boolean') throw new Error('Setting "fullscreen" must be true or false');
        out.fullscreen = value;
        break;
      case 'gbCore':
        if (!GB_CORE_IDS.includes(value)) throw new Error('Setting "gbCore" must be "mgba" or "pyboy"');
        out.gbCore = value;
        break;
      case 'theme':
        if (!THEMES.includes(value)) throw new Error('Setting "theme" must be "system", "light" or "dark"');
        out.theme = value;
        break;
      case 'corePaths': {
        if (!isPlainObject(value)) throw new Error('Setting "corePaths" must be an object');
        const cp = {};
        for (const id of Object.keys(value)) {
          if (!CORES.some((c) => c.id === id)) throw new Error(`Unknown core "${String(id).slice(0, 40)}" in corePaths`);
          const p = value[id];
          if (p !== null && (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_LEN || p.includes('\0'))) {
            throw new Error(`corePaths.${id} must be null or a non-empty path string`);
          }
          cp[id] = p;
        }
        out.corePaths = cp;
        break;
      }
      default:
        throw new Error(`Unknown setting "${String(key).slice(0, 40)}"`);
    }
  }
  return out;
}

function applyPatch(settings, patch) {
  const next = { ...settings, corePaths: { ...settings.corePaths } };
  for (const key of Object.keys(patch)) {
    if (key === 'corePaths') Object.assign(next.corePaths, patch.corePaths);
    else next[key] = patch[key];
  }
  return next;
}

function sanitizeGames(games) {
  if (!Array.isArray(games)) return [];
  return games.filter((g) => isPlainObject(g) && typeof g.id === 'string' && typeof g.path === 'string' && typeof g.system === 'string'
    && nodePath.isAbsolute(g.path) && detectSystem(g.path) === g.system)
    .map((g) => ({
      id: g.id,
      title: typeof g.title === 'string' ? g.title : nodePath.basename(g.path),
      path: g.path,
      system: g.system,
      size: Number.isFinite(g.size) ? g.size : 0,
      lastPlayed: typeof g.lastPlayed === 'number' ? g.lastPlayed : null,
      favorite: !!g.favorite,
    }));
}

/**
 * @param {{dir?:string, fileName?:string, fs?:object}} [opts] dir defaults to Electron's userData
 */
function createStore(opts = {}) {
  const fs = opts.fs || nodeFs;
  const dir = opts.dir || require('electron').app.getPath('userData');
  const file = nodePath.join(dir, opts.fileName || FILE_NAME);

  let state = { settings: defaultSettings(), library: { folders: [], games: [] } };

  function load() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return; } // first run
    let data;
    try { data = JSON.parse(raw); } catch {
      try { fs.renameSync(file, `${file}.corrupt`); } catch { /* ignore */ }
      return;
    }
    if (!isPlainObject(data)) return;
    // Tolerate stale/invalid values on disk: take only what validates.
    if (isPlainObject(data.settings)) {
      for (const key of Object.keys(data.settings)) {
        try {
          const valid = validateSettingsPatch({ [key]: data.settings[key] });
          if (valid.corePaths) {
            // Paths on disk must be absolute; drop anything else (hand-edited or stale file).
            for (const id of Object.keys(valid.corePaths)) {
              const cp = valid.corePaths[id];
              if (cp !== null && !nodePath.isAbsolute(cp)) delete valid.corePaths[id];
            }
          }
          state.settings = applyPatch(state.settings, valid);
        } catch { /* drop invalid key */ }
      }
    }
    if (isPlainObject(data.library)) {
      state.library.folders = Array.isArray(data.library.folders)
        ? data.library.folders.filter((f) => typeof f === 'string' && nodePath.isAbsolute(f)) : [];
      state.library.games = sanitizeGames(data.library.games);
    }
  }

  function save() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...state }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  load();

  return {
    file,
    getSettings() {
      return { ...state.settings, corePaths: { ...state.settings.corePaths } };
    },
    setSettings(patch) {
      const valid = validateSettingsPatch(patch);
      state.settings = applyPatch(state.settings, valid);
      save();
      return this.getSettings();
    },
    getLibrary() {
      return { folders: state.library.folders.slice(), games: state.library.games.map((g) => ({ ...g })) };
    },
    /** Replace folders and/or games and persist. */
    setLibrary({ folders, games }) {
      if (Array.isArray(folders)) state.library.folders = folders.slice();
      if (Array.isArray(games)) state.library.games = sanitizeGames(games);
      save();
      return this.getLibrary();
    },
    /** Persist after in-place edits done through getLibrary()/setLibrary(). */
    flush: save,
  };
}

module.exports = { createStore, validateSettingsPatch, defaultSettings, THEMES, GB_CORE_IDS, FILE_NAME };
