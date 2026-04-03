'use strict';

// ===== STATE =====
const state = {
  folderPath: null,
  allMedia: [],          // all scanned files { path, name, type }
  mediaUrls: {},         // path -> local-media:// URL
  displayedItems: [],    // currently shown items (subset / reshuffled)

  // Settings
  gridType: 'uniform',   // 'uniform' | 'random'
  gridCols: 3,
  maxItems: 12,
  imageRotationEnabled: true,
  imageRotationInterval: 10,  // seconds
  videoMode: 'loop',          // 'loop' | 'rotate'
  recursiveScan: false,

  // Internal
  imageTimers: new Map(),  // tileIndex -> intervalId
  imagePools: new Map(),   // tileIndex -> pool of images to cycle through
  videoQueues: new Map(),  // tileIndex -> queue of videos to play next
};

// ===== DOM REFS =====
const elGrid       = document.getElementById('media-grid');
const elEmpty      = document.getElementById('empty-state');
const elStatus     = document.getElementById('status-bar');
const elStatusText = document.getElementById('status-text');
const elFolderPath = document.getElementById('folder-path');
const elSettings   = document.getElementById('settings-panel');

// ===== HELPERS =====
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ===== SETTINGS UI BINDING =====
function bindSettings() {
  document.querySelectorAll('input[name="grid-type"]').forEach(r => {
    r.addEventListener('change', () => {
      state.gridType = r.value;
      rebuildGrid();
    });
  });

  document.getElementById('grid-cols').addEventListener('change', e => {
    state.gridCols = Math.max(1, parseInt(e.target.value, 10) || 3);
    if (state.gridType === 'uniform') rebuildGrid();
  });

  document.getElementById('image-rotation-interval').addEventListener('change', e => {
    state.imageRotationInterval = Math.max(1, parseInt(e.target.value, 10) || 10);
    restartImageTimers();
  });

  document.getElementById('image-rotation-enabled').addEventListener('change', e => {
    state.imageRotationEnabled = e.target.checked;
    if (state.imageRotationEnabled) restartImageTimers();
    else stopAllImageTimers();
  });

  document.querySelectorAll('input[name="video-mode"]').forEach(r => {
    r.addEventListener('change', () => {
      state.videoMode = r.value;
      applyVideoMode();
    });
  });

  document.getElementById('recursive-scan').addEventListener('change', e => {
    state.recursiveScan = e.target.checked;
    if (state.folderPath) loadFolder(state.folderPath);
  });

  document.getElementById('max-items').addEventListener('change', e => {
    state.maxItems = Math.max(1, parseInt(e.target.value, 10) || 12);
    rebuildGrid();
  });

  document.getElementById('btn-reshuffle').addEventListener('click', () => {
    rebuildGrid();
  });
}

// ===== FOLDER LOADING =====
async function loadFolder(folderPath) {
  state.folderPath = folderPath;
  elFolderPath.textContent = folderPath;

  const files = await window.api.scanFolder(folderPath, state.recursiveScan);
  state.allMedia = files;

  // Pre-convert paths to media URLs in bulk
  state.mediaUrls = {};
  await Promise.all(files.map(async f => {
    state.mediaUrls[f.path] = await window.api.toMediaUrl(f.path);
  }));

  rebuildGrid();
}

// ===== GRID BUILD =====
function rebuildGrid() {
  stopAllImageTimers();
  clearGrid();

  if (!state.allMedia.length) {
    showEmpty();
    return;
  }

  // Pick a random subset and separate into images/videos
  const shuffled = shuffle(state.allMedia);
  state.displayedItems = shuffled.slice(0, state.maxItems);

  const images = state.allMedia.filter(m => m.type === 'image');
  const videos = state.allMedia.filter(m => m.type === 'video');

  // Build image pools per tile (all image tiles share the full image pool)
  state.imagePools.clear();
  state.videoQueues.clear();

  showGrid();
  applyGridClass();

  state.displayedItems.forEach((item, index) => {
    const tile = buildTile(item, index, images, videos);
    elGrid.appendChild(tile);

    if (state.gridType === 'random') applyRandomSize(tile);
  });

  updateStatus();

  if (state.imageRotationEnabled) restartImageTimers();
  applyVideoMode();
}

function clearGrid() {
  // Pause all videos before clearing
  elGrid.querySelectorAll('video').forEach(v => v.pause());
  elGrid.innerHTML = '';
  state.imageTimers.forEach(id => clearInterval(id));
  state.imageTimers.clear();
}

function showGrid() {
  elGrid.classList.remove('hidden');
  elEmpty.style.display = 'none';
  elStatus.classList.remove('hidden');
}

function showEmpty() {
  elGrid.classList.add('hidden');
  elEmpty.style.display = '';
  elStatus.classList.add('hidden');
}

function applyGridClass() {
  elGrid.classList.toggle('uniform', state.gridType === 'uniform');
  elGrid.classList.toggle('random',  state.gridType === 'random');
  elGrid.style.setProperty('--cols', state.gridCols);
}

// ===== TILE BUILDER =====
function buildTile(item, index, allImages, allVideos) {
  const tile = document.createElement('div');
  tile.className = 'media-tile';
  tile.dataset.index = index;
  tile.dataset.type = item.type;

  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = item.name;

  if (item.type === 'video') {
    const video = buildVideoElement(item, index, allVideos);
    tile.appendChild(video);

    // Mute toggle button
    const muteBtn = document.createElement('button');
    muteBtn.className = 'tile-mute-btn';
    muteBtn.textContent = '🔇';
    muteBtn.title = 'Toggle mute';
    muteBtn.addEventListener('click', () => {
      video.muted = !video.muted;
      muteBtn.textContent = video.muted ? '🔇' : '🔊';
    });
    tile.appendChild(muteBtn);
  } else {
    const img = buildImageElement(item, index, allImages);
    tile.appendChild(img);
  }

  tile.appendChild(label);
  return tile;
}

