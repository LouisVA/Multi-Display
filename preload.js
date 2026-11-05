const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mediaAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getMediaFiles: (folderPath) => ipcRenderer.invoke('get-media-files', folderPath),
  listPresets: (folderPath) => ipcRenderer.invoke('list-presets', folderPath),
  savePreset: (folderPath, title, snapshot, presetId) =>
    ipcRenderer.invoke('save-preset', folderPath, title, snapshot, presetId),
  deletePreset: (folderPath, presetId) => ipcRenderer.invoke('delete-preset', folderPath, presetId),
  onCloseRequest: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app-close-request', listener);
    return () => ipcRenderer.removeListener('app-close-request', listener);
  },
  resolveClose: (action) => ipcRenderer.invoke('resolve-close', action),
});
