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

class MediaGrid extends MasonryLayout {
    constructor(gridEl) {
        super();
        this.gridEl = gridEl;

        /** @type {Array<{name:string, path:string, url:string, type:'image'|'video'}>} */
        this.mediaFiles = [];

        /** @type {Array<{cell:HTMLElement, mediaEl:HTMLElement, media:object, timer:number|null}>} */
        this.displayedItems = [];

        this.pool = [];

        this.running = false;
        this.paused = false;
        this.layoutVersion = 0;
        this.masonryLayoutToken = 0;
        this.masonryColumns = 6;
        this.masonryRows = 4;
        this.metadata = new MediaMetadata();
        this.layoutWorker = new LayoutWorkerClient();
        this.mediaGeneration = 0;
        this.filteredMedia = new Map();
        this.mediaMetrics = new Map();
        this.aspectProfiles = new Map();
        this.previousSmartPlacements = null;
        this.previousSmartGrid = null;
        this.previousSmartScore = null;
        this.lastSmartLayoutDiagnostics = null;
        this.smartLayoutDebug = this._readSmartLayoutDebugFlag();

        this.settings = {
            gridMode: "uniform", // 'uniform' | 'masonry' | 'smart-masonry'
            slotCount: 12,
            imageTime: 10, // seconds before image is replaced
            videoBehavior: "loop", // 'loop' | 'rotate'
            gap: 2, // px gap between cells
            redrawOnRefresh: false,
            mediaFilter: "mixed", // 'mixed' | 'image' | 'video'
            fitMode: "crop", // 'crop' | 'fit'
        };

        this.gridEl.dataset.fitMode = this.settings.fitMode;
    }

    // ── Pool management ──────────────────────────────────────────────────────

    _filteredMediaFiles(filter = this.settings.mediaFilter) {
        if (!this.filteredMedia.has(filter)) {
            this.filteredMedia.set(filter, filter === "image" || filter === "video"
                ? this.mediaFiles.filter((media) => media.type === filter)
                : this.mediaFiles);
        }
        return this.filteredMedia.get(filter);
    }

    countMediaForFilter(filter = this.settings.mediaFilter) {
        return this._filteredMediaFiles(filter).length;
    }

    reshufflePool() {
        this.pool = [...this._filteredMediaFiles()];
        for (let index = this.pool.length - 1; index > 0; index--) {
            const swap = Math.floor(Math.random() * (index + 1));
            [this.pool[index], this.pool[swap]] = [this.pool[swap], this.pool[index]];
        }
    }