function buildVideoElement(item, index, allVideos) {
  const video = document.createElement('video');
  video.src = state.mediaUrls[item.path];
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;

  // Build a rotation queue for this tile (all OTHER videos)
  const otherVideos = allVideos.filter(v => v.path !== item.path);
  const queue = shuffle(otherVideos);
  state.videoQueues.set(index, { queue, currentPath: item.path });

  video.addEventListener('ended', () => onVideoEnded(video, index, allVideos));
  video.addEventListener('error', () => onVideoError(video, index, allVideos));

  if (state.videoMode === 'loop') {
    video.loop = true;
  }

  return video;
}

function buildImageElement(item, index, allImages) {
  const img = document.createElement('img');
  img.src = state.mediaUrls[item.path];
  img.alt = item.name;
  img.loading = 'lazy';
  img.dataset.currentPath = item.path;

  // Build image pool for cycling (all OTHER images, shuffled)
  const pool = shuffle(allImages.filter(i => i.path !== item.path));
  if (pool.length === 0) pool.push(item); // only one image – repeat itself
  state.imagePools.set(index, { pool, position: 0, currentItem: item });

  return img;
}

// ===== RANDOM TILE SIZING =====
function applyRandomSize(tile) {
  // Give each tile a random width between ~15% and ~45% of container
  // and height between 120px and 300px; CSS flexwrap handles layout
  const w = randomBetween(15, 45);
  const h = randomBetween(120, 320);
  tile.style.width = `calc(${w}% - 6px)`;
  tile.style.height = `${h}px`;
}

// ===== VIDEO MODE =====
function applyVideoMode() {
  elGrid.querySelectorAll('video').forEach(video => {
    video.loop = (state.videoMode === 'loop');
  });
}

function onVideoEnded(video, index, allVideos) {
  if (state.videoMode !== 'rotate') return;
  rotateVideo(video, index, allVideos);
}

function onVideoError(video, index, allVideos) {
  // Skip broken video to next
  rotateVideo(video, index, allVideos);
}

function rotateVideo(video, index, allVideos) {
  if (allVideos.length === 0) return;

  const state_ = state.videoQueues.get(index);
  if (!state_) return;

  let { queue, currentPath } = state_;

  // If queue exhausted, reshuffle (excluding current)
  if (queue.length === 0) {
    queue = shuffle(allVideos.filter(v => v.path !== currentPath));
    if (queue.length === 0) {
      // Only one video available – just replay
      video.currentTime = 0;
      video.play().catch(() => {});
      return;
    }
  }

  const next = queue.shift();
  state.videoQueues.set(index, { queue, currentPath: next.path });
  video.src = state.mediaUrls[next.path];
  video.play().catch(() => {});

  // Update tile label
  const tile = video.closest('.media-tile');
  if (tile) {
    const label = tile.querySelector('.tile-label');
    if (label) label.textContent = next.name;
  }
}

// ===== IMAGE ROTATION =====
function restartImageTimers() {
  stopAllImageTimers();
  if (!state.imageRotationEnabled) return;

  elGrid.querySelectorAll('.media-tile[data-type="image"]').forEach(tile => {
    const index = parseInt(tile.dataset.index, 10);
    const intervalMs = state.imageRotationInterval * 1000;
    const id = setInterval(() => rotateImage(tile, index), intervalMs);
    state.imageTimers.set(index, id);
  });
}

function stopAllImageTimers() {
  state.imageTimers.forEach(id => clearInterval(id));
  state.imageTimers.clear();
}

function rotateImage(tile, index) {
  const pool = state.imagePools.get(index);
  if (!pool || pool.pool.length === 0) return;

  const img = tile.querySelector('img');
  if (!img) return;

  const next = pool.pool[pool.position % pool.pool.length];
  pool.position = (pool.position + 1) % pool.pool.length;

  // Fade animation
  img.classList.add('fading');
  img.addEventListener('animationend', () => {
    img.classList.remove('fading');
  }, { once: true });

  img.src = state.mediaUrls[next.path];
  img.alt = next.name;
  img.dataset.currentPath = next.path;

  const label = tile.querySelector('.tile-label');
  if (label) label.textContent = next.name;
}

// ===== STATUS BAR =====
function updateStatus() {
  const images = state.displayedItems.filter(i => i.type === 'image').length;
  const videos = state.displayedItems.filter(i => i.type === 'video').length;
  const total  = state.allMedia.length;
  elStatusText.textContent =
    `Showing ${state.displayedItems.length} of ${total} items  ·  ${images} images  ·  ${videos} videos`;
}

// ===== EVENT WIRING =====
async function openFolder() {
  const folderPath = await window.api.openFolder();
  if (folderPath) loadFolder(folderPath);
}

document.getElementById('btn-open-folder').addEventListener('click', openFolder);
document.getElementById('btn-open-folder-empty').addEventListener('click', openFolder);

document.getElementById('btn-settings').addEventListener('click', () => {
  elSettings.classList.toggle('hidden');
});

document.getElementById('btn-close-settings').addEventListener('click', () => {
  elSettings.classList.add('hidden');
});

document.getElementById('btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen();
  }
});

// ===== INIT =====
bindSettings();
showEmpty();
