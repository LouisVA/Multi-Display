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
        this.ignoredMedia = new Set();
        this.reservedMediaKeys = new Set();
        this.frozenGeometry = null;
        this.frozenGrid = null;
        this.pendingPins = null;
        this.onChange = null;
        this.mergeSelection = null;
        this.mergeStatus = "";

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
                ? this.mediaFiles.filter((media) => media.type === filter && !this.ignoredMedia.has(this._mediaKey(media)))
                : this.mediaFiles.filter((media) => !this.ignoredMedia.has(this._mediaKey(media))));
        }
        return this.filteredMedia.get(filter);
    }

    _mediaKey(media) {
        return media?.path || media?.url || null;
    }

    _notifyChange(type, details = {}) {
        if (typeof this.onChange === "function") {
            this.onChange({ type, ...details });
        }
    }

    countMediaForFilter(filter = this.settings.mediaFilter) {
        return this._filteredMediaFiles(filter).length;
    }

    reshufflePool(excludeItem = null) {
        const unavailable = new Set([
            ...this.displayedItems.filter((item) => item !== excludeItem).map((item) => this._mediaKey(item.media)).filter(Boolean),
            ...this.reservedMediaKeys,
        ]);
        this.pool = this._filteredMediaFiles().filter((media) => !unavailable.has(this._mediaKey(media)));
        for (let index = this.pool.length - 1; index > 0; index--) {
            const swap = Math.floor(Math.random() * (index + 1));
            [this.pool[index], this.pool[swap]] = [this.pool[swap], this.pool[index]];
        }
    }

    getNextMedia(preferredAspect = null, replacingItem = null) {
        if (this._filteredMediaFiles().length === 0) return null;
        if (this.pool.length === 0) this.reshufflePool(replacingItem);
        if (this.pool.length === 0) {
            const lockedKeys = new Set([
                ...this.displayedItems.filter((item) => item.locked).map((item) => this._mediaKey(item.media)).filter(Boolean),
                ...this.reservedMediaKeys,
            ]);
            const unlockedCount = Math.max(1, this.settings.slotCount - this.displayedItems.filter((item) => item.locked).length);
            if (this._filteredMediaFiles().length >= unlockedCount) return null;
            const repeatable = this._filteredMediaFiles().filter((media) => !lockedKeys.has(this._mediaKey(media)));
            return repeatable.length ? repeatable[Math.floor(Math.random() * repeatable.length)] : null;
        }

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
        this.ignoredMedia.clear();
        this.reservedMediaKeys.clear();
        this.frozenGeometry = null;
        this.frozenGrid = null;
        this.pendingPins = null;
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
        this.cancelMergeSelection(false);
        this.masonryLayoutToken += 1;
        this.layoutWorker.cancel();
        this.metadata.cancel();
        for (const item of this.displayedItems) {
            if (item.timer) clearTimeout(item.timer);
            if (item.transitionTimer) clearTimeout(item.transitionTimer);
            item.renderVersion += 1;
            this._removeVideoHandler(item);
            if (item.mediaEl) this._releaseMediaEl(item.mediaEl);
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
        const previousItems = this.displayedItems;
        const pins = previousItems
            .map((item, index) => item.locked
                ? { index, media: item.media, mediaKey: this._mediaKey(item.media) || item.missingMediaKey }
                : null)
            .filter(Boolean);
        const retainedPins = pins.length ? pins : this.pendingPins || [];
        this.reservedMediaKeys = new Set(retainedPins.map((pin) => this._mediaKey(pin.media) || pin.mediaKey).filter(Boolean));
        this.pendingPins = null;
        const frozenGeometry = this.frozenGeometry;
        this._clearGrid();

        const { gridMode, gap, slotCount } = this.settings;
        const visibleSlots = Math.max(1, slotCount);
        const pinKeys = new Set(retainedPins.map((pin) => this._mediaKey(pin.media) || pin.mediaKey).filter(Boolean));
        this.pool = this.pool.filter((media) => !pinKeys.has(this._mediaKey(media)));

        this.gridEl.style.gap = `${gap}px`;
        this.gridEl.dataset.layout = gridMode;
        this.gridEl.dataset.fitMode = this.settings.fitMode;
        this.gridEl.style.gridAutoFlow = "row";

        if (frozenGeometry?.length === visibleSlots && this.frozenGrid) {
            this.gridEl.style.gridTemplateColumns = `repeat(${this.frozenGrid.columns}, minmax(0, 1fr))`;
            this.gridEl.style.gridTemplateRows = `repeat(${this.frozenGrid.rows}, minmax(0, 1fr))`;
            this.masonryColumns = this.frozenGrid.columns;
            this.masonryRows = this.frozenGrid.rows;
        }

        if (gridMode === "uniform") {
            const { columns, rows } = frozenGeometry?.length === visibleSlots && this.frozenGrid
                ? this.frozenGrid
                : this._uniformLayout(visibleSlots, gap);
            const targetAspect = this._cellAspect(columns, rows, gap);
            this.gridEl.style.gridAutoRows = "";
            this.gridEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
            this.gridEl.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;

            for (let i = 0; i < visibleSlots; i++) {
                const pin = retainedPins.find((entry) => entry.index === i);
                this._addCell(targetAspect, pin?.media || null, Boolean(pin), pin?.mediaKey || null);
            }
            if (frozenGeometry?.length === visibleSlots) this._applyFrozenGeometry(frozenGeometry);
        } else {
            const { columns, rows } = frozenGeometry?.length === visibleSlots && this.frozenGrid
                ? this.frozenGrid
                : this._masonryGridDimensions(visibleSlots, gridMode);
            this._applyMasonryGridDimensions(columns, rows);

            for (let i = 0; i < visibleSlots; i++) {
                const pin = retainedPins.find((entry) => entry.index === i);
                this._addCell(1, pin?.media || null, Boolean(pin), pin?.mediaKey || null);
            }
            if (frozenGeometry?.length === visibleSlots) {
                this._applyFrozenGeometry(frozenGeometry);
            } else {
                void this._refreshMasonryLayout(buildVersion, { reason: "build" });
            }
        }
        this.reservedMediaKeys.clear();
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

    _addCell(targetAspect = 1, assignedMedia = null, locked = false, missingMediaKey = null) {
        const media = assignedMedia || (locked && missingMediaKey ? null : this.getNextMedia(targetAspect));

        const cell = document.createElement("div");
        cell.className = "grid-cell";

        const mediaEl = media ? this._createMediaEl(media) : null;
        if (mediaEl) cell.appendChild(mediaEl);
        this.gridEl.appendChild(cell);

        const item = {
            cell,
            mediaEl,
            media,
            locked,
            missingMediaKey: media ? null : missingMediaKey,
            timer: null,
            transitionTimer: null,
            renderVersion: 0,
            videoEndHandler: null,
            layoutSeed: Math.random(),
            targetAspect,
        };
        if (locked && media?.type === "video" && mediaEl) mediaEl.loop = true;
        this.displayedItems.push(item);
        if (media) this._scheduleRotation(item);
    }

    async _refreshMasonryLayout(buildVersion = this.layoutVersion, options = {}) {
        const { gridMode } = this.settings;
        if (gridMode === "uniform") return;
        if (this.frozenGeometry?.length === this.displayedItems.length) return;
        const layoutToken = ++this.masonryLayoutToken;
        this.layoutWorker.cancel();
        const reason = options.reason || "refresh";
        const changedIndex = Number.isInteger(options.changedIndex) ? options.changedIndex : null;

        let descriptors;

        if (gridMode === "smart-masonry") {
            descriptors = await Promise.all(
                this.displayedItems.map(async (item, index) => {
                    const metadata = item.media ? await this._measureMedia(item.media) : { aspect: 1 };
                    return { index, aspect: metadata.aspect, item };
                })
            );
        } else {
            descriptors = this.displayedItems.map((item, index) => ({
                index,
                aspect: this._masonryAspectFromSeed(item.layoutSeed, item.media?.type || "image"),
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
        this.reservedMediaKeys.clear();
        this.layoutGeometry = this.displayedItems.map((item) => ({
            x: Number(item.cell.style.gridColumn.split(" /")[0]) || 1,
            y: Number(item.cell.style.gridRow.split(" /")[0]) || 1,
            w: Number(item.cell.style.gridColumn.match(/span\s+(\d+)/)?.[1]) || 1,
            h: Number(item.cell.style.gridRow.match(/span\s+(\d+)/)?.[1]) || 1,
        }));

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
        if (item.videoEndHandler && item.mediaEl) {
            item.mediaEl.removeEventListener("ended", item.videoEndHandler);
        }
        item.videoEndHandler = null;
    }

    // ── Rotation scheduling ──────────────────────────────────────────────────

    _scheduleRotation(item) {
        if (!this.running || !item.cell.isConnected || this.paused || item.locked || !item.media || !item.mediaEl) return;

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

    _replaceItem(item, options = {}) {
        if (!this.running || (this.paused && !options.allowPaused) || (item.locked && !options.allowLocked)) return;
        if (item.timer) {
            clearTimeout(item.timer);
            item.timer = null;
        }
        this._removeVideoHandler(item);

        const newMedia = this.getNextMedia(item.targetAspect, item);
        if (!newMedia) {
            if (options.clearWhenUnavailable) {
                if (item.transitionTimer) clearTimeout(item.transitionTimer);
                item.transitionTimer = null;
                item.renderVersion += 1;
                if (item.mediaEl) {
                    this._releaseMediaEl(item.mediaEl);
                    item.mediaEl.remove();
                }
                item.mediaEl = null;
                item.media = null;
            }
            return;
        }

        const renderVersion = item.renderVersion + 1;
        item.renderVersion = renderVersion;

        // Fade out
        if (item.mediaEl) item.mediaEl.classList.add("fade-out");

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
            if (oldEl) {
                this._releaseMediaEl(oldEl);
                oldEl.remove();
            }

            item.mediaEl = newEl;
            item.media = newMedia;
            item.missingMediaKey = null;
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
                if (item.media?.type === "video" && item.mediaEl) item.mediaEl.pause();
                this._removeVideoHandler(item);
                if (item.timer) {
                    clearTimeout(item.timer);
                    item.timer = null;
                }
            }
        } else {
            for (const item of this.displayedItems) {
                if (item.media?.type === "video" && item.mediaEl) item.mediaEl.play().catch(() => {});
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
                if (item.media?.type === "video" && item.mediaEl) {
                    item.mediaEl.loop = item.locked || changes.videoBehavior === "loop";
                    if (!this.paused) this._scheduleRotation(item);
                }
            }
        }

        // Reset image timers when imageTime changes
        if ("imageTime" in changes) {
            for (const item of this.displayedItems) {
                if (item.media?.type === "image" && !item.locked) {
                    if (item.timer) clearTimeout(item.timer);
                    item.timer = setTimeout(() => this._replaceItem(item), this.settings.imageTime * 1000);
                }
            }
        }

        // Rebuild grid for layout-affecting changes
        const layoutKeys = ["gridMode", "slotCount", "gap", "mediaFilter"];
        if (this.running && layoutKeys.some((k) => k in changes && prev[k] !== changes[k])) {
            if (("gridMode" in changes && prev.gridMode !== changes.gridMode) || ("slotCount" in changes && prev.slotCount !== changes.slotCount)) {
                this.clearLocks();
            }
            this.reshufflePool();
            this.buildGrid();
        }
    }

    _resolveItem(itemOrIndex) {
        return Number.isInteger(itemOrIndex) ? this.displayedItems[itemOrIndex] : itemOrIndex;
    }

    _setMergeStatus(message) {
        this.mergeStatus = message;
        this._notifyChange("merge-status", { message });
    }

    selectMergeItem(itemOrIndex) {
        const item = this._resolveItem(itemOrIndex);
        if (!item || !this.displayedItems.includes(item)) return false;
        if (this.mergeSelection === item) {
            this.cancelMergeSelection();
            return true;
        }
        if (!this.mergeSelection) {
            this.mergeSelection = item;
            item.selectedForMerge = true;
            item.cell.classList.add("merge-selected");
            let badge = item.cell.querySelector(".merge-selection-badge");
            if (!badge) {
                badge = document.createElement("span");
                badge.className = "merge-selection-badge";
                badge.textContent = "MERGE";
                item.cell.appendChild(badge);
            }
            this._setMergeStatus("Select a second adjacent tile. Press Escape to cancel.");
            this._notifyChange("merge-selection", { first: item });
            return true;
        }

        return this.mergeItems(this.mergeSelection, item);
    }

    cancelMergeSelection(notify = true) {
        const selected = this.mergeSelection;
        if (selected) {
            selected.selectedForMerge = false;
            selected.cell.classList.remove("merge-selected");
            selected.cell.querySelector(".merge-selection-badge")?.remove();
        }
        this.mergeSelection = null;
        this._setMergeStatus("");
        if (notify && selected) this._notifyChange("merge-selection", { first: null });
        return Boolean(selected);
    }

    _isFullEdgeNeighbor(a, b) {
        const verticalNeighbor =
            (a.x + a.w === b.x || b.x + b.w === a.x) &&
            a.y === b.y && a.h === b.h;
        const horizontalNeighbor =
            (a.y + a.h === b.y || b.y + b.h === a.y) &&
            a.x === b.x && a.w === b.w;
        return verticalNeighbor || horizontalNeighbor;
    }

    mergeItems(aOrIndex, bOrIndex) {
        const first = this._resolveItem(aOrIndex);
        const second = this._resolveItem(bOrIndex);
        const firstIndex = this.displayedItems.indexOf(first);
        const secondIndex = this.displayedItems.indexOf(second);
        if (!first || !second || first === second || firstIndex < 0 || secondIndex < 0) {
            this._setMergeStatus("Select two visible tiles to merge.");
            this._notifyChange("merge-invalid", { first, second, reason: "missing-tile" });
            return false;
        }

        const currentGeometry = this._readCurrentGeometry();
        const firstRect = currentGeometry[firstIndex];
        const secondRect = currentGeometry[secondIndex];
        const union = firstRect && secondRect && this._isFullEdgeNeighbor(firstRect, secondRect)
            ? this._rectUnionIfRectangular(firstRect, secondRect)
            : null;
        if (!union) {
            this._setMergeStatus("These tiles do not share a full edge. Select another tile.");
            this._notifyChange("merge-invalid", { first, second, reason: "not-adjacent" });
            return false;
        }

        // Freeze only after validation so an invalid merge cannot affect a pending layout.
        const stableGeometry = this.freezeLayout();
        const stableUnion = this._rectUnionIfRectangular(stableGeometry[firstIndex], stableGeometry[secondIndex]);
        if (!stableUnion || !this._isFullEdgeNeighbor(stableGeometry[firstIndex], stableGeometry[secondIndex])) {
            this._setMergeStatus("These tiles do not share a full edge. Select another tile.");
            this._notifyChange("merge-invalid", { first, second, reason: "not-adjacent" });
            return false;
        }

        const releasedMedia = second.media;
        const releasedKey = this._mediaKey(releasedMedia) || second.missingMediaKey;
        if (second.timer) clearTimeout(second.timer);
        if (second.transitionTimer) clearTimeout(second.transitionTimer);
        second.renderVersion += 1;
        second.timer = null;
        second.transitionTimer = null;
        this._removeVideoHandler(second);
        if (second.mediaEl) {
            this._releaseMediaEl(second.mediaEl);
            second.mediaEl.remove();
        }
        second.mediaEl = null;
        second.media = null;
        second.locked = false;
        second.missingMediaKey = null;
        second.cell.remove();

        const remainingItems = this.displayedItems.filter((item) => item !== second);
        const stillPinned = releasedKey && remainingItems.some((item) =>
            item.locked && (this._mediaKey(item.media) || item.missingMediaKey) === releasedKey
        );
        if (releasedKey && !stillPinned) this.reservedMediaKeys.delete(releasedKey);

        if (releasedMedia && this._filteredMediaFiles().some((media) => this._mediaKey(media) === this._mediaKey(releasedMedia))) {
            const key = this._mediaKey(releasedMedia);
            const stillVisible = remainingItems.some((item) => this._mediaKey(item.media) === key);
            if (!stillVisible && !this.pool.some((media) => this._mediaKey(media) === key)) this.pool.push(releasedMedia);
        }

        const geometryByItem = new Map(this.displayedItems.map((item, index) => [item, stableGeometry[index]]));
        this.displayedItems = remainingItems;
        this.settings.slotCount = remainingItems.length;
        this.frozenGeometry = remainingItems.map((item) => item === first
            ? { ...stableUnion }
            : { ...geometryByItem.get(item) });
        first.targetAspect = this._rectAspect(stableUnion, this.frozenGrid.columns, this.frozenGrid.rows);
        if (first.timer) clearTimeout(first.timer);
        first.timer = null;
        if (first.transitionTimer) clearTimeout(first.transitionTimer);
        first.transitionTimer = null;
        first.renderVersion += 1;
        this._restoreMediaVisibility(first.mediaEl);
        this._removeVideoHandler(first);
        if (!first.locked && !first.transitionTimer) this._scheduleRotation(first);

        this.cancelMergeSelection(false);
        this._applyFrozenGeometry();
        this._setMergeStatus("Tiles merged.");
        this._notifyChange("merge", { first, removed: second, slotCount: remainingItems.length, geometry: this.frozenGeometry });
        return true;
    }

    _applyFrozenGeometry(geometry = this.frozenGeometry) {
        if (!Array.isArray(geometry)) return;
        for (let index = 0; index < Math.min(geometry.length, this.displayedItems.length); index++) {
            const item = this.displayedItems[index];
            const placement = geometry[index];
            item.cell.style.gridColumn = `${placement.x} / span ${placement.w}`;
            item.cell.style.gridRow = `${placement.y} / span ${placement.h}`;
            const dimensions = this.frozenGrid || this._currentGridDimensions();
            item.targetAspect = this._rectAspect(placement, dimensions.columns, dimensions.rows);
        }
        this.layoutGeometry = geometry.map((placement) => ({ ...placement }));
    }

    _currentGridDimensions() {
        const columns = Number(this.gridEl.style.gridTemplateColumns.match(/^repeat\((\d+)/)?.[1]);
        const rows = Number(this.gridEl.style.gridTemplateRows.match(/^repeat\((\d+)/)?.[1]);
        if (columns > 0 && rows > 0) return { columns, rows };
        if (this.settings.gridMode === "uniform") {
            return this._uniformLayout(Math.max(1, this.displayedItems.length), this.settings.gap);
        }
        return { columns: this.masonryColumns, rows: this.masonryRows };
    }

    _readCurrentGeometry() {
        if (this.frozenGeometry?.length === this.displayedItems.length &&
            this.frozenGeometry.every((entry) => entry && Number.isInteger(entry.x) && Number.isInteger(entry.y))) {
            return this.frozenGeometry.map((entry) => ({ ...entry }));
        }

        if (this.settings.gridMode === "uniform") {
            const { columns } = this._currentGridDimensions();
            return this.displayedItems.map((_item, index) => ({
                x: (index % columns) + 1,
                y: Math.floor(index / columns) + 1,
                w: 1,
                h: 1,
            }));
        }

        const current = this.displayedItems.map((item) => {
            const col = item.cell.style.gridColumn.match(/^(\d+)\s*\/\s*span\s*(\d+)/);
            const row = item.cell.style.gridRow.match(/^(\d+)\s*\/\s*span\s*(\d+)/);
            return col && row ? { x: Number(col[1]), y: Number(row[1]), w: Number(col[2]), h: Number(row[2]) } : null;
        });
        if (current.every(Boolean)) return current;

        const fallback = this._buildPackedLayout(this.displayedItems.map((item, index) => ({
            index,
            aspect: this._masonryAspectFromSeed(item.layoutSeed, item.media?.type || "image"),
        })));
        const geometry = new Array(this.displayedItems.length);
        for (const placement of fallback) {
            geometry[placement.index] = { x: placement.x, y: placement.y, w: placement.w, h: placement.h };
        }
        return geometry;
    }

    freezeLayout() {
        this.masonryLayoutToken += 1;
        this.layoutWorker.cancel();
        this.frozenGrid = this._currentGridDimensions();
        if (this.settings.gridMode !== "uniform") this._applyMasonryGridDimensions(this.frozenGrid.columns, this.frozenGrid.rows);
        else {
            this.gridEl.style.gridTemplateColumns = `repeat(${this.frozenGrid.columns}, minmax(0, 1fr))`;
            this.gridEl.style.gridTemplateRows = `repeat(${this.frozenGrid.rows}, 1fr)`;
        }
        this.frozenGeometry = this._readCurrentGeometry();
        this._applyFrozenGeometry(this.frozenGeometry);
        return this.frozenGeometry;
    }

    handleResize() {
        if (this.frozenGeometry) {
            this._applyFrozenGeometry();
            return;
        }
        if (this.running) this.buildGrid();
    }

    clearLocks() {
        const changed = this.displayedItems.some((item) => item.locked) || (this.pendingPins?.length || 0) > 0;
        for (const item of this.displayedItems) {
            item.locked = false;
            if (item.media?.type === "video" && item.mediaEl) item.mediaEl.loop = this.settings.videoBehavior === "loop";
            this._scheduleRotation(item);
        }
        this.pendingPins = null;
        this.frozenGeometry = null;
        this.frozenGrid = null;
        if (changed) this._notifyChange("clear-locks");
    }

    toggleLock(itemOrIndex) {
        const item = this._resolveItem(itemOrIndex);
        if (!item) return false;
        if (item.locked && !item.media && item.missingMediaKey) {
            this._fillLockedPlaceholder(item);
            this._notifyChange("lock", { item, locked: true });
            return true;
        }
        item.locked = !item.locked;
        if (item.locked) {
            this.freezeLayout();
            if (item.timer) clearTimeout(item.timer);
            item.timer = null;
            if (item.transitionTimer) clearTimeout(item.transitionTimer);
            item.transitionTimer = null;
            item.renderVersion += 1;
            this._restoreMediaVisibility(item.mediaEl);
            this._removeVideoHandler(item);
            if (item.media?.type === "video" && item.mediaEl) item.mediaEl.loop = true;
            if (!item.media) this._fillLockedPlaceholder(item);
            else {
                const key = this._mediaKey(item.media);
                for (const duplicate of this.displayedItems) {
                    if (duplicate !== item && !duplicate.locked && this._mediaKey(duplicate.media) === key) {
                        this._replaceItem(duplicate, { clearWhenUnavailable: true });
                    }
                }
            }
        } else {
            if (item.media?.type === "video" && item.mediaEl) item.mediaEl.loop = this.settings.videoBehavior === "loop";
            this._scheduleRotation(item);
        }
        this._notifyChange("lock", { item, locked: item.locked });
        return item.locked;
    }

    _fillLockedPlaceholder(item) {
        const media = this.getNextMedia(item.targetAspect, item);
        if (!media) return false;
        item.media = media;
        item.missingMediaKey = null;
        item.mediaEl = this._createMediaEl(media);
        if (media.type === "video" && item.locked) item.mediaEl.loop = true;
        item.cell.appendChild(item.mediaEl);
        item.mediaEl.classList.add("fade-in");
        return true;
    }

    _restoreMediaVisibility(element) {
        if (!element) return;
        element.classList.remove("fade-out");
        element.style.opacity = "1";
        element.style.transition = "";
    }

    swapItems(aOrIndex, bOrIndex) {
        const a = this._resolveItem(aOrIndex);
        const b = this._resolveItem(bOrIndex);
        if (!a || !b || a === b) return false;
        this.freezeLayout();
        for (const item of [a, b]) {
            if (item.timer) clearTimeout(item.timer);
            item.timer = null;
            if (item.transitionTimer) clearTimeout(item.transitionTimer);
            item.transitionTimer = null;
            item.renderVersion += 1;
            this._restoreMediaVisibility(item.mediaEl);
            this._removeVideoHandler(item);
        }
        const [aMedia, aEl, aLocked, aMissingKey] = [a.media, a.mediaEl, a.locked, a.missingMediaKey];
        const [bMedia, bEl, bLocked, bMissingKey] = [b.media, b.mediaEl, b.locked, b.missingMediaKey];
        if (aEl) aEl.remove();
        if (bEl) bEl.remove();
        a.media = bMedia;
        a.mediaEl = bEl;
        a.locked = bLocked;
        a.missingMediaKey = bMissingKey;
        b.media = aMedia;
        b.mediaEl = aEl;
        b.locked = aLocked;
        b.missingMediaKey = aMissingKey;
        if (bEl) a.cell.appendChild(bEl);
        if (aEl) b.cell.appendChild(aEl);
        for (const item of [a, b]) {
            if (item.locked && item.media?.type === "video" && item.mediaEl) item.mediaEl.loop = true;
            this._scheduleRotation(item);
        }
        this._notifyChange("swap", { a, b });
        return true;
    }

    ignoreMedia(media) {
        const key = typeof media === "string" ? media : this._mediaKey(media);
        if (!key) return false;
        this.ignoredMedia.add(key);
        this.filteredMedia.clear();
        this.pool = this.pool.filter((candidate) => this._mediaKey(candidate) !== key);
        this.freezeLayout();
        for (const item of this.displayedItems) {
            if (this._mediaKey(item.media) !== key) continue;
            item.locked = false;
            this._replaceItem(item, { clearWhenUnavailable: true, allowPaused: true });
        }
        this._notifyChange("ignore", { key });
        return true;
    }

    restoreIgnored(key) {
        if (!this.ignoredMedia.delete(key)) return false;
        this.filteredMedia.clear();
        this.reshufflePool();
        this._notifyChange("restore-ignored", { key });
        return true;
    }

    exportState() {
        this.freezeLayout();
        return {
            version: 1,
            settings: { ...this.settings },
            geometry: (this.frozenGeometry || []).map((entry) => ({ ...entry })),
            grid: { ...this.frozenGrid },
            masonry: { columns: this.masonryColumns, rows: this.masonryRows },
            pins: this.displayedItems
                .map((item, index) => item.locked ? { index, mediaKey: this._mediaKey(item.media) || item.missingMediaKey } : null)
                .filter(Boolean),
            ignored: [...this.ignoredMedia],
        };
    }

    async restoreState(snapshot, files) {
        this.setMedia(files || []);
        if (!snapshot || typeof snapshot !== "object") return;
        this.settings = { ...this.settings, ...(snapshot.settings || {}) };
        this.ignoredMedia = new Set(Array.isArray(snapshot.ignored) ? snapshot.ignored : []);
        this.filteredMedia.clear();
        this.frozenGeometry = Array.isArray(snapshot.geometry) ? snapshot.geometry.map((entry) => ({ ...entry })) : null;
        this.frozenGrid = snapshot.grid ? { columns: snapshot.grid.columns, rows: snapshot.grid.rows } : null;
        if (snapshot.masonry) {
            this.masonryColumns = snapshot.masonry.columns || this.masonryColumns;
            this.masonryRows = snapshot.masonry.rows || this.masonryRows;
        }
        const byKey = new Map(this.mediaFiles.map((media) => [this._mediaKey(media), media]));
        this.pendingPins = Array.isArray(snapshot.pins) ? snapshot.pins.map((pin) => ({
            index: pin.index,
            mediaKey: pin.mediaKey,
            media: byKey.get(pin.mediaKey) || null,
        })) : [];
        this.gridEl.dataset.fitMode = this.settings.fitMode;
        this.reshufflePool();
        if (this.running) this.buildGrid();
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
const presetSelect = document.getElementById("preset-select");
const presetName = document.getElementById("preset-name");
const saveNewPresetButton = document.getElementById("save-new-preset");
const overwritePresetButton = document.getElementById("overwrite-preset");
const unsavedIndicator = document.getElementById("unsaved-indicator");
const ignoredGallery = document.getElementById("ignored-gallery");
const showIgnoredButton = document.getElementById("restore-ignored");
const decisionDialog = document.getElementById("decision-dialog");
const decisionTitle = document.getElementById("decision-title");
const decisionMessage = document.getElementById("decision-message");
const decisionSave = document.getElementById("decision-save");
const decisionDiscard = document.getElementById("decision-discard");
const decisionCancel = document.getElementById("decision-cancel");
const mergeStatusEl = document.getElementById("merge-status");

const persistence = {
    folderPath: null,
    files: [],
    presets: [],
    selectedPresetId: null,
    dirty: false,
    busy: false,
    confirmLeave: null,
    saveNew: null,
    overwrite: null,
    loadPreset: null,
};

window.persistenceController = persistence;

function setDirty(value = true) {
    persistence.dirty = Boolean(value);
    unsavedIndicator.classList.toggle("is-dirty", persistence.dirty);
    unsavedIndicator.textContent = persistence.dirty ? "Unsaved changes" : "No unsaved changes";
}
setDirty(false);

function showDecision({ title, message, saveLabel = "Save", discardLabel = "Discard", showDiscard = true } = {}) {
    decisionTitle.textContent = title || "Save changes?";
    decisionMessage.textContent = message || "Save your layout before you leave?";
    decisionSave.textContent = saveLabel;
    decisionDiscard.textContent = discardLabel;
    decisionDiscard.hidden = !showDiscard;
    decisionDialog.hidden = false;
    decisionSave.focus();
    return new Promise((resolve) => {
        const finish = (value) => {
            decisionDialog.hidden = true;
            decisionSave.removeEventListener("click", onSave);
            decisionDiscard.removeEventListener("click", onDiscard);
            decisionCancel.removeEventListener("click", onCancel);
            resolve(value);
        };
        const onSave = () => finish("save");
        const onDiscard = () => finish("discard");
        const onCancel = () => finish("cancel");
        decisionSave.addEventListener("click", onSave, { once: true });
        decisionDiscard.addEventListener("click", onDiscard, { once: true });
        decisionCancel.addEventListener("click", onCancel, { once: true });
    });
}

function showMessage(title, message) {
    return showDecision({ title, message, saveLabel: "OK", showDiscard: false });
}

// ── Settings panel toggle ─────────────────────────────────────────────────────

function openSettings() {
    settingsPanel.classList.add("open");
    settingsToggle.hidden = true;
    renderIgnoredGallery();
}
function closeSettings() {
    settingsPanel.classList.remove("open");
    settingsToggle.hidden = false;
    releaseIgnoredGallery();
}
function toggleSettings() {
    if (settingsPanel.classList.contains("open")) closeSettings();
    else openSettings();
}

const settingsGroups = [
    { title: "Layout", ids: ["[data-mode]", "[data-redraw]", "[data-fit-mode]", "#slots-slider", "#gap-slider"] },
    { title: "Playback", ids: ["[data-media-filter]", "#image-time-slider", "[data-video]", "#pause-btn", "#fullscreen-btn"] },
    { title: "Saved", ids: ["#preset-select", "#restore-ignored"] },
];
const settingsTabs = document.createElement("div");
settingsTabs.className = "settings-tabs";
settingsTabs.setAttribute("role", "tablist");
settingsTabs.setAttribute("aria-label", "Settings sections");
settingsPanel.querySelector(".settings-section").after(settingsTabs);
const settingsPages = settingsGroups.map((group, index) => {
    const page = document.createElement("section");
    page.className = "settings-page";
    page.id = `settings-page-${index}`;
    page.setAttribute("role", "tabpanel");
    page.hidden = index !== 0;
    for (const selector of group.ids) page.appendChild(settingsPanel.querySelector(selector).closest(".settings-section"));
    const button = document.createElement("button");
    button.type = "button";
    button.id = `settings-tab-${index}`;
    button.textContent = group.title;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", page.id);
    button.setAttribute("aria-selected", String(index === 0));
    button.tabIndex = index === 0 ? 0 : -1;
    page.setAttribute("aria-labelledby", button.id);
    settingsTabs.appendChild(button);
    settingsPanel.querySelector(".hint").before(page);
    button.addEventListener("click", () => {
        settingsPages.forEach((entry) => {
            const selected = entry.page === page;
            entry.page.hidden = !selected;
            entry.button.setAttribute("aria-selected", String(selected));
            entry.button.tabIndex = selected ? 0 : -1;
        });
        releaseIgnoredGallery();
        if (group.title === "Saved") renderIgnoredGallery();
    });
    button.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        event.preventDefault();
        const next = (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
        settingsPages[next].button.click();
        settingsPages[next].button.focus();
    });
    return { page, button };
});

settingsToggle.addEventListener("click", toggleSettings);
settingsClose.addEventListener("click", closeSettings);

function setActiveToggle(buttons, predicate) {
    buttons.forEach((button) => {
        button.classList.toggle("active", predicate(button));
    });
}

function presetLabel(preset) {
    const savedAt = new Date(preset.createdAt).toLocaleString();
    return preset.title ? `${preset.title} — ${savedAt}` : savedAt;
}

function renderPresetOptions() {
    const selected = persistence.selectedPresetId;
    presetSelect.replaceChildren(new Option("Choose a saved layout", ""));
    for (const preset of persistence.presets) {
        presetSelect.add(new Option(presetLabel(preset), preset.id));
    }
    presetSelect.value = selected || "";
    overwritePresetButton.disabled = !selected || !persistence.presets.some((item) => item.id === selected);
    saveNewPresetButton.disabled = !persistence.folderPath || persistence.busy;
}

let ignoredObserver = null;
function releaseIgnoredGallery() {
    ignoredObserver?.disconnect();
    ignoredObserver = null;
    ignoredGallery.querySelectorAll("video").forEach((video) => {
        video.pause();
        video.removeAttribute("src");
        video.load();
    });
}

function renderIgnoredGallery() {
    releaseIgnoredGallery();
    ignoredGallery.replaceChildren();
    const ignored = grid.ignoredMedia;
    const ignoredCount = ignored?.size || 0;
    showIgnoredButton.textContent = `${ignoredGallery.hidden ? "Show" : "Hide"} ignored media (${ignoredCount})`;
    showIgnoredButton.setAttribute("aria-expanded", String(!ignoredGallery.hidden));
    showIgnoredButton.disabled = ignoredCount === 0;
    if (!ignored || ignored.size === 0) {
        const empty = document.createElement("p");
        empty.className = "setting-note";
        empty.textContent = "No ignored media.";
        ignoredGallery.appendChild(empty);
        return;
    }
    if ("IntersectionObserver" in window) {
        ignoredObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const video = entry.target;
                if (entry.isIntersecting && video.dataset.src) {
                    video.src = video.dataset.src;
                    video.preload = "metadata";
                    video.removeAttribute("data-src");
                } else if (!entry.isIntersecting && video.src) {
                    video.pause();
                    video.removeAttribute("src");
                    video.preload = "none";
                    video.load();
                    video.dataset.src = video.dataset.originalSrc;
                }
            }
        }, { root: settingsPanel, rootMargin: "100px" });
    }
    for (const key of ignored) {
        const media = persistence.files.find((item) => (item.path || item.url) === key);
        if (!media) continue;
        const card = document.createElement("div");
        card.className = "ignored-card";
        const thumbnail = document.createElement(media.type === "video" ? "video" : "img");
        thumbnail.alt = media.name || "Ignored media";
        if (media.type === "video") {
            thumbnail.muted = true;
            thumbnail.preload = "none";
            thumbnail.dataset.src = media.url;
            thumbnail.dataset.originalSrc = media.url;
            if (ignoredObserver) ignoredObserver.observe(thumbnail);
        } else {
            thumbnail.loading = "lazy";
            thumbnail.src = media.url;
        }
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `Restore ${media.name || "media"}`;
        button.title = button.textContent;
        button.addEventListener("click", () => {
            if (grid.restoreIgnored(key)) {
                setDirty();
                renderIgnoredGallery();
            }
        });
        card.append(thumbnail, button);
        ignoredGallery.appendChild(card);
    }
}

showIgnoredButton.addEventListener("click", () => {
    ignoredGallery.hidden = !ignoredGallery.hidden;
    renderIgnoredGallery();
    if (ignoredGallery.hidden) releaseIgnoredGallery();
});

function syncSettingsControls() {
    setActiveToggle(modeButtons, (button) => button.dataset.mode === grid.settings.gridMode);
    setActiveToggle(redrawButtons, (button) => (button.dataset.redraw === "on") === grid.settings.redrawOnRefresh);
    setActiveToggle(mediaFilterButtons, (button) => button.dataset.mediaFilter === grid.settings.mediaFilter);
    setActiveToggle(fitModeButtons, (button) => button.dataset.fitMode === grid.settings.fitMode);
    document.querySelectorAll("[data-video]").forEach((button) => button.classList.toggle("active", button.dataset.video === grid.settings.videoBehavior));
    slotsSlider.value = String(grid.settings.slotCount);
    slotsValue.textContent = String(grid.settings.slotCount);
    imageTimeSlider.value = String(grid.settings.imageTime);
    imageTimeValue.textContent = `${grid.settings.imageTime} s`;
    gapSlider.value = String(grid.settings.gap);
    gapValue.textContent = `${grid.settings.gap} px`;
}

async function refreshPresets() {
    if (!persistence.folderPath) return;
    persistence.presets = await window.mediaAPI.listPresets(persistence.folderPath);
    renderPresetOptions();
}

async function saveNew() {
    if (!persistence.folderPath || persistence.busy) return false;
    persistence.busy = true;
    saveNewPresetButton.disabled = true;
    overwritePresetButton.disabled = true;
    try {
        const preset = await window.mediaAPI.savePreset(persistence.folderPath, presetName.value, grid.exportState());
        persistence.presets.push(preset);
        persistence.selectedPresetId = preset.id;
        renderPresetOptions();
        setDirty(false);
        return true;
    } catch (error) {
        await showMessage("Could not save layout", error.message || "The layout was not saved.");
        return false;
    } finally {
        persistence.busy = false;
        saveNewPresetButton.disabled = !persistence.folderPath;
        overwritePresetButton.disabled = !persistence.selectedPresetId;
    }
}

async function overwrite() {
    if (!persistence.folderPath || !persistence.selectedPresetId) return saveNew();
    if (persistence.busy) return false;
    persistence.busy = true;
    saveNewPresetButton.disabled = true;
    overwritePresetButton.disabled = true;
    try {
        const preset = await window.mediaAPI.savePreset(
            persistence.folderPath, presetName.value, grid.exportState(), persistence.selectedPresetId
        );
        persistence.presets = persistence.presets.map((item) => item.id === preset.id ? preset : item);
        renderPresetOptions();
        setDirty(false);
        return true;
    } catch (error) {
        await showMessage("Could not save layout", error.message || "The layout was not saved.");
        return false;
    } finally {
        persistence.busy = false;
        saveNewPresetButton.disabled = !persistence.folderPath;
        overwritePresetButton.disabled = !persistence.selectedPresetId;
    }
}

async function saveCurrent() {
    if (!persistence.selectedPresetId) return saveNew();
    const choice = await showDecision({
        title: "Save layout",
        message: "Save these changes as a new layout or replace the selected layout?",
        saveLabel: "Save New",
        discardLabel: "Overwrite",
    });
    if (choice === "save") return saveNew();
    if (choice === "discard") return overwrite();
    return false;
}

async function confirmLeave(reason = "leave") {
    if (!persistence.dirty) return true;
    const result = await showDecision({
        title: "Unsaved layout",
        message: `Save your layout before you ${reason}?`,
    });
    if (result === "cancel") return false;
    if (result === "discard") return true;
    return saveCurrent();
}

persistence.saveNew = saveNew;
persistence.overwrite = overwrite;
persistence.confirmLeave = confirmLeave;
persistence.loadPreset = async (presetId) => {
    if (!presetId) return false;
    if (!(await confirmLeave("open another layout"))) return false;
    const preset = persistence.presets.find((item) => item.id === presetId);
    if (!preset) return false;
    persistence.files = await window.mediaAPI.getMediaFiles(persistence.folderPath);
    await grid.restoreState(preset.snapshot, persistence.files);
    persistence.selectedPresetId = preset.id;
    presetName.value = preset.title;
    syncSettingsControls();
    renderPresetOptions();
    setDirty(false);
    renderIgnoredGallery();
    return true;
};

grid.onChange = (event) => {
    if (!new Set(["merge-selection", "merge-status", "merge-invalid"]).has(event.type)) setDirty();
    mergeStatusEl.textContent = grid.mergeStatus;
    mergeStatusEl.hidden = !grid.mergeStatus;
    if (event.type === "merge") {
        slotsSlider.value = String(grid.settings.slotCount);
        slotsValue.textContent = String(grid.settings.slotCount);
    }
    if (event.type === "ignore" || event.type === "restore-ignored") renderIgnoredGallery();
    for (const item of grid.displayedItems) {
        item.cell.classList.toggle("is-locked", Boolean(item.locked));
        item.cell.classList.toggle("is-missing-pin", Boolean(item.locked && !item.media && item.missingMediaKey));
        item.cell.classList.toggle("merge-selected", Boolean(item.selectedForMerge));
        item.cell.setAttribute("role", "button");
        item.cell.tabIndex = 0;
        item.cell.setAttribute("aria-label", `${item.media?.name || "Empty media slot"}${item.locked ? ", locked" : ", unlocked"}`);
    }
};

saveNewPresetButton.addEventListener("click", saveNew);
overwritePresetButton.addEventListener("click", overwrite);
presetSelect.addEventListener("change", async () => {
    const targetId = presetSelect.value;
    if (!targetId) {
        persistence.selectedPresetId = null;
        overwritePresetButton.disabled = true;
        return;
    }
    if (!(await persistence.loadPreset(targetId))) renderPresetOptions();
});
presetName.addEventListener("input", () => {
    if (persistence.selectedPresetId) setDirty();
});

// ── Grid mode buttons ─────────────────────────────────────────────────────────

const modeButtons = document.querySelectorAll("[data-mode]");
const redrawButtons = document.querySelectorAll("[data-redraw]");
const mediaFilterButtons = document.querySelectorAll("[data-media-filter]");
const fitModeButtons = document.querySelectorAll("button[data-fit-mode]");

async function updateLayoutWithConfirmation(changes) {
    if (Object.entries(changes).every(([key, value]) => grid.settings[key] === value)) return true;
    const layoutChange = ("gridMode" in changes && changes.gridMode !== grid.settings.gridMode) ||
        ("slotCount" in changes && changes.slotCount !== grid.settings.slotCount);
    if (layoutChange) {
        const choice = await showDecision({
            title: "Clear locked tiles?",
            message: "Changing the grid mode or slot count clears locked tiles and saved positions. Ignored media stays ignored.",
            saveLabel: "Continue",
            showDiscard: false,
        });
        if (choice !== "save") return false;
        grid.clearLocks();
    }
    grid.updateSettings(changes);
    setDirty();
    return true;
}

modeButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
        if (await updateLayoutWithConfirmation({ gridMode: btn.dataset.mode })) {
            setActiveToggle(modeButtons, (button) => button === btn);
        }
    });
});

redrawButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        setActiveToggle(redrawButtons, (button) => button === btn);
        grid.updateSettings({ redrawOnRefresh: btn.dataset.redraw === "on" });
        setDirty();
    });
});

mediaFilterButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        const nextFilter = btn.dataset.mediaFilter;
        setActiveToggle(mediaFilterButtons, (button) => button === btn);
        grid.updateSettings({ mediaFilter: nextFilter });
        setDirty();
    });
});

fitModeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        setActiveToggle(fitModeButtons, (button) => button === btn);
        grid.updateSettings({ fitMode: btn.dataset.fitMode });
        setDirty();
    });
});

// ── Video behavior buttons ────────────────────────────────────────────────────

document.querySelectorAll("[data-video]").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll("[data-video]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        grid.updateSettings({ videoBehavior: btn.dataset.video });
        setDirty();
    });
});

// ── Sliders ───────────────────────────────────────────────────────────────────

slotsSlider.addEventListener("input", () => {
    const val = parseInt(slotsSlider.value, 10);
    slotsValue.textContent = val;
});
slotsSlider.addEventListener("change", async () => {
    const val = parseInt(slotsSlider.value, 10);
    if (!(await updateLayoutWithConfirmation({ slotCount: val }))) syncSettingsControls();
});

imageTimeSlider.addEventListener("input", () => {
    const val = parseInt(imageTimeSlider.value, 10);
    imageTimeValue.textContent = `${val} s`;
    grid.updateSettings({ imageTime: val });
    setDirty();
});

