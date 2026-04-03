'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

let mainWindow;

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tiff', '.tif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv', '.m4v', '.flv']);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1a1a2e',
    title: 'Multi Display',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Register a local-file protocol so the renderer can load media via safe URLs
  protocol.registerFileProtocol('local-media', (request, callback) => {
    const filePath = decodeURIComponent(request.url.replace('local-media://', ''));
    callback({ path: filePath });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: Open a folder dialog and return the selected path
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Media Folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// IPC: Scan a folder for media files (non-recursive and recursive option)
ipcMain.handle('fs:scanFolder', async (_event, folderPath, recursive = false) => {
  if (!folderPath) return [];

  function scanDir(dir) {
    let items = [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return items;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && recursive) {
        items = items.concat(scanDir(fullPath));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext)) {
          items.push({ path: fullPath, name: entry.name, type: 'image' });
        } else if (VIDEO_EXTENSIONS.has(ext)) {
          items.push({ path: fullPath, name: entry.name, type: 'video' });
        }
      }
    }
    return items;
  }

  return scanDir(folderPath);
});

// IPC: Convert a local file path to a safe local-media:// URL
ipcMain.handle('fs:toMediaUrl', (_event, filePath) => {
  return 'local-media://' + encodeURIComponent(filePath);
});
