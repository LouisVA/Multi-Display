/**
 * Multi-Display – renderer process
 *
 * MediaGrid class manages:
 *  - Building / rebuilding the CSS grid
 *  - Cycling media via a shuffled pool
 *  - Image rotation timers
 *  - Video loop / rotate behavior
 *  - Fade-transition swaps
 *  - Pause / resume
 */

class MediaGrid {
  constructor(gridEl) {
    this.gridEl = gridEl;

    /** @type {Array<{name:string, path:string, url:string, type:'image'|'video'}>} */
    this.mediaFiles = [];

    /** @type {Array<{cell:HTMLElement, mediaEl:HTMLElement, media:object, timer:number|null}>} */
    this.displayedItems = [];

    this.pool = [];
    this.poolIndex = 0;

    this.running = false;
    this.paused = false;

    this.settings = {
      gridMode: 'uniform',   // 'uniform' | 'masonry'
      columns: 3,            // used in uniform mode
      imageTime: 10,         // seconds before image is replaced
      videoBehavior: 'loop', // 'loop' | 'rotate'
      gap: 2,                // px gap between cells
    };
  }

  // ── Pool management ──────────────────────────────────────────────────────

  reshufflePool() {
    this.pool = [...this.mediaFiles].sort(() => Math.random() - 0.5);
    this.poolIndex = 0;
  }