gapSlider.addEventListener("input", () => {
    const val = parseInt(gapSlider.value, 10);
    gapValue.textContent = `${val} px`;
    grid.updateSettings({ gap: val });
    setDirty();
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
    if (!(await confirmLeave("open another folder"))) return;
    const result = await window.mediaAPI.selectFolder();
    if (!result) return;

    const { folderPath, files } = result;

    await grid.setMedia(files);
    persistence.folderPath = folderPath;
    persistence.files = files;
    persistence.selectedPresetId = null;
    persistence.presets = [];
    presetName.value = "";
    folderPathEl.textContent = folderPath;
    try {
        await refreshPresets();
    } catch (error) {
        persistence.presets = [];
        renderPresetOptions();
        await showMessage("Saved layouts unavailable", error.message || "Saved layouts could not be read.");
    }

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

    setDirty(false);
    renderIgnoredGallery();

    closeSettings();
}

loadFolderBtn.addEventListener("click", loadFolder);
loadFolderSettings.addEventListener("click", loadFolder);

// ── Window resize → rebuild grid ──────────────────────────────────────────────

let resizeTimer;
window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (grid.running) grid.handleResize();
    }, 250);
});

const cellObserver = new MutationObserver((records) => {
    for (const record of records) {
        for (const node of record.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const cells = [];
            if (node.matches?.(".grid-cell")) cells.push(node);
            node.querySelectorAll?.(".grid-cell").forEach((cell) => cells.push(cell));
            for (const cell of cells) {
                const item = itemForCell(cell);
                cell.draggable = true;
                cell.setAttribute("role", "button");
                cell.tabIndex = 0;
                cell.classList.toggle("is-locked", Boolean(item?.locked));
                cell.classList.toggle("is-missing-pin", Boolean(item?.locked && !item.media && item.missingMediaKey));
                cell.classList.toggle("merge-selected", Boolean(item?.selectedForMerge));
                cell.setAttribute("aria-label", `${item?.media?.name || (item?.missingMediaKey ? "File missing" : "Empty media slot")}${item?.locked ? ", locked" : ", unlocked"}`);
            }
        }
    }
});
cellObserver.observe(gridEl, { childList: true, subtree: true });

