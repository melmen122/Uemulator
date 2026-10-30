'use strict';
// Sandbox-safe preload: only require('electron'). Exposes a minimal, fixed API; never ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('uemu', {
  getCores: () => invoke('cores:list'),
  setCorePath: (id, path) => invoke('cores:setPath', id, path),
  pickFile: (kind) => invoke('dialog:pickFile', kind),
  pickFolder: () => invoke('dialog:pickFolder'),
  getLibrary: () => invoke('library:get'),
  addFolder: (path) => invoke('library:addFolder', path),
  removeFolder: (path) => invoke('library:removeFolder', path),
  rescan: () => invoke('library:rescan'),
  toggleFavorite: (gameId) => invoke('library:favorite', gameId),
  launch: (gameId, opts) => invoke('game:launch', gameId, opts),
  stop: (sessionId) => invoke('game:stop', sessionId),
  getSessions: () => invoke('game:sessions'),
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  openExternal: (url) => invoke('shell:openExternal', url),
  onSessionEvent: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('onSessionEvent expects a function');
    // The IPC event object (with sender) is never forwarded to the page.
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('game:event', listener);
    return () => ipcRenderer.removeListener('game:event', listener);
  },
});