  getNextMedia() {
    if (this.mediaFiles.length === 0) return null;
    if (this.poolIndex >= this.pool.length) this.reshufflePool();
    return this.pool[this.poolIndex++];
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  setMedia(files) {
    this.mediaFiles = files;
    this.reshufflePool();
  }

  start() {
    this.running = true;
    this.paused = false;
    this.buildGrid();
  }

  stop() {
    this.running = false;
    this._clearGrid();
  }

  _clearGrid() {
    for (const item of this.displayedItems) {
      if (item.timer) clearTimeout(item.timer);
    }
    this.displayedItems = [];
    this.gridEl.innerHTML = '';
  }

  // ── Grid construction ────────────────────────────────────────────────────

  buildGrid() {
    this._clearGrid();

    const { gridMode, columns, gap } = this.settings;

    this.gridEl.style.gap = `${gap}px`;
    this.gridEl.style.gridAutoFlow = gridMode === 'masonry' ? 'dense' : 'row';

    if (gridMode === 'uniform') {
      const rows = this._uniformRows(columns, gap);
      this.gridEl.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
      this.gridEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      this.gridEl.style.gridAutoRows = '';

      const count = columns * rows;
      for (let i = 0; i < count; i++) this._addCell();
    } else {
      // Masonry: 6-column base, auto-rows sized to ¼ viewport height
      const baseCols = 6;
      const rowH = this._masonryRowHeight(gap, baseCols);
      this.gridEl.style.gridTemplateColumns = `repeat(${baseCols}, 1fr)`;
      this.gridEl.style.gridTemplateRows = '';
      this.gridEl.style.gridAutoRows = `${rowH}px`;

      for (let i = 0; i < 24; i++) this._addCell();
    }
  }

  /** Calculate how many rows are needed to fill the viewport in uniform mode */
  _uniformRows(columns, gap) {
    const w = this.gridEl.clientWidth || window.innerWidth;
    const h = this.gridEl.clientHeight || window.innerHeight;
    const cellW = (w - gap * (columns - 1)) / columns;
    return Math.max(2, Math.ceil(h / (cellW + gap)));
  }

  /** Single row height for masonry (¼ viewport) */
  _masonryRowHeight(gap, baseCols) {
    const w = this.gridEl.clientWidth || window.innerWidth;
    const unitW = (w - gap * (baseCols - 1)) / baseCols;
    return Math.max(80, Math.round(unitW));
  }

  /** Random col/row span distribution for masonry cells */
  _randomSpan() {
    const r = Math.random();
    if (r < 0.40) return { col: 2, row: 2 };
    if (r < 0.60) return { col: 3, row: 2 };
    if (r < 0.75) return { col: 2, row: 1 };
    if (r < 0.88) return { col: 3, row: 1 };
    if (r < 0.94) return { col: 1, row: 2 };
    return { col: 4, row: 2 };
  }

  // ── Cell / media element helpers ─────────────────────────────────────────

  _addCell() {
    const media = this.getNextMedia();
    if (!media) return;

    const cell = document.createElement('div');
    cell.className = 'grid-cell';

    if (this.settings.gridMode === 'masonry') {
      const { col, row } = this._randomSpan();
      cell.style.gridColumn = `span ${col}`;
      cell.style.gridRow = `span ${row}`;
    }

    const mediaEl = this._createMediaEl(media);
    cell.appendChild(mediaEl);
    this.gridEl.appendChild(cell);

    const item = { cell, mediaEl, media, timer: null };
    this.displayedItems.push(item);
    this._scheduleRotation(item);
  }

  _createMediaEl(media) {
    let el;
    if (media.type === 'image') {
      el = document.createElement('img');
      el.src = media.url;
      el.alt = '';
      el.addEventListener('error', () => el.classList.add('media-error'));
    } else {
      el = document.createElement('video');
      el.src = media.url;
      el.autoplay = true;
      el.muted = true;
      el.playsInline = true;
      el.loop = this.settings.videoBehavior === 'loop';
      el.addEventListener('error', () => el.classList.add('media-error'));
    }
    el.className = 'media-element';
    return el;
  }

  // ── Rotation scheduling ──────────────────────────────────────────────────

  _scheduleRotation(item) {
    if (this.paused) return;

    if (item.media.type === 'image') {
      item.timer = setTimeout(
        () => this._replaceItem(item),
        this.settings.imageTime * 1000
      );
    } else {
      // video
      const loop = this.settings.videoBehavior === 'loop';
      item.mediaEl.loop = loop;
      if (!loop) {
        const onEnded = () => {
          item.mediaEl.removeEventListener('ended', onEnded);
          this._replaceItem(item);
        };
        item.mediaEl.addEventListener('ended', onEnded);
      }
    }
  }

  _replaceItem(item) {
    if (!this.running || this.paused) return;
    if (item.timer) { clearTimeout(item.timer); item.timer = null; }

    const newMedia = this.getNextMedia();
    if (!newMedia) return;

    // Fade out
    item.mediaEl.classList.add('fade-out');

    setTimeout(() => {
      const oldEl = item.mediaEl;
      const newEl = this._createMediaEl(newMedia);

      // Start invisible, then fade in
      newEl.style.opacity = '0';
      item.cell.appendChild(newEl);
      oldEl.remove();

      item.mediaEl = newEl;
      item.media = newMedia;

      // Double rAF ensures initial opacity:0 is painted before transition
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          newEl.style.transition = 'opacity 0.6s ease';
          newEl.style.opacity = '1';
          newEl.addEventListener(
            'transitionend',
            () => { newEl.style.transition = ''; },
            { once: true }
          );
          this._scheduleRotation(item);
        });
      });
    }, 600);
  }

  // ── Pause / resume ───────────────────────────────────────────────────────

  togglePause() {
    this.paused = !this.paused;

    if (this.paused) {
      for (const item of this.displayedItems) {
        if (item.media.type === 'video') item.mediaEl.pause();
        if (item.timer) { clearTimeout(item.timer); item.timer = null; }
      }
    } else {
      for (const item of this.displayedItems) {
        if (item.media.type === 'video') item.mediaEl.play().catch(() => {});
        this._scheduleRotation(item);
      }
    }
    return this.paused;
  }

  // ── Settings update ──────────────────────────────────────────────────────

  updateSettings(changes) {
    const prev = { ...this.settings };
    Object.assign(this.settings, changes);

    // Toggle video loop without full rebuild
    if ('videoBehavior' in changes) {
      for (const item of this.displayedItems) {
        if (item.media.type === 'video') {
          item.mediaEl.loop = changes.videoBehavior === 'loop';
        }
      }
    }

    // Reset image timers when imageTime changes
    if ('imageTime' in changes) {
      for (const item of this.displayedItems) {
        if (item.media.type === 'image') {
          if (item.timer) clearTimeout(item.timer);
          item.timer = setTimeout(
            () => this._replaceItem(item),
            this.settings.imageTime * 1000
          );
        }
      }
    }

    // Rebuild grid for layout-affecting changes
    const layoutKeys = ['gridMode', 'columns', 'gap'];
    if (this.running && layoutKeys.some((k) => k in changes && prev[k] !== changes[k])) {
      this.reshufflePool();
      this.buildGrid();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// App bootstrap
// ═══════════════════════════════════════════════════════════════════════════════

const grid = new MediaGrid(document.getElementById('grid'));

// ── DOM refs ─────────────────────────────────────────────────────────────────

const emptyState          = document.getElementById('empty-state');
const gridEl              = document.getElementById('grid');
const settingsToggle      = document.getElementById('settings-toggle');
const settingsPanel       = document.getElementById('settings-panel');
const settingsClose       = document.getElementById('settings-close');
const loadFolderBtn       = document.getElementById('load-folder-btn');
const loadFolderSettings  = document.getElementById('load-folder-settings');
const folderPathEl        = document.getElementById('folder-path');
const columnsSection      = document.getElementById('columns-section');
const columnsSlider       = document.getElementById('columns-slider');
const columnsValue        = document.getElementById('columns-value');
const imageTimeSlider     = document.getElementById('image-time-slider');
const imageTimeValue      = document.getElementById('image-time-value');
const gapSlider           = document.getElementById('gap-slider');
const gapValue            = document.getElementById('gap-value');
const pauseBtn            = document.getElementById('pause-btn');
const fullscreenBtn       = document.getElementById('fullscreen-btn');

// ── Settings panel toggle ─────────────────────────────────────────────────────

function openSettings()  { settingsPanel.classList.add('open'); }
function closeSettings() { settingsPanel.classList.remove('open'); }
function toggleSettings() { settingsPanel.classList.toggle('open'); }

settingsToggle.addEventListener('click', toggleSettings);
settingsClose.addEventListener('click', closeSettings);

// ── Grid mode buttons ─────────────────────────────────────────────────────────

document.querySelectorAll('[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const mode = btn.dataset.mode;
    columnsSection.style.display = mode === 'uniform' ? 'block' : 'none';
    grid.updateSettings({ gridMode: mode });
  });
});

