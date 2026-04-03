const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mediaAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getMediaFiles: (folderPath) => ipcRenderer.invoke('get-media-files', folderPath),
});
