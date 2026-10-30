// Renderer state + actions. Every call into window.uemu goes through here so views stay dumb.
import { toast, readableError, toMs, basename } from './ui.js';

export const SYSTEMS = {
  n64: { id: 'n64', name: 'Nintendo 64', short: 'N64' },
  ps3: { id: 'ps3', name: 'PlayStation 3', short: 'PS3' },
  switch: { id: 'switch', name: 'Nintendo Switch', short: 'Switch' },
  '3ds': { id: '3ds', name: 'Nintendo 3DS', short: '3DS' },
  gba: { id: 'gba', name: 'Game Boy Advance', short: 'GBA' },
  gbc: { id: 'gbc', name: 'Game Boy Color', short: 'GBC' },
  gb: { id: 'gb', name: 'Game Boy', short: 'GB' },
};

export const TABS = [
  { id: 'all', label: 'All', title: 'All games', systems: null },
  { id: 'n64', label: 'N64', title: 'Nintendo 64', systems: ['n64'] },
  { id: 'ps3', label: 'PS3', title: 'PlayStation 3', systems: ['ps3'] },
  { id: 'switch', label: 'Switch', title: 'Nintendo Switch', systems: ['switch'] },
  { id: '3ds', label: '3DS', title: 'Nintendo 3DS', systems: ['3ds'] },
  { id: 'gba', label: 'GBA', title: 'Game Boy Advance', systems: ['gba'] },
  { id: 'gb', label: 'GB/GBC', title: 'Game Boy / Color', systems: ['gb', 'gbc'] },
];

const DEFAULT_CORE = { n64: 'project64', ps3: 'rpcs3', switch: 'ryujinx', '3ds': 'azahar', gba: 'mgba' };

export const state = {
  view: 'library',
  filter: 'all',
  query: '',
  loading: true,
  scanning: false,
  bridgeMissing: false,
  cores: [],
  games: [],
  folders: [],
  settings: { fullscreen: false, gbCore: 'mgba', corePaths: {}, theme: 'system' },
  sessions: new Map(),
  launching: new Set(),
};

/* ---------- tiny pub/sub ---------- */

const subs = new Set();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function emit(topic) { for (const fn of subs) fn(topic); }

const logSubs = new Set();
export function onLog(fn) { logSubs.add(fn); return () => logSubs.delete(fn); }

export function setView(view) { state.view = view; emit('nav'); }

/* ---------- bridge ---------- */

function api() {
  if (!window.uemu) throw new Error('The Uemulator bridge (window.uemu) is not available.');
  return window.uemu;
}

async function guarded(label, fn) {
  try { return await fn(); } catch (err) {
    toast({ kind: 'error', title: label, message: readableError(err) });
    return undefined;
  }
}

/* ---------- derived helpers ---------- */

export const gameById = (id) => state.games.find((g) => g.id === id);
export const coreById = (id) => state.cores.find((c) => c.id === id);
export const gameTitle = (id) => (gameById(id) || {}).title || 'Unknown game';

export function coreIdForSystem(system) {
  if (system === 'gb' || system === 'gbc') return state.settings.gbCore === 'pyboy' ? 'pyboy' : 'mgba';
  return DEFAULT_CORE[system] || null;
}
export const coreForGame = (game) => coreById(coreIdForSystem(game.system));

/** null when the game can be launched, otherwise a human sentence explaining why not. */
export function launchBlockReason(game) {
  if (state.bridgeMissing) return 'The Uemulator bridge is unavailable in this preview.';
  if (state.loading && !state.cores.length) return 'Checking installed emulators…';
  const core = coreForGame(game);
  if (!core) return `No emulator is configured for ${(SYSTEMS[game.system] || {}).name || game.system}.`;
  if (core.status === 'ready') return null;
  if (core.status === 'unsupported') {
    return core.id === 'project64'
      ? `${core.name} isn't supported on this OS. It needs Wine and a Project64.exe path in Cores.`
      : `${core.name} isn't supported on this OS.`;
  }
  return `${core.name} isn't installed — set its path in Cores.`;
}

export const isPlaying = (gameId) => [...state.sessions.values()].some((s) => s.gameId === gameId && !s.exited);
export const activeSessionCount = () => [...state.sessions.values()].filter((s) => !s.exited).length;

export function applyTheme() {
  const t = state.settings.theme;
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t;
  else delete root.dataset.theme;
}

/* ---------- loading ---------- */

function applyLibrary(lib) {
  if (!lib) return;
  state.folders = Array.isArray(lib.folders) ? lib.folders : [];
  state.games = Array.isArray(lib.games) ? lib.games : [];
}