// ── Video behavior buttons ────────────────────────────────────────────────────

document.querySelectorAll('[data-video]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-video]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    grid.updateSettings({ videoBehavior: btn.dataset.video });
  });
});

// ── Sliders ───────────────────────────────────────────────────────────────────

columnsSlider.addEventListener('input', () => {
  const val = parseInt(columnsSlider.value, 10);
  columnsValue.textContent = val;
  grid.updateSettings({ columns: val });
});

imageTimeSlider.addEventListener('input', () => {
  const val = parseInt(imageTimeSlider.value, 10);
  imageTimeValue.textContent = `${val} s`;
  grid.updateSettings({ imageTime: val });
});

gapSlider.addEventListener('input', () => {
  const val = parseInt(gapSlider.value, 10);
  gapValue.textContent = `${val} px`;
  grid.updateSettings({ gap: val });
});

// ── Pause / resume ────────────────────────────────────────────────────────────

pauseBtn.addEventListener('click', () => {
  const isPaused = grid.togglePause();
  pauseBtn.textContent = isPaused ? '▶ Resume All' : '⏸ Pause All';
});

// ── Fullscreen ────────────────────────────────────────────────────────────────

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
    fullscreenBtn.textContent = '⛶ Exit Fullscreen';
  } else {
    document.exitFullscreen().catch(() => {});
    fullscreenBtn.textContent = '⛶ Toggle Fullscreen';
  }
}

fullscreenBtn.addEventListener('click', toggleFullscreen);

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) {
    fullscreenBtn.textContent = '⛶ Toggle Fullscreen';
  }
});

// ── Load folder ───────────────────────────────────────────────────────────────

async function loadFolder() {
  const result = await window.mediaAPI.selectFolder();
  if (!result) return;

  const { folderPath, files } = result;

  if (files.length === 0) {
    alert(
      'No media files found in the selected folder.\n\n' +
      'Supported images: JPG, PNG, GIF, WEBP, BMP, AVIF\n' +
      'Supported videos: MP4, WEBM, MOV, AVI, MKV, M4V, OGV'
    );
    return;
  }

  folderPathEl.textContent = folderPath;

  grid.setMedia(files);

  // Show grid, hide welcome screen
  emptyState.style.display = 'none';
  gridEl.style.display = 'grid';

  if (grid.running) {
    grid.reshufflePool();
    grid.buildGrid();
  } else {
    grid.start();
  }

  closeSettings();
}

loadFolderBtn.addEventListener('click', loadFolder);
loadFolderSettings.addEventListener('click', loadFolder);

// ── Window resize → rebuild grid ──────────────────────────────────────────────

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (grid.running) grid.buildGrid();
  }, 250);
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  switch (e.key) {
    case 's':
    case 'S':
      toggleSettings();
      break;
    case ' ':
      e.preventDefault();
      pauseBtn.click();
      break;
    case 'f':
    case 'F':
      toggleFullscreen();
      break;
    case 'Escape':
      closeSettings();
      break;
  }
});
