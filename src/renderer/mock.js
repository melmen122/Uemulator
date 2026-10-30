// In-memory stand-in for window.uemu (plan.md §3.3). Loaded only when the URL contains ?mock.
//   ?mock            sample library, mixed core statuses
//   ?mock=empty      no games / no folders (empty state)
//   ?mock&sessions=1 starts with one running session streaming logs
//   ?mock&platform=darwin|win32|linux  platform reported by the bridge (default darwin)
//   ?mock&theme=light|dark  initial theme setting;  ?view=cores|running|settings opens that view
const params = new URLSearchParams(location.search);
const PLATFORMS = ['darwin', 'win32', 'linux'];
const PLATFORM = PLATFORMS.includes(params.get('platform')) ? params.get('platform') : 'darwin';

const EMPTY = params.get('mock') === 'empty';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => structuredClone(v);
const MIN = 60e3;
const DAY = 86400e3;
const now = Date.now();

const FOLDERS = EMPTY ? [] : ['/Users/demo/ROMs/Nintendo', '/Users/demo/ROMs/Handhelds'];

const g = (id, title, system, ext, mb, folder, extra = {}) => ({
  id, title, system, path: `${folder}/${title}.${ext}`, size: mb * 1048576, lastPlayed: null, favorite: false, ...extra,
});
const N = FOLDERS[0];
const H = FOLDERS[1];
let games = EMPTY ? [] : [
  g('g01', 'Super Mario 64', 'n64', 'z64', 8, N, { favorite: true, lastPlayed: now - 3 * DAY }),
  g('g02', 'The Legend of Zelda: Ocarina of Time', 'n64', 'z64', 32, N, { favorite: true, lastPlayed: now - 2 * 3600e3 }),
  g('g03', 'GoldenEye 007', 'n64', 'z64', 12, N),
  g('g04', 'Mario Kart 64', 'n64', 'n64', 12, N),
  g('g21', 'Demon’s Souls', 'ps3', 'BIN', 27800, N, { path: "/Users/demo/ROMs/PS3/Demon's Souls/PS3_GAME/USRDIR/EBOOT.BIN", lastPlayed: now - 3600e3 }),
  g('g22', 'Persona 5', 'ps3', 'iso', 22400, N, { lastPlayed: now - 9 * DAY }),
  g('g05', 'Hollow Knight', 'switch', 'nsp', 3100, N, { lastPlayed: now - 5 * DAY }),
  g('g06', 'Celeste', 'switch', 'nsp', 1200, N, { favorite: true }),
  g('g07', 'Metroid Dread', 'switch', 'xci', 3900, N),
  g('g08', 'The Legend of Zelda: Tears of the Kingdom — Collector’s Edition (Update 1.2.1 + DLC Pack)', 'switch', 'nsp', 16400, N),
  g('g09', 'Fire Emblem Awakening', '3ds', '3ds', 780, N, { lastPlayed: now - 45 * MIN }),
  g('g10', 'Animal Crossing New Leaf', '3ds', 'cia', 1100, N),
  g('g11', 'Pokemon Y', '3ds', '3ds', 1000, N),
  g('g12', 'Metroid Fusion', 'gba', 'gba', 8, H, { favorite: true, lastPlayed: now - 30 * DAY }),
  g('g13', 'Advance Wars', 'gba', 'gba', 8, H),
  g('g14', 'Golden Sun', 'gba', 'gba', 16, H),
  g('g15', 'The Minish Cap', 'gba', 'gba', 16, H, { lastPlayed: now - DAY }),
  g('g16', 'Link’s Awakening DX', 'gbc', 'gbc', 1, H),
  g('g17', 'Pokemon Crystal', 'gbc', 'gbc', 2, H, { lastPlayed: now - 6 * DAY }),
  g('g18', 'Tetris', 'gb', 'gb', 0.03, H, { favorite: true }),
  g('g19', 'Kirby’s Dream Land', 'gb', 'gb', 0.06, H),
  g('g20', 'Super Mario Land', 'gb', 'gb', 0.06, H),
];

let settings = { fullscreen: false, gbCore: 'mgba', corePaths: {}, theme: params.get('theme') || 'system' };

const CORE_DEFS = [
  { id: 'project64', name: 'Project64', systems: ['n64'], homepage: 'https://www.pj64-emu.com', license: 'GPL-2.0', base: PLATFORM === 'win32' ? { status: 'missing', exe: null, source: null } : { status: 'unsupported', exe: null, source: null } },
  { id: 'rpcs3', name: 'RPCS3', systems: ['ps3'], homepage: 'https://rpcs3.net', license: 'GPL-2.0', base: { status: 'missing', exe: null, source: null } },
  { id: 'ryujinx', name: 'Ryujinx', systems: ['switch'], homepage: 'https://ryujinx.app', license: 'MIT', base: { status: 'missing', exe: null, source: null } },
  { id: 'azahar', name: 'Azahar', systems: ['3ds'], homepage: 'https://azahar-emu.org', license: 'GPL-2.0', base: { status: 'ready', exe: '/Users/demo/Uemulator/bin/azahar/azahar', source: 'built' } },
  { id: 'pyboy', name: 'PyBoy', systems: ['gb', 'gbc'], homepage: 'https://github.com/Baekalfen/PyBoy', license: 'LGPL-3.0', base: { status: 'missing', exe: null, source: null } },
  { id: 'mgba', name: 'mGBA', systems: ['gba', 'gbc', 'gb'], homepage: 'https://mgba.io', license: 'MPL-2.0', base: { status: 'ready', exe: PLATFORM === 'win32' ? 'C:\\Program Files\\mGBA\\mGBA.exe' : '/Applications/mGBA.app/Contents/MacOS/mGBA', source: 'system' } },
];

