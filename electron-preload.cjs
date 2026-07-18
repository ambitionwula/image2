const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopStorage', {
  selectDirectory: () => ipcRenderer.invoke('select-save-directory'),
  loadSettings: () => ipcRenderer.invoke('load-app-settings'),
  saveSettings: settings => ipcRenderer.invoke('save-app-settings', settings),
})
