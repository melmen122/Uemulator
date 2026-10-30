'use strict';
// Shared Windows install-location helper for the adapters. Pure: all inputs come from the caller
// (env/homedir are injected), and every path is built with path.win32 so it is correct on any host.
const win32 = require('path').win32;

/**
 * Candidate `<root>\<dir>\<exeName>` paths for an emulator installed in the usual Windows places:
 * Program Files (x64 / x86), %LOCALAPPDATA%\Programs and %LOCALAPPDATA% (per-user installers),
 * and the folder portable zips are typically unpacked to (<home>\<dir>).
 * Deliberately NOT included: <SystemDrive>\<dir> (e.g. C:\RPCS3). On a default Windows install any local
 * user can create top-level folders on C:\, so a planted C:\<dir>\<exe> would be picked up and run as the
 * current user. Only admin-writable (Program Files) or per-user (home / LOCALAPPDATA) locations are trusted.
 * @param {{env?:object, homedir?:string}} ctx
 * @param {string[]} dirs folder names the emulator uses (e.g. ['mGBA'])
 * @param {string} exeName e.g. 'mGBA.exe'
 * @returns {string[]} absolute win32 paths, de-duplicated, in priority order
 */
function windowsInstallCandidates(ctx, dirs, exeName) {
  const env = (ctx && ctx.env) || {};
  const homedir = (ctx && ctx.homedir) || env.USERPROFILE || '';
  const local = env.LOCALAPPDATA;
  const bases = [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.ProgramW6432,
    local && win32.join(local, 'Programs'),
    local,
    homedir,
  ];
  const out = [];
  for (const base of bases) {
    if (typeof base !== 'string' || base.length === 0 || !win32.isAbsolute(base)) continue;
    for (const dir of dirs) {
      const p = win32.join(base, dir, exeName);
      if (!out.includes(p)) out.push(p);
    }
  }
  return out;
}

module.exports = { windowsInstallCandidates };