    getNextMedia(preferredAspect = null) {
        if (this._filteredMediaFiles().length === 0) return null;
        if (this.pool.length === 0) this.reshufflePool();
        if (this.pool.length === 0) return null;

        if (!preferredAspect || !Number.isFinite(preferredAspect) || this.pool.length === 1) {
            return this.pool.pop();
        }

        const lookahead = Math.min(18, this.pool.length);
        let bestIndex = 0;
        let bestScore = Number.POSITIVE_INFINITY;

        for (let i = this.pool.length - lookahead; i < this.pool.length; i++) {
            const candidate = this.pool[i];
            const cacheKey = candidate.path || candidate.url;
            const candidateAspect = this._getMediaAspect(candidate);
            const uncertaintyPenalty = this.mediaMetrics.has(cacheKey) ? 0 : 0.2;
            const score = Math.abs(Math.log(candidateAspect / preferredAspect)) + uncertaintyPenalty;

            if (score < bestScore) {
                bestScore = score;
                bestIndex = i;
            }
        }

        const [picked] = this.pool.splice(bestIndex, 1);
        return picked;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    setMedia(files) {
        this.mediaGeneration += 1;
        this.layoutVersion += 1;
        this._clearGrid();
        this.mediaMetrics.clear();
        this.aspectProfiles.clear();
        this.filteredMedia.clear();
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
        this.layoutVersion += 1;
        this._clearGrid();
    }

    _clearGrid() {
        this.masonryLayoutToken += 1;
        this.layoutWorker.cancel();
        this.metadata.cancel();
        for (const item of this.displayedItems) {
            if (item.timer) clearTimeout(item.timer);
            if (item.transitionTimer) clearTimeout(item.transitionTimer);
            item.renderVersion += 1;
            this._removeVideoHandler(item);
            this._releaseMediaEl(item.mediaEl);
        }
        this.displayedItems = [];
        this.previousSmartPlacements = null;
        this.previousSmartGrid = null;
        this.previousSmartScore = null;
        this.gridEl.innerHTML = "";
    }

    // ── Grid construction ────────────────────────────────────────────────────

    buildGrid() {
        const buildVersion = ++this.layoutVersion;
        this._clearGrid();

        if (this.countMediaForFilter() === 0) {
            return;
        }

        const { gridMode, gap, slotCount } = this.settings;
        const visibleSlots = Math.max(1, slotCount);

        this.gridEl.style.gap = `${gap}px`;
        this.gridEl.dataset.layout = gridMode;
        this.gridEl.dataset.fitMode = this.settings.fitMode;
        this.gridEl.style.gridAutoFlow = "row";

        if (gridMode === "uniform") {
            const { columns, rows } = this._uniformLayout(visibleSlots, gap);
            const targetAspect = this._cellAspect(columns, rows, gap);
            this.gridEl.style.gridAutoRows = "";
            this.gridEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
            this.gridEl.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;

            for (let i = 0; i < visibleSlots; i++) this._addCell(targetAspect);
        } else {
            const { columns, rows } = this._masonryGridDimensions(visibleSlots, gridMode);
            this._applyMasonryGridDimensions(columns, rows);

            for (let i = 0; i < visibleSlots; i++) this._addCell();
            void this._refreshMasonryLayout(buildVersion, { reason: "build" });
        }
    }

    _cellAspect(columns, rows, gap) {
        const w = this.gridEl.clientWidth || window.innerWidth;
        const h = this.gridEl.clientHeight || window.innerHeight;
        const cellW = (w - gap * (columns - 1)) / Math.max(columns, 1);
        const cellH = (h - gap * (rows - 1)) / Math.max(rows, 1);
        return cellW / Math.max(cellH, 1);
    }

    _getViewport() {
        return {
            width: this.gridEl.clientWidth || window.innerWidth,
            height: this.gridEl.clientHeight || window.innerHeight,
        };
    }

    _uniformLayout(slotCount, gap) {
        const w = this.gridEl.clientWidth || window.innerWidth;
        const h = this.gridEl.clientHeight || window.innerHeight;

        let best = { columns: 1, rows: slotCount, score: Number.POSITIVE_INFINITY };
        const maxColumns = Math.min(slotCount, 12);

        for (let columns = 1; columns <= maxColumns; columns++) {
            const rows = Math.ceil(slotCount / columns);
            const cellW = (w - gap * (columns - 1)) / columns;
            const cellH = (h - gap * (rows - 1)) / rows;
            const cellAspect = cellW / Math.max(cellH, 1);
            const empties = columns * rows - slotCount;
            const score = Math.abs(Math.log(cellAspect)) + empties * 0.35;

            if (score < best.score) {
                best = { columns, rows, score };
            }
        }

        return best;
    }

    _applyMasonryGridDimensions(columns, rows) {
        this.gridEl.style.gridAutoRows = "";
        this.gridEl.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
        this.gridEl.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
        this.masonryColumns = columns;
        this.masonryRows = rows;
    }

    // ── Cell / media element helpers ─────────────────────────────────────────

    _addCell(targetAspect = 1) {
        const media = this.getNextMedia(targetAspect);
        if (!media) return;

        const cell = document.createElement("div");
        cell.className = "grid-cell";

        const mediaEl = this._createMediaEl(media);
        cell.appendChild(mediaEl);
        this.gridEl.appendChild(cell);

        const item = {
            cell,
            mediaEl,
            media,
            timer: null,
            transitionTimer: null,
            renderVersion: 0,
            videoEndHandler: null,
            layoutSeed: Math.random(),
            targetAspect,
        };
        this.displayedItems.push(item);
        this._scheduleRotation(item);
    }

    async _refreshMasonryLayout(buildVersion = this.layoutVersion, options = {}) {
        const { gridMode } = this.settings;
        if (gridMode === "uniform") return;
        const layoutToken = ++this.masonryLayoutToken;
        this.layoutWorker.cancel();
        const reason = options.reason || "refresh";
        const changedIndex = Number.isInteger(options.changedIndex) ? options.changedIndex : null;

        let descriptors;

        if (gridMode === "smart-masonry") {
            descriptors = await Promise.all(
                this.displayedItems.map(async (item, index) => {
                    const metadata = await this._measureMedia(item.media);
                    return { index, aspect: metadata.aspect, item };
                })
            );
        } else {
            descriptors = this.displayedItems.map((item, index) => ({
                index,
                aspect: this._masonryAspectFromSeed(item.layoutSeed, item.media.type),
                item,
            }));
        }

        if (
            !this.running ||
            buildVersion !== this.layoutVersion ||
            this.settings.gridMode !== gridMode ||
            layoutToken !== this.masonryLayoutToken
        ) {
            return;
        }

        let resolvedPlacements;
        let layoutColumns = this.masonryColumns;
        let layoutRows = this.masonryRows;
        let smartCropScore = null;

        if (gridMode === "smart-masonry") {
            let result;
            try {
                result = await this.layoutWorker.calculate({
                    viewport: this._getViewport(),
                    settings: { ...this.settings },
                    masonryColumns: this.masonryColumns,
                    masonryRows: this.masonryRows,
                    aspectProfile: this._getAspectProfile(),
                    previousSmartPlacements: this.previousSmartPlacements,
                    previousSmartGrid: this.previousSmartGrid,
                    previousSmartScore: this.previousSmartScore,
                }, descriptors.map(({ index, aspect }) => ({ index, aspect })), { reason, changedIndex });
                if (!result) return;
            } catch (error) {
                console.warn("Smart layout worker unavailable; using the partition layout.", error);
                result = {
                    layout: {
                        placements: this._buildPackedLayout(descriptors),
                        columns: this.masonryColumns,
                        rows: this.masonryRows,
                        cropScore: null,
                    },
                    diagnostics: { source: "worker-fallback" },
                };
            }
            const layout = result.layout;
            if (layoutToken === this.masonryLayoutToken) {
                this._recordSmartLayoutDiagnostics(result.diagnostics);
            }
            resolvedPlacements = layout.placements;
            layoutColumns = layout.columns;
            layoutRows = layout.rows;
            smartCropScore = layout.cropScore;
        } else {
            resolvedPlacements = this._buildPackedLayout(descriptors);
        }

        if (
            !this.running ||
            buildVersion !== this.layoutVersion ||
            this.settings.gridMode !== gridMode ||
            layoutToken !== this.masonryLayoutToken
        ) {
            return;
        }

        if (gridMode === "smart-masonry") {
            this._applyMasonryGridDimensions(layoutColumns, layoutRows);
            this.previousSmartScore = smartCropScore;
        } else {
            this.previousSmartPlacements = null;
            this.previousSmartGrid = null;
            this.previousSmartScore = null;
        }

        for (const placement of resolvedPlacements) {
            const item = this.displayedItems[placement.index];
            if (!item || !item.cell.isConnected) continue;

            item.cell.style.gridColumn = `${placement.x} / span ${placement.w}`;
            item.cell.style.gridRow = `${placement.y} / span ${placement.h}`;
            item.targetAspect = this._rectAspect(placement, layoutColumns, layoutRows);
        }

        if (gridMode === "smart-masonry") {
            this.previousSmartPlacements = new Map(
                resolvedPlacements.map((placement) => [placement.index, { ...placement }])
            );
            this.previousSmartGrid = { columns: layoutColumns, rows: layoutRows };
        }
    }

    _masonryAspectFromSeed(seed, mediaType) {
        const base = mediaType === "video" ? 1.45 : 1;
        const variation = 0.7 + seed * 1.35;
        return base * variation;
    }

    _readSmartLayoutDebugFlag() {
        try {
            return (
                globalThis.__MULTI_DISPLAY_SMART_DEBUG__ === true ||
                globalThis.localStorage?.getItem("multi-display:smart-layout-debug") === "1"
            );
        } catch {
            return globalThis.__MULTI_DISPLAY_SMART_DEBUG__ === true;
        }
    }

    _recordSmartLayoutDiagnostics(diagnostics) {
        this.lastSmartLayoutDiagnostics = diagnostics;

        if (!this.smartLayoutDebug) {
            return;
        }

        console.debug("[smart-masonry]", {
            reason: diagnostics.reason,
            source: diagnostics.source,
            grid: diagnostics.chosenGrid,
            exploredTilings: diagnostics.exploredTilings,
            evaluatedLayouts: diagnostics.evaluatedLayouts,
            repairCandidates: diagnostics.repairCandidates,
            winningScore: diagnostics.winningScore,
            cropScore: diagnostics.cropScore,
            worstCrop: diagnostics.worstCrop,
            severeCropCount: diagnostics.severeCropCount,
            rejectedCropCount: diagnostics.rejectedCropCount,
            worstVisibleFraction: diagnostics.worstVisibleFraction,
            stabilityPenalty: diagnostics.stabilityPenalty,
            runtimeMs: diagnostics.runtimeMs,
            grids: diagnostics.gridCandidates,
        });
    }

    _createMediaEl(media) {
        const generation = this.mediaGeneration;
        let el;
        if (media.type === "image") {
            el = document.createElement("img");
            el.alt = "";
        } else {
            el = document.createElement("video");
            el.autoplay = !this.paused;
            el.muted = true;
            el.playsInline = true;
            el.loop = this.settings.videoBehavior === "loop";
        }
        const loaded = () => {
            if (generation !== this.mediaGeneration) return;
            const width = media.type === "video" ? el.videoWidth : el.naturalWidth;
            const height = media.type === "video" ? el.videoHeight : el.naturalHeight;
            if (!(width > 0 && height > 0)) return;
            const metadata = { width, height, aspect: width / height };
            this.metadata.remember(media, metadata);
            this._rememberMetrics(media, metadata);
        };
        if (media.type === "video") el.onloadedmetadata = loaded;
        else el.onload = loaded;
        el.onerror = () => el.classList.add("media-error");
        el.className = "media-element";
        el.src = media.url;
        return el;
    }

    _releaseMediaEl(el) {
        el.onload = el.onloadedmetadata = el.onerror = null;
        if (el.tagName === "VIDEO") el.pause();
        el.removeAttribute("src");
        if (el.tagName === "VIDEO") el.load();
    }

    _estimatedAspect(type) {
        const profile = this._getAspectProfile(type);
        if (profile?.median) return profile.median;
        return type === "video" ? 16 / 9 : 1;
    }

    _getMediaAspect(media) {
        const cacheKey = media.path || media.url;
        return this.mediaMetrics.get(cacheKey)?.aspect || this.metadata.peek(media)?.aspect || this._estimatedAspect(media.type);
    }

    _rememberMetrics(media, metadata) {
        const key = media.path || media.url;
        this.mediaMetrics.delete(key);
        this.mediaMetrics.set(key, { ...metadata, type: media.type });
        while (this.mediaMetrics.size > this.metadata.maxEntries) {
            this.mediaMetrics.delete(this.mediaMetrics.keys().next().value);
        }
        this.aspectProfiles.clear();
    }

    _getAspectProfile(filter = this.settings.mediaFilter) {
        const cacheKey = filter || "mixed";
        if (this.aspectProfiles.has(cacheKey)) {
            return this.aspectProfiles.get(cacheKey);
        }

        const aspects = [...this.mediaMetrics.values()]
            .filter((metadata) => (filter !== "image" && filter !== "video") || metadata.type === filter)
            .map((metadata) => metadata.aspect)
            .filter((aspect) => Number.isFinite(aspect) && aspect > 0)
            .sort((a, b) => a - b);

        if (aspects.length === 0) {
            this.aspectProfiles.set(cacheKey, null);
            return null;
        }

        const logAspects = aspects.map((aspect) => Math.log(aspect));
        const meanLog = logAspects.reduce((sum, value) => sum + value, 0) / logAspects.length;
        const variance =
            logAspects.reduce((sum, value) => {
                const delta = value - meanLog;
                return sum + delta * delta;
            }, 0) / logAspects.length;
        const profile = {
            count: aspects.length,
            median: aspects[Math.floor(aspects.length / 2)],
            mean: Math.exp(meanLog),
            spread: Math.sqrt(variance),
        };

        this.aspectProfiles.set(cacheKey, profile);
        return profile;
    }

    _measureMedia(media) {
        const cacheKey = media.path || media.url;
        if (this.mediaMetrics.has(cacheKey)) {
            return Promise.resolve(this.mediaMetrics.get(cacheKey));
        }
        const generation = this.mediaGeneration;
        return this.metadata.get(media).then((metadata) => {
            if (generation === this.mediaGeneration && metadata.measured !== false) {
                this._rememberMetrics(media, metadata);
            }
            return metadata;
        });
    }

    _removeVideoHandler(item) {
        if (item.videoEndHandler) {
            item.mediaEl.removeEventListener("ended", item.videoEndHandler);
            item.videoEndHandler = null;
        }
    }

    // ── Rotation scheduling ──────────────────────────────────────────────────

    _scheduleRotation(item) {
        if (!this.running || !item.cell.isConnected || this.paused) return;

        this._removeVideoHandler(item);

        if (item.media.type === "image") {
            item.timer = setTimeout(() => this._replaceItem(item), this.settings.imageTime * 1000);
        } else {
            // video
            const loop = this.settings.videoBehavior === "loop";
            item.mediaEl.loop = loop;
            if (!loop) {
                const onEnded = () => {
                    item.videoEndHandler = null;
                    this._replaceItem(item);
                };
                item.videoEndHandler = onEnded;
                item.mediaEl.addEventListener("ended", onEnded);
            }
        }
    }

    _replaceItem(item) {
        if (!this.running || this.paused) return;
        if (item.timer) {
            clearTimeout(item.timer);
            item.timer = null;
        }
        this._removeVideoHandler(item);

        const newMedia = this.getNextMedia(item.targetAspect);
        if (!newMedia) return;

        const renderVersion = item.renderVersion + 1;
        item.renderVersion = renderVersion;

        // Fade out
        item.mediaEl.classList.add("fade-out");

        if (item.transitionTimer) clearTimeout(item.transitionTimer);
        item.transitionTimer = setTimeout(() => {
            item.transitionTimer = null;
            if (!this.running || !item.cell.isConnected || renderVersion !== item.renderVersion) {
                return;
            }

            const oldEl = item.mediaEl;
            const newEl = this._createMediaEl(newMedia);

            // Start invisible, then fade in
            newEl.style.opacity = "0";
            item.cell.appendChild(newEl);
            this._releaseMediaEl(oldEl);
            oldEl.remove();

            item.mediaEl = newEl;
            item.media = newMedia;
            if (this.settings.redrawOnRefresh && this.settings.gridMode !== "uniform") {
                void this._refreshMasonryLayout(this.layoutVersion, {
                    reason: "refresh",
                    changedIndex: this.displayedItems.indexOf(item),
                });
            }

            // Double rAF ensures initial opacity:0 is painted before transition
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    newEl.style.transition = "opacity 0.6s ease";
                    newEl.style.opacity = "1";
                    newEl.addEventListener(
                        "transitionend",
                        () => {
                            newEl.style.transition = "";
                        },
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
                if (item.media.type === "video") item.mediaEl.pause();
                this._removeVideoHandler(item);
                if (item.timer) {
                    clearTimeout(item.timer);
                    item.timer = null;
                }
            }
        } else {
            for (const item of this.displayedItems) {
                if (item.media.type === "video") item.mediaEl.play().catch(() => {});
                this._scheduleRotation(item);
            }
        }
        return this.paused;
    }

    // ── Settings update ──────────────────────────────────────────────────────

    updateSettings(changes) {
        const prev = { ...this.settings };
        Object.assign(this.settings, changes);

        if ("fitMode" in changes) {
            this.gridEl.dataset.fitMode = this.settings.fitMode;
        }

        // Toggle video loop without full rebuild
        if ("videoBehavior" in changes) {
            for (const item of this.displayedItems) {
                if (item.media.type === "video") {
                    item.mediaEl.loop = changes.videoBehavior === "loop";
                    if (!this.paused) this._scheduleRotation(item);
                }
            }
        }

        // Reset image timers when imageTime changes
        if ("imageTime" in changes) {
            for (const item of this.displayedItems) {
                if (item.media.type === "image") {
                    if (item.timer) clearTimeout(item.timer);
                    item.timer = setTimeout(() => this._replaceItem(item), this.settings.imageTime * 1000);
                }
            }
        }

        // Rebuild grid for layout-affecting changes
        const layoutKeys = ["gridMode", "slotCount", "gap", "mediaFilter"];
        if (this.running && layoutKeys.some((k) => k in changes && prev[k] !== changes[k])) {
            this.reshufflePool();
            this.buildGrid();
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// App bootstrap
// ═══════════════════════════════════════════════════════════════════════════════

const grid = new MediaGrid(document.getElementById("grid"));

window.addEventListener("beforeunload", () => {
    grid.stop();
    grid.layoutWorker.dispose();
    grid.metadata.dispose();
});

// ── DOM refs ─────────────────────────────────────────────────────────────────

const emptyState = document.getElementById("empty-state");
const gridEl = document.getElementById("grid");
const settingsToggle = document.getElementById("settings-toggle");
const settingsPanel = document.getElementById("settings-panel");
const settingsClose = document.getElementById("settings-close");
const loadFolderBtn = document.getElementById("load-folder-btn");
const loadFolderSettings = document.getElementById("load-folder-settings");
const folderPathEl = document.getElementById("folder-path");
const slotsSlider = document.getElementById("slots-slider");
const slotsValue = document.getElementById("slots-value");
const imageTimeSlider = document.getElementById("image-time-slider");
const imageTimeValue = document.getElementById("image-time-value");
const gapSlider = document.getElementById("gap-slider");
const gapValue = document.getElementById("gap-value");
const pauseBtn = document.getElementById("pause-btn");
const fullscreenBtn = document.getElementById("fullscreen-btn");

// ── Settings panel toggle ─────────────────────────────────────────────────────

function openSettings() {
    settingsPanel.classList.add("open");
}
function closeSettings() {
    settingsPanel.classList.remove("open");
}
function toggleSettings() {
    settingsPanel.classList.toggle("open");
}

settingsToggle.addEventListener("click", toggleSettings);
settingsClose.addEventListener("click", closeSettings);

function setActiveToggle(buttons, predicate) {
    buttons.forEach((button) => {
        button.classList.toggle("active", predicate(button));
    });
}

// ── Grid mode buttons ─────────────────────────────────────────────────────────

const modeButtons = document.querySelectorAll("[data-mode]");
const redrawButtons = document.querySelectorAll("[data-redraw]");
const mediaFilterButtons = document.querySelectorAll("[data-media-filter]");
const fitModeButtons = document.querySelectorAll("[data-fit-mode]");

modeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        setActiveToggle(modeButtons, (button) => button === btn);
        grid.updateSettings({ gridMode: btn.dataset.mode });
    });
});

redrawButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        setActiveToggle(redrawButtons, (button) => button === btn);
        grid.updateSettings({ redrawOnRefresh: btn.dataset.redraw === "on" });
    });
});

mediaFilterButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        const nextFilter = btn.dataset.mediaFilter;

        if (grid.mediaFiles.length > 0 && grid.countMediaForFilter(nextFilter) === 0) {
            alert(`No ${nextFilter === "video" ? "videos" : "images"} found in the current folder.`);
            return;
        }

        setActiveToggle(mediaFilterButtons, (button) => button === btn);
        grid.updateSettings({ mediaFilter: nextFilter });
    });
});

fitModeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        setActiveToggle(fitModeButtons, (button) => button === btn);
        grid.updateSettings({ fitMode: btn.dataset.fitMode });
    });
});

// ── Video behavior buttons ────────────────────────────────────────────────────

document.querySelectorAll("[data-video]").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll("[data-video]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        grid.updateSettings({ videoBehavior: btn.dataset.video });
    });
});

// ── Sliders ───────────────────────────────────────────────────────────────────

slotsSlider.addEventListener("input", () => {
    const val = parseInt(slotsSlider.value, 10);
    slotsValue.textContent = val;
    grid.updateSettings({ slotCount: val });
});

imageTimeSlider.addEventListener("input", () => {
    const val = parseInt(imageTimeSlider.value, 10);
    imageTimeValue.textContent = `${val} s`;
    grid.updateSettings({ imageTime: val });
});

