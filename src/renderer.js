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

        this.running = false;
        this.paused = false;
        this.layoutVersion = 0;
        this.masonryLayoutToken = 0;
        this.masonryColumns = 6;
        this.masonryRows = 4;
        this.mediaDimensions = new Map();
        this.mediaMetrics = new Map();
        this.aspectProfiles = new Map();

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
        if (filter === "image") {
            return this.mediaFiles.filter((media) => media.type === "image");
        }

        if (filter === "video") {
            return this.mediaFiles.filter((media) => media.type === "video");
        }

        return this.mediaFiles;
    }

    countMediaForFilter(filter = this.settings.mediaFilter) {
        return this._filteredMediaFiles(filter).length;
    }

    reshufflePool() {
        this.pool = [...this._filteredMediaFiles()].sort(() => Math.random() - 0.5);
    }

    getNextMedia(preferredAspect = null) {
        if (this._filteredMediaFiles().length === 0) return null;
        if (this.pool.length === 0) this.reshufflePool();
        if (this.pool.length === 0) return null;

        if (!preferredAspect || !Number.isFinite(preferredAspect) || this.pool.length === 1) {
            return this.pool.shift();
        }

        const lookahead = Math.min(18, this.pool.length);
        let bestIndex = 0;
        let bestScore = Number.POSITIVE_INFINITY;

        for (let i = 0; i < lookahead; i++) {
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

    async setMedia(files) {
        this.mediaDimensions.clear();
        this.mediaMetrics.clear();
        this.aspectProfiles.clear();
        this.mediaFiles = files;
        await this._primeMediaMeasurements(files);
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
        for (const item of this.displayedItems) {
            if (item.timer) clearTimeout(item.timer);
            this._removeVideoHandler(item);
        }
        this.displayedItems = [];
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
            this.gridEl.style.gridAutoRows = "";
            this.gridEl.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
            this.gridEl.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
            this.masonryColumns = columns;
            this.masonryRows = rows;

            for (let i = 0; i < visibleSlots; i++) this._addCell();
            void this._refreshMasonryLayout(buildVersion);
        }
    }

    _cellAspect(columns, rows, gap) {
        const w = this.gridEl.clientWidth || window.innerWidth;
        const h = this.gridEl.clientHeight || window.innerHeight;
        const cellW = (w - gap * (columns - 1)) / Math.max(columns, 1);
        const cellH = (h - gap * (rows - 1)) / Math.max(rows, 1);
        return cellW / Math.max(cellH, 1);
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

    _masonryGridDimensions(slotCount, gridMode = this.settings.gridMode) {
        const w = this.gridEl.clientWidth || window.innerWidth;
        const h = this.gridEl.clientHeight || window.innerHeight;
        const viewportAspect = w / Math.max(h, 1);
        const baseTargetUnits =
            slotCount <= 4
                ? slotCount * 4
                : slotCount <= 8
                  ? slotCount * 3.5
                  : slotCount <= 16
                    ? slotCount * 2.75
                    : slotCount * 2.15;
        const profile = gridMode === "smart-masonry" ? this._getAspectProfile() : null;
        const spreadFactor = 1 + Math.min(profile?.spread || 0, 0.6) * 0.35;
        const targetUnits = baseTargetUnits * spreadFactor;
        const targetGridAspect =
            gridMode === "smart-masonry" && profile
                ? viewportAspect * Math.exp(Math.max(-0.45, Math.min(0.45, Math.log(profile.median || 1))) * 0.55)
                : viewportAspect;

        let best = { columns: 4, rows: 3, score: Number.POSITIVE_INFINITY };

        for (let columns = 2; columns <= 12; columns++) {
            for (let rows = 2; rows <= 12; rows++) {
                const units = columns * rows;
                if (units < slotCount) continue;

                const gridAspect = columns / rows;
                const aspectScore = Math.abs(Math.log(gridAspect / targetGridAspect));
                const densityScore = Math.abs(units - targetUnits) / targetUnits;
                const coarsePenalty = units < slotCount * 1.5 ? 0.35 : 0;
                const profilePenalty = profile ? this._coverCropPenalty(gridAspect, profile.median) * 0.16 : 0;
                const score = aspectScore + densityScore * 0.85 + coarsePenalty + profilePenalty;

                if (score < best.score) {
                    best = { columns, rows, score };
                }
            }
        }

        return best;
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
            renderVersion: 0,
            videoEndHandler: null,
            layoutSeed: Math.random(),
            targetAspect,
        };
        this.displayedItems.push(item);
        this._scheduleRotation(item);
    }

    async _refreshMasonryLayout(buildVersion = this.layoutVersion) {
        const { gridMode } = this.settings;
        if (gridMode === "uniform") return;
        const layoutToken = ++this.masonryLayoutToken;

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

        const placements = this._buildPackedLayout(descriptors);
        const resolvedPlacements =
            gridMode === "smart-masonry"
                ? this._matchPlacementsToDescriptors(descriptors, placements)
                : placements;

        for (const placement of resolvedPlacements) {
            const item = this.displayedItems[placement.index];
            if (!item || !item.cell.isConnected) continue;

            item.cell.style.gridColumn = `${placement.x} / span ${placement.w}`;
            item.cell.style.gridRow = `${placement.y} / span ${placement.h}`;
            item.targetAspect = this._rectAspect(placement);
        }
    }

    _masonryAspectFromSeed(seed, mediaType) {
        const base = mediaType === "video" ? 1.45 : 1;
        const variation = 0.7 + seed * 1.35;
        return base * variation;
    }

    _buildPackedLayout(descriptors) {
        const ordered = [...descriptors].sort((a, b) => a.aspect - b.aspect || a.index - b.index);

        return this._partitionRect({ x: 1, y: 1, w: this.masonryColumns, h: this.masonryRows }, ordered);
    }

    _matchPlacementsToDescriptors(descriptors, placements) {
        const sortedDescriptors = [...descriptors].sort((a, b) => a.aspect - b.aspect || a.index - b.index);
        const sortedPlacements = [...placements].sort((a, b) => this._rectAspect(a) - this._rectAspect(b));

        return sortedDescriptors.map((descriptor, index) => ({
            ...sortedPlacements[index],
            index: descriptor.index,
        }));
    }

    _partitionRect(rect, descriptors) {
        if (descriptors.length === 1) {
            return [{ index: descriptors[0].index, ...rect }];
        }

        const split = this._chooseRectSplit(rect, descriptors);
        if (!split) {
            return this._sliceRect(rect, descriptors);
        }

        return [
            ...this._partitionRect(split.firstRect, split.first),
            ...this._partitionRect(split.secondRect, split.second),
        ];
    }

    _chooseRectSplit(rect, descriptors) {
        let best = null;

        for (const orientation of ["vertical", "horizontal"]) {
            const size = orientation === "vertical" ? rect.w : rect.h;
            if (size < 2) continue;

            for (let splitCount = 1; splitCount < descriptors.length; splitCount++) {
                const first = descriptors.slice(0, splitCount);
                const second = descriptors.slice(splitCount);
                const split = this._buildRectSplit(rect, first, second, orientation);
                if (!split) continue;

                const score = this._scoreRectSplit(
                    split.firstRect,
                    first,
                    split.secondRect,
                    second,
                    splitCount / descriptors.length
                );
                if (!best || score < best.score) {
                    best = { ...split, first, second, score };
                }
            }
        }

        return best;
    }

    _buildRectSplit(rect, first, second, orientation) {
        const size = orientation === "vertical" ? rect.w : rect.h;
        const crossSize = orientation === "vertical" ? rect.h : rect.w;
        const targetShare = this._idealSplitShare(first, second, orientation);
        const minSize = Math.max(1, Math.ceil(first.length / Math.max(crossSize, 1)));
        const maxSize = size - Math.max(1, Math.ceil(second.length / Math.max(crossSize, 1)));

        if (minSize >= size || maxSize <= 0 || minSize > maxSize) {
            return null;
        }

        const splitSize = Math.max(minSize, Math.min(maxSize, Math.round(size * targetShare)));
        if (splitSize <= 0 || splitSize >= size) return null;

        const firstRect =
            orientation === "vertical"
                ? { x: rect.x, y: rect.y, w: splitSize, h: rect.h }
                : { x: rect.x, y: rect.y, w: rect.w, h: splitSize };
        const secondRect =
            orientation === "vertical"
                ? { x: rect.x + splitSize, y: rect.y, w: rect.w - splitSize, h: rect.h }
                : { x: rect.x, y: rect.y + splitSize, w: rect.w, h: rect.h - splitSize };

        if (firstRect.w * firstRect.h < first.length || secondRect.w * secondRect.h < second.length) {
            return null;
        }

        return { firstRect, secondRect };
    }

    _idealSplitShare(first, second, orientation) {
        const firstDemand = this._aspectDemand(first, orientation);
        const secondDemand = this._aspectDemand(second, orientation);
        const totalDemand = firstDemand + secondDemand;
        const demandShare = totalDemand > 0 ? firstDemand / totalDemand : 0.5;
        const countShare = first.length / (first.length + second.length);

        return countShare * 0.28 + demandShare * 0.72;
    }

    _scoreRectSplit(firstRect, first, secondRect, second, targetShare) {
        const areaShare = (firstRect.w * firstRect.h) / (firstRect.w * firstRect.h + secondRect.w * secondRect.h);
        const cropScore = this._groupCropPenalty(firstRect, first) + this._groupCropPenalty(secondRect, second);
        const areaPenalty = Math.abs(areaShare - targetShare) * 0.25;
        const slenderPenalty = this._slenderPenalty(firstRect) + this._slenderPenalty(secondRect);
        const imbalancePenalty = this._groupAspectSpread(first) * 0.12 + this._groupAspectSpread(second) * 0.12;

        return cropScore + areaPenalty + slenderPenalty + imbalancePenalty;
    }

    _slenderPenalty(rect) {
        const aspect = this._rectAspect(rect);
        const inverse = 1 / Math.max(aspect, 0.001);
        return Math.max(0, aspect - 2.4) * 0.9 + Math.max(0, inverse - 2.4) * 0.9;
    }

    _rectAspect(rect, columns = this.masonryColumns, rows = this.masonryRows) {
        const gap = this.settings.gap;
        const w = this.gridEl.clientWidth || window.innerWidth;
        const h = this.gridEl.clientHeight || window.innerHeight;
        const cellW = (w - gap * (columns - 1)) / Math.max(columns, 1);
        const cellH = (h - gap * (rows - 1)) / Math.max(rows, 1);
        const rectW = cellW * rect.w + gap * Math.max(rect.w - 1, 0);
        const rectH = cellH * rect.h + gap * Math.max(rect.h - 1, 0);
        return rectW / Math.max(rectH, 1);
    }

    _meanAspect(descriptors) {
        const total = descriptors.reduce((sum, descriptor) => sum + Math.log(Math.max(descriptor.aspect, 0.1)), 0);
        return Math.exp(total / Math.max(descriptors.length, 1));
    }

    _aspectDemand(descriptors, orientation) {
        if (orientation === "vertical") {
            return descriptors.reduce((sum, descriptor) => sum + Math.max(descriptor.aspect, 0.15), 0);
        }

        return descriptors.reduce((sum, descriptor) => sum + 1 / Math.max(descriptor.aspect, 0.15), 0);
    }

    _coverCropPenalty(rectAspect, mediaAspect) {
        const safeMediaAspect = Math.max(mediaAspect, 0.1);
        const visibleFraction = Math.min(rectAspect / safeMediaAspect, safeMediaAspect / rectAspect, 1);
        const cropLoss = 1 - Math.max(visibleFraction, 0);

        return cropLoss * cropLoss * 6 + cropLoss;
    }

    _groupCropPenalty(rect, descriptors) {
        const rectAspect = this._rectAspect(rect);
        let worst = 0;
        const total = descriptors.reduce((sum, descriptor) => {
            const penalty = this._coverCropPenalty(rectAspect, descriptor.aspect);
            worst = Math.max(worst, penalty);
            return sum + penalty;
        }, 0);

        return total / Math.max(descriptors.length, 1) + worst * 0.85;
    }

    _groupAspectSpread(descriptors) {
        if (descriptors.length <= 1) return 0;

        const mean = Math.log(this._meanAspect(descriptors));
        const variance =
            descriptors.reduce((sum, descriptor) => {
                const delta = Math.log(Math.max(descriptor.aspect, 0.1)) - mean;
                return sum + delta * delta;
            }, 0) / descriptors.length;

        return Math.sqrt(variance);
    }

    _sliceRect(rect, descriptors) {
        const vertical = rect.w >= rect.h;
        const size = vertical ? rect.w : rect.h;
        const step = Math.max(1, Math.floor(size / descriptors.length));
        const placements = [];
        let cursor = vertical ? rect.x : rect.y;
        let remaining = size;

        descriptors.forEach((descriptor, index) => {
            const isLast = index === descriptors.length - 1;
            const span = isLast ? remaining : Math.max(1, Math.min(remaining - (descriptors.length - index - 1), step));
            placements.push({
                index: descriptor.index,
                x: vertical ? cursor : rect.x,
                y: vertical ? rect.y : cursor,
                w: vertical ? span : rect.w,
                h: vertical ? rect.h : span,
            });
            cursor += span;
            remaining -= span;
        });

        return placements;
    }

    _createMediaEl(media) {
        let el;
        if (media.type === "image") {
            el = document.createElement("img");
            el.src = media.url;
            el.alt = "";
            el.addEventListener("error", () => el.classList.add("media-error"));
        } else {
            el = document.createElement("video");
            el.src = media.url;
            el.autoplay = true;
            el.muted = true;
            el.playsInline = true;
            el.loop = this.settings.videoBehavior === "loop";
            el.addEventListener("error", () => el.classList.add("media-error"));
        }
        el.className = "media-element";
        return el;
    }

    _estimatedAspect(type) {
        const profile = this._getAspectProfile(type);
        if (profile?.median) return profile.median;
        return type === "video" ? 16 / 9 : 1;
    }

    _getMediaAspect(media) {
        const cacheKey = media.path || media.url;
        return this.mediaMetrics.get(cacheKey)?.aspect || this._estimatedAspect(media.type);
    }

    _getAspectProfile(filter = this.settings.mediaFilter) {
        const cacheKey = filter || "mixed";
        if (this.aspectProfiles.has(cacheKey)) {
            return this.aspectProfiles.get(cacheKey);
        }

        const aspects = this._filteredMediaFiles(filter)
            .map((media) => this.mediaMetrics.get(media.path || media.url)?.aspect)
            .filter((aspect) => Number.isFinite(aspect) && aspect > 0)
            .sort((a, b) => a - b);

        if (aspects.length === 0) {
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

    _primeMediaMeasurements(files) {
        return Promise.all(files.map((media) => this._measureMedia(media))).then(() => {
            this.aspectProfiles.clear();
        });
    }

    _measureMedia(media) {
        const cacheKey = media.path || media.url;
        if (this.mediaMetrics.has(cacheKey)) {
            return Promise.resolve(this.mediaMetrics.get(cacheKey));
        }
        if (this.mediaDimensions.has(cacheKey)) {
            return this.mediaDimensions.get(cacheKey);
        }

        const pending = (media.type === "video" ? this._measureVideo(media.url) : this._measureImage(media.url)).then(
            (metadata) => {
                this.mediaMetrics.set(cacheKey, metadata);
                this.mediaDimensions.delete(cacheKey);
                this.aspectProfiles.clear();
                return metadata;
            }
        );

        this.mediaDimensions.set(cacheKey, pending);
        return pending;
    }

    _measureImage(url) {
        return new Promise((resolve) => {
            const img = new Image();

            img.onload = () => {
                const width = img.naturalWidth || 1;
                const height = img.naturalHeight || 1;
                resolve({ width, height, aspect: width / Math.max(height, 1) });
            };

            img.onerror = () => {
                resolve({ width: 1, height: 1, aspect: 1 });
            };

            img.src = url;
        });
    }

    _measureVideo(url) {
        return new Promise((resolve) => {
            const video = document.createElement("video");
            video.preload = "metadata";
            video.muted = true;
            video.playsInline = true;

            video.onloadedmetadata = () => {
                const width = video.videoWidth || 16;
                const height = video.videoHeight || 9;
                resolve({ width, height, aspect: width / Math.max(height, 1) });
            };

            video.onerror = () => {
                resolve({ width: 16, height: 9, aspect: 16 / 9 });
            };

            video.src = url;
            video.load();
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
        if (this.paused) return;

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

        setTimeout(() => {
            if (!this.running || !item.cell.isConnected || renderVersion !== item.renderVersion) {
                return;
            }

            const oldEl = item.mediaEl;
            const newEl = this._createMediaEl(newMedia);

            // Start invisible, then fade in
            newEl.style.opacity = "0";
            item.cell.appendChild(newEl);
            oldEl.remove();

            item.mediaEl = newEl;
            item.media = newMedia;
            if (this.settings.redrawOnRefresh && this.settings.gridMode !== "uniform") {
                void this._refreshMasonryLayout(this.layoutVersion);
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
