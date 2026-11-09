const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

let mainWindow;
let closeRequestPending = false;
let allowWindowClose = false;
let rendererReady = false;
const presetWrites = new Map();

function createWindow() {
  const { setupDisplayWindow } = require('./src/display-window.cjs');
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
  setupDisplayWindow(mainWindow);
  mainWindow.webContents.once('did-finish-load', () => { rendererReady = true; });
  mainWindow.on('close', (event) => {
    if (allowWindowClose) {
      allowWindowClose = false;
      return;
    }
    event.preventDefault();
    if (closeRequestPending) return;
    if (!rendererReady) {
      closeRequestPending = false;
      allowWindowClose = true;
      mainWindow.close();
      return;
    }
    closeRequestPending = true;
    mainWindow.webContents.send('app-close-request');
  });
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
  return { folderPath, files: await getMediaFiles(folderPath) };
});

// ── IPC: re-scan a folder ────────────────────────────────────────────────────

ipcMain.handle('get-media-files', async (_event, folderPath) => {
  return getMediaFiles(folderPath);
});

ipcMain.handle('list-presets', async (_event, folderPath) => {
  const file = presetFile(folderPath);
  try {
    const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return validatePresetFile(data).presets;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Saved layouts could not be read.');
  }
});

ipcMain.handle('save-preset', async (_event, folderPath, title, snapshot, presetId = null) => {
  const validSnapshot = validateSnapshot(snapshot);
  const cleanTitle = typeof title === 'string' ? title.trim().slice(0, 80) : '';
  return updatePresets(folderPath, (data) => {
    const now = new Date().toISOString();
    let preset = presetId ? data.presets.find((item) => item.id === presetId) : null;
    if (presetId && !preset) throw new Error('The selected saved layout no longer exists.');
    if (preset) {
      preset.title = cleanTitle || preset.title;
      preset.updatedAt = now;
      preset.snapshot = validSnapshot;
    } else {
      if (data.presets.length >= 200) throw new Error('This folder already has 200 saved layouts.');
      preset = {
        id: crypto.randomUUID(),
        title: cleanTitle,
        createdAt: now,
        updatedAt: now,
        snapshot: validSnapshot,
      };
      data.presets.push(preset);
    }
    return preset;
  });
});

ipcMain.handle('delete-preset', async (_event, folderPath, presetId) => {
  if (typeof presetId !== 'string' || !presetId.trim() || presetId.length > 80) {
    throw new Error('A valid saved layout is required.');
  }
  return updatePresets(folderPath, (data) => {
    const index = data.presets.findIndex((preset) => preset.id === presetId);
    if (index < 0) throw new Error('The selected saved layout no longer exists.');
    data.presets.splice(index, 1);
    return presetId;
  });
});

ipcMain.handle('resolve-close', async (_event, action) => {
  if (!closeRequestPending) return false;
  if (action === 'cancel') {
    closeRequestPending = false;
    return true;
  }
  if (action !== 'discard' && action !== 'saved') return false;
  closeRequestPending = false;
  allowWindowClose = true;
  mainWindow.close();
  return true;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif',
]);
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v', '.ogv',
]);

function updatePresets(folderPath, update) {
  const file = presetFile(folderPath);
  const previous = presetWrites.get(file) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    let data = { version: 1, presets: [] };
    try {
      data = validatePresetFile(JSON.parse(await fs.promises.readFile(file, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Saved layouts could not be read.');
    }
    const result = update(data);
    await writeJsonAtomically(file, data);
    return result;
  });
  presetWrites.set(file, pending);
  const release = () => {
    if (presetWrites.get(file) === pending) presetWrites.delete(file);
  };
  pending.then(release, release);
  return pending;
}

function presetFile(folderPath) {
  if (typeof folderPath !== 'string' || !path.isAbsolute(folderPath)) {
    throw new Error('A valid folder is required.');
  }
  const normalized = process.platform === 'win32'
    ? path.normalize(folderPath).toLowerCase()
    : path.normalize(folderPath);
  const key = crypto.createHash('sha256').update(normalized).digest('hex');
  return path.join(app.getPath('userData'), 'presets', `${key}.json`);
}

function validatePresetFile(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.presets) || value.presets.length > 200) {
    throw new Error('Invalid saved layout data.');
  }
  return { version: 1, presets: value.presets.map(validatePreset) };
}