function coreView(def) {
  const p = settings.corePaths[def.id];
  const r = p ? { status: 'ready', exe: p, source: 'override' } : def.base;
  return { id: def.id, name: def.name, systems: def.systems, homepage: def.homepage, license: def.license, ...r };
}

/* ---------- sessions ---------- */
const listeners = new Set();
const emit = (ev) => { for (const cb of listeners) cb(ev); };
const sessions = new Map(); // id -> {info, timer}
let seq = 0;

const LOG_LINES = [
  'Loading ROM header…', 'Mapper detected: standard', 'Audio: 48000 Hz stereo', 'Video: OpenGL 4.1 Metal',
  'Warning: save file not found, creating a new one', 'Controller 1 connected: Xbox Wireless Controller',
  'Frame pacing locked at 59.73 fps', 'Autosave written (4 KB)', 'Error: shader cache miss for pipeline 0x3f2a (recompiling)',
  'Savestate slot 1 empty', 'Rewind buffer: 600 frames',
];

function startSession(game, core) {
  const id = `s${++seq}`;
  const info = { sessionId: id, gameId: game.id, coreId: core.id, pid: 40000 + Math.floor(Math.random() * 9000), startedAt: Date.now() };
  let i = 0;
  const timer = setInterval(() => emit({ type: 'log', sessionId: id, line: `[${new Date().toLocaleTimeString()}] ${LOG_LINES[i++ % LOG_LINES.length]}` }), 700);
  sessions.set(id, { info, timer });
  game.lastPlayed = Date.now();
  setTimeout(() => emit({ type: 'log', sessionId: id, line: `Starting ${core.name} with ${game.path}` }), 60);
  return info;
}

const byId = (id) => games.find((x) => x.id === id);
const library = () => clone({ folders: FOLDERS, games });

function defaultCoreFor(game) {
  if (game.system === 'gb' || game.system === 'gbc') return settings.gbCore;
  return { n64: 'project64', ps3: 'rpcs3', switch: 'ryujinx', '3ds': 'azahar', gba: 'mgba' }[game.system];
}

function extraGames(folder) {
  const tag = folder.split('/').filter(Boolean).pop();
  return [
    g(`x${Date.now()}a`, `${tag} Quest`, 'gba', 'gba', 8, folder),
    g(`x${Date.now()}b`, `${tag} Racing`, 'n64', 'z64', 16, folder),
    g(`x${Date.now()}c`, `${tag} Legends`, '3ds', '3ds', 900, folder),
  ];
}

window.uemu = {
  platform: PLATFORM,
  async getCores() { await wait(120); return clone(CORE_DEFS.map(coreView)); },
  async setCorePath(id, path) {
    const def = CORE_DEFS.find((c) => c.id === id);
    if (!def) throw new Error(`Error invoking remote method 'cores:setPath': Error: Unknown core "${id}"`);
    settings.corePaths = { ...settings.corePaths, [id]: path || null };
    return clone(coreView(def));
  },
  async pickFile(kind) { await wait(150); return kind === 'exe' ? '/opt/homebrew/bin/emulator-custom' : '/Users/demo/ROMs/picked.gba'; },
  async pickFolder() { await wait(150); return '/Users/demo/ROMs/New Arrivals'; },
  async getLibrary() { await wait(350); return library(); },
  async addFolder(path) {
    await wait(1400);
    if (!FOLDERS.includes(path)) { FOLDERS.push(path); games = games.concat(extraGames(path)); }
    return library();
  },
  async removeFolder(path) {
    await wait(120);
    const i = FOLDERS.indexOf(path);
    if (i >= 0) FOLDERS.splice(i, 1);
    games = games.filter((x) => !x.path.startsWith(`${path}/`));
    return library();
  },
  async rescan() { await wait(1200); return library(); },
  async toggleFavorite(gameId) {
    const x = byId(gameId);
    if (!x) throw new Error(`Error invoking remote method 'library:favorite': Error: Unknown game`);
    x.favorite = !x.favorite;
    return clone(x);
  },
  async launch(gameId, opts = {}) {
    await wait(300);
    const game = byId(gameId);
    if (!game) throw new Error(`Error invoking remote method 'game:launch': Error: Unknown game`);
    const def = CORE_DEFS.find((c) => c.id === (opts.coreId || defaultCoreFor(game)));
    const core = def && coreView(def);
    if (!core || core.status !== 'ready') {
      throw new Error(`Error invoking remote method 'game:launch': Error: ${def ? def.name : 'That core'} isn't installed — set its path in Cores.`);
    }
    const info = startSession(game, core);
    return { pid: info.pid, sessionId: info.sessionId };
  },
  async stop(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error(`Error invoking remote method 'game:stop': Error: No such session`);
    clearInterval(s.timer);
    sessions.delete(sessionId);
    setTimeout(() => emit({ type: 'exit', sessionId, code: 0 }), 500);
    return true;
  },
  async getSessions() { return clone([...sessions.values()].map((s) => s.info)); },
  async getSettings() { return clone(settings); },
  async setSettings(patch) { settings = { ...settings, ...patch }; return clone(settings); },
  onSessionEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  async openExternal(url) {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened.');
    window.open(url, '_blank', 'noopener');
    return true;
  },
};

if (params.get('sessions') && games.length) {
  const game = games.find((x) => x.id === 'g09') || games[0];
  startSession(game, coreView(CORE_DEFS.find((c) => c.id === 'azahar')));
}
