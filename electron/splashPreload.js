const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onSplashStatus: (callback) => ipcRenderer.on('splash-status', (_, msg) => callback(msg)),
  onSplashError: (callback) => ipcRenderer.on('splash-error', (_, msg) => callback(msg)),
});