export async function boot() {
  if (!window.uemu) {
    state.bridgeMissing = true;
    state.loading = false;
    emit('library');
    return;
  }
  // Subscribe first so no early log line is missed.
  window.uemu.onSessionEvent(handleSessionEvent);
  const [cores, lib, settings, sessions] = await Promise.allSettled([
    api().getCores(), api().getLibrary(), api().getSettings(), api().getSessions(),
  ]);
  const fail = (r, what) => r.status === 'rejected' && toast({ kind: 'error', title: `Couldn't load ${what}`, message: readableError(r.reason) });
  if (cores.status === 'fulfilled') state.cores = cores.value || []; else fail(cores, 'emulator cores');
  if (lib.status === 'fulfilled') applyLibrary(lib.value); else fail(lib, 'your library');
  if (settings.status === 'fulfilled') state.settings = { ...state.settings, ...settings.value }; else fail(settings, 'settings');
  if (sessions.status === 'fulfilled') mergeSessions(sessions.value);
  state.loading = false;
  applyTheme();
  emit('library'); emit('cores'); emit('settings'); emit('sessions');
}

export async function refreshLibrary() {
  const lib = await guarded('Couldn’t refresh your library', () => api().getLibrary());
  if (lib) { applyLibrary(lib); emit('library'); }
}

export async function refreshCores() {
  const cores = await guarded('Couldn’t check emulator cores', () => api().getCores());
  if (cores) { state.cores = cores; emit('cores'); emit('library'); }
}

/* ---------- library actions ---------- */

export async function addFolderFlow() {
  if (state.bridgeMissing) return toast({ kind: 'error', message: 'The Uemulator bridge is unavailable in this preview.' });
  const picked = await guarded('Couldn’t open the folder picker', () => api().pickFolder());
  if (!picked) return;
  state.scanning = true; emit('scan');
  try {
    const before = state.games.length;
    const lib = await api().addFolder(picked);
    applyLibrary(lib);
    const found = state.games.length - before;
    toast({ kind: 'success', title: `Added ${basename(picked)}`, message: found > 0 ? `Found ${found} new ${found === 1 ? 'game' : 'games'}.` : 'No new games found in that folder.' });
  } catch (err) {
    toast({ kind: 'error', title: 'Couldn’t add that folder', message: readableError(err) });
  } finally {
    state.scanning = false; emit('scan'); emit('library');
  }
}

export async function removeFolderFlow(path) {
  const lib = await guarded('Couldn’t remove that folder', () => api().removeFolder(path));
  if (lib) { applyLibrary(lib); emit('library'); toast({ message: `Removed ${basename(path)} from your library.` }); }
}

export async function rescanFlow() {
  if (state.scanning) return;
  if (state.bridgeMissing) return toast({ kind: 'error', message: 'The Uemulator bridge is unavailable in this preview.' });
  state.scanning = true; emit('scan');
  try {
    const before = state.games.length;
    applyLibrary(await api().rescan());
    const delta = state.games.length - before;
    toast({ kind: 'success', title: 'Library rescanned', message: `${state.games.length} ${state.games.length === 1 ? 'game' : 'games'}${delta ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}.` });
  } catch (err) {
    toast({ kind: 'error', title: 'Rescan failed', message: readableError(err) });
  } finally {
    state.scanning = false; emit('scan'); emit('library');
  }
}

export async function toggleFavorite(gameId) {
  const g = gameById(gameId);
  if (!g) return;
  g.favorite = !g.favorite;
  emit('library');
  try {
    const res = await api().toggleFavorite(gameId);
    if (res && typeof res.favorite === 'boolean') g.favorite = res.favorite;
  } catch (err) {
    g.favorite = !g.favorite;
    toast({ kind: 'error', title: 'Couldn’t update favorite', message: readableError(err) });
  }
  emit('library');
}

/* ---------- launching + sessions ---------- */

export async function launchGame(gameId) {
  const game = gameById(gameId);
  if (!game || state.launching.has(gameId)) return;
  const reason = launchBlockReason(game);
  if (reason) {
    toast({ kind: 'error', title: `Can’t play ${game.title}`, message: reason, action: state.bridgeMissing ? undefined : { label: 'Open Cores', onClick: () => setView('cores') } });
    return;
  }
  const core = coreForGame(game);
  state.launching.add(gameId); emit('library');
  try {
    const res = await api().launch(gameId, { coreId: core.id });
    const s = ensureSession(res.sessionId);
    Object.assign(s, { gameId, coreId: core.id, pid: res.pid ?? s.pid, startedAt: s.startedAt || Date.now() });
    emit('sessions');
    toast({ kind: 'success', title: `Launched ${game.title}`, message: `Running in ${core.name}.`, action: { label: 'View', onClick: () => setView('running') } });
    refreshLibrary(); // picks up lastPlayed
  } catch (err) {
    toast({ kind: 'error', title: `Couldn’t launch ${game.title}`, message: readableError(err) });
  } finally {
    state.launching.delete(gameId); emit('library');
  }
}