function validatePreset(value) {
  if (!value || typeof value.id !== 'string' || value.id.length > 80 ||
      typeof value.title !== 'string' || value.title.length > 80 ||
      typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    throw new Error('Invalid saved layout data.');
  }
  return {
    id: value.id,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    snapshot: validateSnapshot(value.snapshot),
  };
}

function validateSnapshot(value) {
  const modes = new Set(['uniform', 'masonry', 'smart-masonry']);
  const filters = new Set(['mixed', 'image', 'video']);
  const fitModes = new Set(['crop', 'fit']);
  const behaviors = new Set(['loop', 'rotate']);
  const settings = value?.settings;
  if (!value || value.version !== 1 || !settings || !modes.has(settings.gridMode) ||
      !filters.has(settings.mediaFilter) || !fitModes.has(settings.fitMode) ||
      !behaviors.has(settings.videoBehavior) || !Number.isInteger(settings.slotCount) ||
      settings.slotCount < 1 || settings.slotCount > 48 || !Number.isFinite(settings.imageTime) ||
      settings.imageTime < 3 || settings.imageTime > 120 || !Number.isFinite(settings.gap) ||
      settings.gap < 0 || settings.gap > 24 || typeof settings.redrawOnRefresh !== 'boolean' ||
      !Array.isArray(value.geometry) || value.geometry.length > 48 ||
      !value.masonry || !Number.isInteger(value.masonry.columns) || value.masonry.columns < 1 || value.masonry.columns > 48 ||
      !Number.isInteger(value.masonry.rows) || value.masonry.rows < 1 || value.masonry.rows > 48 ||
      !value.grid || !Number.isInteger(value.grid.columns) || value.grid.columns < 1 || value.grid.columns > 48 ||
      !Number.isInteger(value.grid.rows) || value.grid.rows < 1 || value.grid.rows > 48 ||
      !Array.isArray(value.pins) || value.pins.length > 48 ||
      !Array.isArray(value.ignored) || value.ignored.length > 10000) {
    throw new Error('Invalid saved layout data.');
  }
  const geometry = value.geometry.map((item) => {
    if (!item || !['x', 'y', 'w', 'h'].every((key) => Number.isInteger(item[key])) ||
        item.x < 1 || item.x > 48 || item.y < 1 || item.y > 48 ||
        item.w < 1 || item.w > 48 || item.h < 1 || item.h > 48) {
      throw new Error('Invalid saved layout geometry.');
    }
    return { x: item.x, y: item.y, w: item.w, h: item.h };
  });
  const pins = value.pins.map((item) => {
    if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= 48 ||
        typeof item.mediaKey !== 'string' || item.mediaKey.length > 4096) {
      throw new Error('Invalid saved layout pins.');
    }
    return { index: item.index, mediaKey: item.mediaKey };
  });
  if (value.ignored.some((item) => typeof item !== 'string' || item.length > 4096)) {
    throw new Error('Invalid saved ignored media.');
  }
  return {
    version: 1,
    settings: {
      gridMode: settings.gridMode,
      slotCount: settings.slotCount,
      imageTime: settings.imageTime,
      videoBehavior: settings.videoBehavior,
      gap: settings.gap,
      redrawOnRefresh: settings.redrawOnRefresh,
      mediaFilter: settings.mediaFilter,
      fitMode: settings.fitMode,
    },
    geometry,
    masonry: { columns: value.masonry.columns, rows: value.masonry.rows },
    grid: { columns: value.grid.columns, rows: value.grid.rows },
    pins,
    ignored: [...new Set(value.ignored)],
  };
}

async function writeJsonAtomically(file, value) {
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
    await fs.promises.rename(temp, file);
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function getMediaFiles(folderPath) {
  try {
    const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    const files = entries
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
    // File identity invalidates cached dimensions after a file changes.
    // Bound stat calls so large folders do not saturate the disk.
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
      while (nextIndex < files.length) {
        const file = files[nextIndex++];
        try {
          const stat = await fs.promises.stat(file.path);
          file.size = stat.size;
          file.modified = stat.mtimeMs;
        } catch {
          file.unavailable = true;
        }
      }
    }));
    return files.filter((file) => !file.unavailable);
  } catch (err) {
    console.error('Error reading folder:', err);
    return [];
  }
}