function itemForCell(cell) {
    return grid.displayedItems.find((item) => item.cell === cell) || null;
}

gridEl.addEventListener("click", (event) => {
    if (Date.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
    }
    const cell = event.target.closest?.(".grid-cell");
    const item = cell && itemForCell(cell);
    if (event.ctrlKey) {
        if (!item) return;
        event.preventDefault();
        grid.selectMergeItem(item);
        return;
    }
    if (item && (item.media || (item.locked && item.missingMediaKey))) {
        grid.toggleLock(item);
        cell.classList.toggle("is-locked", Boolean(item.locked));
        cell.classList.toggle("is-missing-pin", Boolean(item.locked && !item.media && item.missingMediaKey));
        cell.setAttribute("aria-label", `${item.media?.name || "File missing"}${item.locked ? ", locked" : ", unlocked"}`);
    }
});

gridEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const cell = event.target.closest?.(".grid-cell");
    const item = cell && itemForCell(cell);
    if (!item || (!item.media && !(item.locked && item.missingMediaKey))) return;
    event.preventDefault();
    grid.toggleLock(item);
    cell.classList.toggle("is-locked", Boolean(item.locked));
    cell.classList.toggle("is-missing-pin", Boolean(item.locked && !item.media && item.missingMediaKey));
    cell.setAttribute("aria-label", `${item.media?.name || "File missing"}${item.locked ? ", locked" : ", unlocked"}`);
});