function ensureSession(sessionId) {
  let s = state.sessions.get(sessionId);
  if (!s) {
    s = { sessionId, gameId: null, coreId: null, pid: null, startedAt: null, lines: [], exited: false, code: null, endedAt: null, stopping: false, timer: 0 };
    state.sessions.set(sessionId, s);
    emit('sessions');
  }
  return s;
}

function mergeSessions(list) {
  for (const info of list || []) {
    const s = ensureSession(info.sessionId);
    s.gameId = info.gameId ?? s.gameId;
    s.coreId = info.coreId ?? s.coreId;
    s.pid = info.pid ?? s.pid;
    s.startedAt = info.startedAt ?? s.startedAt;
  }
}

let hydrating = false;
async function hydrateSessions() {
  if (hydrating) return;
  hydrating = true;
  try { mergeSessions(await api().getSessions()); emit('sessions'); } catch { /* best effort */ } finally { hydrating = false; }
}

const MAX_LINES = 500;

function handleSessionEvent(ev) {
  if (!ev || !ev.sessionId) return;
  const s = ensureSession(ev.sessionId);
  if (!s.gameId && ev.type !== 'exit') hydrateSessions();
  if (ev.type === 'log') {
    const lines = String(ev.line ?? '').split(/\r?\n/).filter((l) => l.length);
    for (const line of lines) {
      s.lines.push(line);
      if (s.lines.length > MAX_LINES) s.lines.shift();
      for (const fn of logSubs) fn(s.sessionId, line);
    }
  } else if (ev.type === 'exit') {
    s.exited = true;
    s.stopping = false;
    s.code = ev.code ?? null;
    s.endedAt = Date.now();
    const failed = s.code !== null && s.code !== 0;
    if (failed) toast({ kind: 'error', title: `${gameTitle(s.gameId)} exited with code ${s.code}`, message: 'Open Running to read the log before it closes.', action: { label: 'View', onClick: () => setView('running') } });
    s.timer = setTimeout(() => dismissSession(s.sessionId), failed ? 20000 : 6000);
    emit('sessions');
  }
}

export function dismissSession(sessionId) {
  const s = state.sessions.get(sessionId);
  if (!s) return;
  clearTimeout(s.timer);
  state.sessions.delete(sessionId);
  emit('sessions');
}

export async function stopSession(sessionId) {
  const s = state.sessions.get(sessionId);
  if (!s || s.exited || s.stopping) return;
  s.stopping = true; emit('sessions');
  try { await api().stop(sessionId); } catch (err) {
    s.stopping = false; emit('sessions');
    toast({ kind: 'error', title: 'Couldn’t stop the game', message: readableError(err) });
  }
}

/* ---------- cores + settings ---------- */

export async function pickCorePath(coreId) {
  const core = coreById(coreId);
  const path = await guarded('Couldn’t open the file picker', () => api().pickFile('exe'));
  if (!path) return;
  const ok = await guarded(`Couldn’t set the ${core ? core.name : 'core'} path`, () => api().setCorePath(coreId, path));
  if (ok === undefined) return;
  state.settings.corePaths = { ...state.settings.corePaths, [coreId]: path };
  await refreshCores();
  const updated = coreById(coreId);
  if (updated && updated.status === 'ready') toast({ kind: 'success', message: `${updated.name} is ready.` });
  else if (updated) toast({ kind: 'error', title: 'Path saved, but the core isn’t ready', message: `${updated.name} couldn’t be run from that file. Check that it is the emulator’s executable.` });
}

export async function resetCorePath(coreId) {
  const ok = await guarded('Couldn’t reset the path', () => api().setCorePath(coreId, null));
  if (ok === undefined) return;
  state.settings.corePaths = { ...state.settings.corePaths, [coreId]: null };
  await refreshCores();
  toast({ message: `${(coreById(coreId) || {}).name || 'Core'} path reset to automatic detection.` });
}

export async function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  if ('theme' in patch) applyTheme();
  emit('settings');
  if ('gbCore' in patch) emit('library');
  try {
    const res = await api().setSettings(patch);
    if (res && typeof res === 'object') state.settings = { ...state.settings, ...res };
  } catch (err) {
    toast({ kind: 'error', title: 'Couldn’t save settings', message: readableError(err) });
    try { state.settings = { ...state.settings, ...(await api().getSettings()) }; } catch { /* keep optimistic */ }
    applyTheme();
  }
  emit('settings');
  if ('gbCore' in patch) emit('library');
}

export async function openExternal(url) {
  await guarded('Couldn’t open the link', () => api().openExternal(url));
}

export { toMs };
