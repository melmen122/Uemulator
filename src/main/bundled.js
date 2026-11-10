'use strict';

const path = require('node:path');

/**
 * Directory that holds the emulator cores shipped with the app.
 * Packaged: electron-builder extraResources land in <resources>/emulators.
 * Dev: the repo's bin/ folder (populated by scripts/build-cores.mjs).
 * Pure: no fs access, never throws on missing keys.
 */
function bundledBinDir({ isPackaged, resourcesPath, appPath } = {}) {
  if (isPackaged === true && typeof resourcesPath === 'string' && resourcesPath !== '') {
    return path.join(resourcesPath, 'emulators');
  }
  return path.join(String(appPath || ''), 'bin');
}

module.exports = { bundledBinDir };