gapSlider.addEventListener("input", () => {
    const val = parseInt(gapSlider.value, 10);
    gapValue.textContent = `${val} px`;
    grid.updateSettings({ gap: val });
});

// ── Pause / resume ────────────────────────────────────────────────────────────

pauseBtn.addEventListener("click", () => {
    const isPaused = grid.togglePause();
    pauseBtn.textContent = isPaused ? "▶ Resume All" : "⏸ Pause All";
});

// ── Fullscreen ────────────────────────────────────────────────────────────────

function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
        fullscreenBtn.textContent = "⛶ Exit Fullscreen";
    } else {
        document.exitFullscreen().catch(() => {});
        fullscreenBtn.textContent = "⛶ Toggle Fullscreen";
    }
}

fullscreenBtn.addEventListener("click", toggleFullscreen);

document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) {
        fullscreenBtn.textContent = "⛶ Toggle Fullscreen";
    }
});

// ── Load folder ───────────────────────────────────────────────────────────────

async function loadFolder() {
    const result = await window.mediaAPI.selectFolder();
    if (!result) return;

    const { folderPath, files } = result;

    if (files.length === 0) {
        alert(
            "No media files found in the selected folder.\n\n" +
                "Supported images: JPG, PNG, GIF, WEBP, BMP, AVIF\n" +
                "Supported videos: MP4, WEBM, MOV, AVI, MKV, M4V, OGV"
        );
        return;
    }

    folderPathEl.textContent = folderPath;

    await grid.setMedia(files);

    if (grid.countMediaForFilter() === 0) {
        setActiveToggle(mediaFilterButtons, (button) => button.dataset.mediaFilter === "mixed");
        grid.updateSettings({ mediaFilter: "mixed" });
    }

    // Show grid, hide welcome screen
    emptyState.style.display = "none";
    gridEl.style.display = "grid";

    if (grid.running) {
        grid.reshufflePool();
        grid.buildGrid();
    } else {
        grid.start();
    }

    closeSettings();
}

loadFolderBtn.addEventListener("click", loadFolder);
loadFolderSettings.addEventListener("click", loadFolder);

// ── Window resize → rebuild grid ──────────────────────────────────────────────

let resizeTimer;
window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (grid.running) grid.buildGrid();
    }, 250);
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    switch (e.key) {
        case "s":
        case "S":
            toggleSettings();
            break;
        case " ":
            e.preventDefault();
            pauseBtn.click();
            break;
        case "f":
        case "F":
            toggleFullscreen();
            break;
        case "Escape":
            closeSettings();
            break;
    }
});
