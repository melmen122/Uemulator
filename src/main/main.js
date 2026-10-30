'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const { createStore } = require('./store');
const { createProcessManager } = require('./processes');
const { registerIpc, RENDERER_INDEX_URL } = require('./ipc');

// Keep in sync with the <meta> CSP in the renderer's index.html.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** @type {Electron.BrowserWindow|null} */
let mainWindow = null;
let quitting = false;

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

const processes = createProcessManager({ emit: (ev) => sendToWindow('game:event', ev) });

function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#0f1115',
    show: false,
    title: 'Uemulator',
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  const wc = mainWindow.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());

  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  // Load the exact URL the IPC sender check compares against; loadFile() encodes [ ] ~ % differently.
  mainWindow.loadURL(RENDERER_INDEX_URL);
}

function installSecurity() {
  const ses = session.defaultSession;
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] },
    });
  });
  // The app never needs browser permissions (camera, geolocation, ...).
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    installSecurity();
    const store = createStore({ dir: app.getPath('userData') });
    registerIpc(ipcMain, {
      store,
      processes,
      dialog,
      shell,
      getWindow: () => mainWindow || undefined,
      resolveDeps: { binDir: path.join(app.getAppPath(), 'bin') },
    });
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Make sure no emulator outlives the launcher.
  app.on('before-quit', (e) => {
    if (quitting || processes.size === 0) return;
    e.preventDefault();
    quitting = true;
    processes.killAll().finally(() => app.quit());
  });
}