gridEl.addEventListener("contextmenu", (event) => {
    const cell = event.target.closest?.(".grid-cell");
    const item = cell && itemForCell(cell);
    if (!item || (!item.media && !(item.locked && item.missingMediaKey))) return;
    event.preventDefault();
    grid.ignoreMedia(item.media);
    renderIgnoredGallery();
});

let draggedItem = null;
let suppressClickUntil = 0;
gridEl.addEventListener("dragstart", (event) => {
    const cell = event.target.closest?.(".grid-cell");
    draggedItem = cell && itemForCell(cell);
    if (!draggedItem?.media) {
        event.preventDefault();
        draggedItem = null;
        return;
    }
    event.dataTransfer.effectAllowed = "move";
});
gridEl.addEventListener("dragover", (event) => {
    if (draggedItem) event.preventDefault();
});
gridEl.addEventListener("drop", (event) => {
    const cell = event.target.closest?.(".grid-cell");
    const target = cell && itemForCell(cell);
    if (!draggedItem || !target) return;
    event.preventDefault();
    grid.swapItems(draggedItem, target);
    suppressClickUntil = Date.now() + 350;
    draggedItem = null;
});
gridEl.addEventListener("dragend", () => { draggedItem = null; });

window.mediaAPI.onCloseRequest(async () => {
    if (!persistence.dirty) {
        releaseIgnoredGallery();
        await window.mediaAPI.resolveClose("discard");
        return;
    }
    const action = await showDecision({
        title: persistence.dirty ? "Unsaved layout" : "Close Multi-Display?",
        message: persistence.dirty ? "Save your layout before closing?" : "Close the application?",
        saveLabel: persistence.dirty ? "Save" : "Close",
        discardLabel: "Discard",
        showDiscard: persistence.dirty,
    });
    if (action === "cancel") {
        await window.mediaAPI.resolveClose("cancel");
        return;
    }
    if (action === "save" && persistence.dirty && !(await saveCurrent())) {
        await window.mediaAPI.resolveClose("cancel");
        return;
    }
    releaseIgnoredGallery();
    await window.mediaAPI.resolveClose(action === "discard" ? "discard" : "saved");
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
    if (!decisionDialog.hidden) {
        if (e.key === "Escape") decisionCancel.click();
        return;
    }
    if (e.key === "Escape" && grid.cancelMergeSelection()) {
        e.preventDefault();
        return;
    }
    if (e.target.matches?.("input, textarea, select, button, [contenteditable='true']")) return;
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
