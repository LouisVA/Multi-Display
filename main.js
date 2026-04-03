const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      allowFileAccessFromFileUrls: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: open folder dialog ──────────────────────────────────────────────────

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Media Folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const folderPath = result.filePaths[0];
  return { folderPath, files: getMediaFiles(folderPath) };
});

// ── IPC: re-scan a folder ────────────────────────────────────────────────────

ipcMain.handle('get-media-files', async (_event, folderPath) => {
  return getMediaFiles(folderPath);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif',
]);
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v', '.ogv',
]);

function getMediaFiles(folderPath) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => {
        const ext = path.extname(e.name).toLowerCase();
        const type = IMAGE_EXTENSIONS.has(ext)
          ? 'image'
          : VIDEO_EXTENSIONS.has(ext)
          ? 'video'
          : null;
        if (!type) return null;
        const filePath = path.join(folderPath, e.name);
        return {
          name: e.name,
          path: filePath,
          url: pathToFileURL(filePath).href,
          type,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error('Error reading folder:', err);
    return [];
  }
}
