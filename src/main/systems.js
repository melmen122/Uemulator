'use strict';
// System table (plan.md §3.1). Pure module: no Electron, no I/O.
const path = require('path');

/** @type {ReadonlyArray<{id:string,name:string,extensions:string[],coreId:string,altCores:string[]}>} */
const SYSTEMS = Object.freeze([
  { id: 'n64', name: 'Nintendo 64', extensions: ['.z64', '.n64', '.v64'], coreId: 'project64', altCores: [] },
  { id: 'switch', name: 'Nintendo Switch', extensions: ['.nsp', '.xci', '.nca', '.nro'], coreId: 'ryujinx', altCores: [] },
  // NOTE: ".app" is also the macOS bundle extension (a directory). Callers must only treat
  // regular files as ROMs (library.js enforces this); detectSystem only looks at the extension.
  { id: '3ds', name: 'Nintendo 3DS', extensions: ['.3ds', '.cci', '.cxi', '.cia', '.3dsx', '.app'], coreId: 'azahar', altCores: [] },
  { id: 'gba', name: 'Game Boy Advance', extensions: ['.gba'], coreId: 'mgba', altCores: [] },
  { id: 'gbc', name: 'Game Boy Color', extensions: ['.gbc'], coreId: 'mgba', altCores: ['pyboy'] },
  { id: 'gb', name: 'Game Boy', extensions: ['.gb'], coreId: 'mgba', altCores: ['pyboy'] },
  // PS3: disc images (.iso) plus EBOOT.BIN, which is matched by file NAME (see isPs3Eboot) because
  // ".bin" is far too generic to claim as an extension. .pkg is an installer, so it is not listed.
  { id: 'ps3', name: 'PlayStation 3', extensions: ['.iso'], coreId: 'rpcs3', altCores: [] },
].map((s) => Object.freeze(s)));

const GB_CORES = Object.freeze(['mgba', 'pyboy']);

const byExtension = new Map();
for (const s of SYSTEMS) for (const ext of s.extensions) byExtension.set(ext, s.id);

/** All recognised extensions (lowercase, with leading dot). */
const EXTENSIONS = Object.freeze([...byExtension.keys()]);

function getSystem(systemId) {
  return SYSTEMS.find((s) => s.id === systemId) || null;
}

/** File name (case-insensitive) that boots a PS3 game folder: <Game>/PS3_GAME/USRDIR/EBOOT.BIN or <TITLEID>/USRDIR/EBOOT.BIN. */
const PS3_EBOOT_NAME = 'eboot.bin';

/** Last path component, accepting both slash and backslash separators regardless of host OS. */
function lastComponent(p) {
  return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
}

/** True when the path's file name is EBOOT.BIN (any case). */
function isPs3Eboot(filePath) {
  return typeof filePath === 'string' && lastComponent(filePath).toLowerCase() === PS3_EBOOT_NAME;
}

/** True for an EBOOT.BIN that sits directly inside a folder named USRDIR (any case). Used by the library scanner. */
function isUsrdirEboot(filePath) {
  if (!isPs3Eboot(filePath)) return false;
  const parts = filePath.split(/[\\/]/);
  return parts.length >= 2 && parts[parts.length - 2].toLowerCase() === 'usrdir';
}

/** @returns {string|null} system id for a file path (case-insensitive extension; EBOOT.BIN by name), or null. */
function detectSystem(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  if (isPs3Eboot(filePath)) return 'ps3';
  const ext = path.extname(filePath).toLowerCase();
  return byExtension.get(ext) || null;
}

/**
 * Core that should run a system. gb/gbc honour settings.gbCore (mgba|pyboy).
 * @returns {string|null}
 */
function coreForSystem(systemId, settings) {
  const sys = getSystem(systemId);
  if (!sys) return null;
  if ((systemId === 'gb' || systemId === 'gbc') && settings && GB_CORES.includes(settings.gbCore)) {
    return settings.gbCore;
  }
  return sys.coreId;
}

/** Core ids that are able to run a given system (default core first). */
function coresForSystem(systemId) {
  const sys = getSystem(systemId);
  return sys ? [sys.coreId, ...sys.altCores] : [];
}

module.exports = { SYSTEMS, EXTENSIONS, GB_CORES, PS3_EBOOT_NAME, getSystem, detectSystem, isPs3Eboot, isUsrdirEboot, coreForSystem, coresForSystem };
