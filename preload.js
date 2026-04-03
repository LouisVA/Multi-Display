'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  scanFolder: (folderPath, recursive) => ipcRenderer.invoke('fs:scanFolder', folderPath, recursive),
  toMediaUrl: (filePath) => ipcRenderer.invoke('fs:toMediaUrl', filePath),
});
