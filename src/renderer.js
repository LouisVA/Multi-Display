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
        return this._candidateMasonryGridDimensions(slotCount, gridMode)[0] || { columns: 4, rows: 3, score: 0 };
    }

    _candidateMasonryGridDimensions(slotCount, gridMode = this.settings.gridMode) {
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
        const candidates = [];

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

                candidates.push({ columns, rows, score, units, gridAspect });
            }
        }

        candidates.sort(
            (left, right) =>
                left.score - right.score ||
                Math.abs(left.gridAspect - targetGridAspect) - Math.abs(right.gridAspect - targetGridAspect) ||
                left.units - right.units
        );

        const shortlist = [];
        const targetCount = gridMode === "smart-masonry" ? 3 : 1;

        for (const candidate of candidates) {
            const tooSimilar = shortlist.some((existing) => {
                const aspectGap = Math.abs(Math.log(candidate.gridAspect / existing.gridAspect));
                const unitGap = Math.abs(candidate.units - existing.units);
                return aspectGap < 0.12 && unitGap < 3;
            });

            if (!tooSimilar) {
                shortlist.push(candidate);
            }

            if (shortlist.length >= targetCount) {
                break;
            }
        }

        if (shortlist.length < targetCount) {
            for (const candidate of candidates) {
                if (
                    shortlist.some(
                        (existing) => existing.columns === candidate.columns && existing.rows === candidate.rows
                    )
                ) {
                    continue;
                }
                shortlist.push(candidate);
                if (shortlist.length >= targetCount) {
                    break;
                }
            }
        }

        return shortlist.length > 0 ? shortlist : [{ columns: 4, rows: 3, score: 0, units: 12, gridAspect: 4 / 3 }];
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
            const layout = this._buildSmartMasonryLayout(descriptors, { reason, changedIndex });
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

    _buildSmartMasonryLayout(descriptors, options = {}) {
        if (descriptors.length === 0) {
            return {
                placements: [],
                columns: this.masonryColumns,
                rows: this.masonryRows,
                score: 0,
                cropScore: 0,
            };
        }

        const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        const diagnostics = {
            reason: options.reason || "refresh",
            changedIndex: Number.isInteger(options.changedIndex) ? options.changedIndex : null,
            gridCandidates: [],
            exploredTilings: 0,
            evaluatedLayouts: 0,
            repairCandidates: 0,
            usedLocalRepair: false,
            fallbackEvaluated: false,
        };

        if (diagnostics.reason === "refresh") {
            const repaired = this._repairSmartLayoutLocally(descriptors, options);
            if (repaired) {
                diagnostics.repairCandidates = repaired.evaluatedLayouts;
                if (this._isAcceptableSmartRepair(repaired.best)) {
                    diagnostics.usedLocalRepair = true;
                    return this._finalizeSmartLayout(repaired.best, diagnostics, startedAt, "local-repair");
                }
            }
        }

        const gridCandidates = this._candidateMasonryGridDimensions(descriptors.length, "smart-masonry");
        const fallbackPlacements = this._buildPackedLayout(descriptors).map(({ x, y, w, h }) => ({ x, y, w, h }));

        let best = null;

        gridCandidates.forEach((gridCandidate, gridRank) => {
            const tilingResult = this._generateCandidateTilings(
                gridCandidate.columns,
                gridCandidate.rows,
                descriptors.length,
                descriptors,
                gridRank
            );
            diagnostics.gridCandidates.push({
                columns: gridCandidate.columns,
                rows: gridCandidate.rows,
                tilings: tilingResult.tilings.length,
                nodes: tilingResult.nodes,
            });
            diagnostics.exploredTilings += tilingResult.tilings.length;

            for (const placements of tilingResult.tilings) {
                const scored = this._scoreCandidateLayout(descriptors, placements, {
                    columns: gridCandidate.columns,
                    rows: gridCandidate.rows,
                    previousPlacements: this.previousSmartPlacements,
                    previousGrid: this.previousSmartGrid,
                });
                if (!scored) continue;
                diagnostics.evaluatedLayouts += 1;

                if (this._isBetterSmartLayoutCandidate(scored, best)) {
                    best = scored;
                }
            }
        });

        const fallbackScore = this._scoreCandidateLayout(descriptors, fallbackPlacements, {
            columns: this.masonryColumns,
            rows: this.masonryRows,
            previousPlacements: this.previousSmartPlacements,
            previousGrid: this.previousSmartGrid,
        });
        diagnostics.fallbackEvaluated = Boolean(fallbackScore);
        if (fallbackScore) {
            diagnostics.evaluatedLayouts += 1;
        }

        if (fallbackScore && this._isBetterSmartLayoutCandidate(fallbackScore, best)) {
            best = fallbackScore;
        }

        if (best) {
            return this._finalizeSmartLayout(best, diagnostics, startedAt, best.repairSource || "global-search");
        }

        return {
            placements: this._matchPlacementsToDescriptors(descriptors, fallbackPlacements),
            columns: this.masonryColumns,
            rows: this.masonryRows,
            score: 0,
            cropScore: 0,
        };
    }

    _repairSmartLayoutLocally(descriptors, options = {}) {
        if (!this.previousSmartPlacements || !this.previousSmartGrid) {
            return null;
        }

        const columns = this.previousSmartGrid.columns;
        const rows = this.previousSmartGrid.rows;
        const basePlacements = Array.from(this.previousSmartPlacements.values()).map((placement) => ({ ...placement }));

        if (basePlacements.length !== descriptors.length) {
            return null;
        }

        const candidates = [{ placements: basePlacements, source: "reassign-existing" }];
        candidates.push(
            ...this._buildSmartRepairVariants(
                basePlacements,
                columns,
                rows,
                descriptors.length,
                options.changedIndex
            )
        );

        let best = null;
        let evaluatedLayouts = 0;

        for (const candidate of candidates) {
            const scored = this._scoreCandidateLayout(descriptors, candidate.placements, {
                columns,
                rows,
                previousPlacements: this.previousSmartPlacements,
                previousGrid: this.previousSmartGrid,
            });
            if (!scored) continue;

            scored.repairSource = candidate.source;
            evaluatedLayouts += 1;

            if (this._isBetterSmartLayoutCandidate(scored, best)) {
                best = scored;
            }
        }

        return {
            best,
            evaluatedLayouts,
        };
    }

    _buildSmartRepairVariants(placements, columns, rows, slotCount, changedIndex = null) {
        const allowedShapes = this._getAllowedTileShapes(columns, rows, slotCount).filter((shape) => shape.area <= 9);
        const focusPlacements = Number.isInteger(changedIndex)
            ? placements.filter((placement) => placement.index === changedIndex)
            : placements;
        const variants = [];
        const seen = new Set();

        for (const anchor of focusPlacements) {
            const neighbors = this._findAdjacentPlacements(anchor, placements);

            for (const neighbor of neighbors) {
                const unionRect = this._rectUnionIfRectangular(anchor, neighbor);
                if (!unionRect || unionRect.w * unionRect.h > 12) {
                    continue;
                }

                const originalSignature = this._placementSetSignature([
                    { x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h },
                    { x: neighbor.x, y: neighbor.y, w: neighbor.w, h: neighbor.h },
                ]);
                const localTilings = this._generateLocalRectTilings(unionRect, allowedShapes, 2, 6);

                for (const localPlacements of localTilings) {
                    if (this._placementSetSignature(localPlacements) === originalSignature) {
                        continue;
                    }

                    const nextPlacements = placements
                        .filter((placement) => placement !== anchor && placement !== neighbor)
                        .map((placement) => ({ ...placement }));
                    nextPlacements.push(...localPlacements.map((placement) => ({ ...placement })));

                    const signature = this._placementSetSignature(nextPlacements);
                    if (seen.has(signature)) {
                        continue;
                    }

                    seen.add(signature);
                    variants.push({ placements: nextPlacements, source: "repair-neighbor-edit" });

                    if (variants.length >= 10) {
                        return variants;
                    }
                }
            }
        }

        return variants;
    }

    _findAdjacentPlacements(targetPlacement, placements) {
        return placements.filter((placement) => {
            if (placement === targetPlacement) {
                return false;
            }

            const sharesVerticalEdge =
                targetPlacement.x + targetPlacement.w === placement.x ||
                placement.x + placement.w === targetPlacement.x;
            const overlapsVertically =
                targetPlacement.y < placement.y + placement.h && placement.y < targetPlacement.y + targetPlacement.h;
            const sharesHorizontalEdge =
                targetPlacement.y + targetPlacement.h === placement.y ||
                placement.y + placement.h === targetPlacement.y;
            const overlapsHorizontally =
                targetPlacement.x < placement.x + placement.w && placement.x < targetPlacement.x + targetPlacement.w;

            return (sharesVerticalEdge && overlapsVertically) || (sharesHorizontalEdge && overlapsHorizontally);
        });
    }

    _rectUnionIfRectangular(firstRect, secondRect) {
        const x = Math.min(firstRect.x, secondRect.x);
        const y = Math.min(firstRect.y, secondRect.y);
        const right = Math.max(firstRect.x + firstRect.w, secondRect.x + secondRect.w);
        const bottom = Math.max(firstRect.y + firstRect.h, secondRect.y + secondRect.h);
        const unionRect = {
            x,
            y,
            w: right - x,
            h: bottom - y,
        };

        const unionArea = unionRect.w * unionRect.h;
        const occupiedArea = firstRect.w * firstRect.h + secondRect.w * secondRect.h;

        return unionArea === occupiedArea ? unionRect : null;
    }

    _generateLocalRectTilings(rect, shapes, tileCount, limit = 6) {
        const results = [];
        const signatures = new Set();
        const totalArea = rect.w * rect.h;
        const maxShapeArea = Math.max(...shapes.map((shape) => shape.area));

        const search = (occupied, placements, usedArea) => {
            if (results.length >= limit) {
                return;
            }

            const remainingTiles = tileCount - placements.length;
            const remainingArea = totalArea - usedArea;

            if (remainingTiles === 0) {
                if (remainingArea === 0) {
                    const signature = this._placementSetSignature(placements);
                    if (!signatures.has(signature)) {
                        signatures.add(signature);
                        results.push(placements.map((placement) => ({ ...placement })));
                    }
                }
                return;
            }

            if (remainingTiles < 0 || remainingArea < 0) {
                return;
            }

            const minTilesNeeded = Math.ceil(remainingArea / maxShapeArea);
            if (remainingTiles < minTilesNeeded || remainingTiles > remainingArea) {
                return;
            }

            const anchor = occupied.indexOf(0);
            if (anchor < 0) {
                return;
            }

            const anchorX = anchor % rect.w;
            const anchorY = Math.floor(anchor / rect.w);

            for (const shape of shapes) {
                if (!this._canPlaceTileAt(occupied, rect.w, rect.h, anchorX, anchorY, shape)) {
                    continue;
                }

                const nextOccupied = this._occupyTile(occupied, rect.w, anchorX, anchorY, shape);
                search(
                    nextOccupied,
                    [
                        ...placements,
                        {
                            x: rect.x + anchorX,
                            y: rect.y + anchorY,
                            w: shape.w,
                            h: shape.h,
                        },
                    ],
                    usedArea + shape.area
                );
            }
        };

        search(new Uint8Array(totalArea), [], 0);
        return results;
    }

    _placementSetSignature(placements) {
        return placements
            .map((placement) => `${placement.x}:${placement.y}:${placement.w}:${placement.h}`)
            .sort()
            .join("|");
    }

    _generateCandidateTilings(columns, rows, slotCount, descriptors = [], gridRank = 0) {
        if (slotCount <= 0 || columns <= 0 || rows <= 0) {
            return { tilings: [], nodes: 0 };
        }

        const shapes = this._getAllowedTileShapes(columns, rows, slotCount);
        const totalArea = columns * rows;
        const baseCandidateLimit = slotCount <= 6 ? 132 : slotCount <= 12 ? 96 : slotCount <= 20 ? 64 : 40;
        const baseNodeLimit = slotCount <= 6 ? 2600 : slotCount <= 12 ? 2000 : slotCount <= 20 ? 1400 : 900;

        if (shapes.length === 0 || totalArea < slotCount) {
            return { tilings: [], nodes: 0 };
        }

        const results = [];
        const context = {
            columns,
            rows,
            slotCount,
            totalArea,
            limit: Math.max(24, baseCandidateLimit - gridRank * 16),
            maxNodes: Math.max(420, baseNodeLimit - gridRank * 220),
            maxShapeArea: Math.max(...shapes.map((shape) => shape.area)),
            targetProfile: this._getVisibleAspectBuckets(descriptors),
            targetHistogram: this._getVisibleAspectHistogram(descriptors),
            bucketAvailability: this._bucketAvailabilityForShapes(shapes, columns, rows),
            shapes,
            aspectCache: new Map(),
            signatures: new Set(),
            nodes: 0,
        };

        this._searchTilings(
            {
                occupied: new Uint8Array(totalArea),
                placements: [],
                usedArea: 0,
            },
            results,
            context
        );

        return {
            tilings: results,
            nodes: context.nodes,
        };
    }

    _searchTilings(state, results, context) {
        if (results.length >= context.limit || context.nodes >= context.maxNodes) {
            return;
        }

        context.nodes += 1;

        const remainingTiles = context.slotCount - state.placements.length;
        const remainingArea = context.totalArea - state.usedArea;

        if (remainingTiles === 0) {
            if (remainingArea !== 0) {
                return;
            }

            const signature = state.placements
                .map((placement) => `${placement.x}:${placement.y}:${placement.w}:${placement.h}`)
                .join("|");
            if (!context.signatures.has(signature)) {
                context.signatures.add(signature);
                results.push(state.placements);
            }
            return;
        }

        const minTilesNeeded = Math.ceil(remainingArea / context.maxShapeArea);
        if (remainingTiles < minTilesNeeded || remainingTiles > remainingArea) {
            return;
        }

        const anchor = state.occupied.indexOf(0);
        if (anchor < 0) {
            return;
        }

        const anchorX = anchor % context.columns;
        const anchorY = Math.floor(anchor / context.columns);
        const averageArea = remainingArea / Math.max(remainingTiles, 1);
        const branches = [];

        for (const shape of context.shapes) {
            if (!this._canPlaceTileAt(state.occupied, context.columns, context.rows, anchorX, anchorY, shape)) {
                continue;
            }

            const placement = {
                x: anchorX + 1,
                y: anchorY + 1,
                w: shape.w,
                h: shape.h,
            };
            const occupied = this._occupyTile(state.occupied, context.columns, anchorX, anchorY, shape);
            const nextPlacements = [...state.placements, placement];
            const branchPenalty = this._scoreTilingSearchBranch(
                nextPlacements,
                occupied,
                remainingTiles - 1,
                remainingArea - shape.area,
                context,
                placement,
                averageArea
            );

            if (!Number.isFinite(branchPenalty)) {
                continue;
            }

            branches.push({
                occupied,
                placements: nextPlacements,
                usedArea: state.usedArea + shape.area,
                penalty: branchPenalty,
            });
        }

        branches.sort((left, right) => left.penalty - right.penalty);

        for (const branch of branches) {
            this._searchTilings(branch, results, context);
            if (results.length >= context.limit || context.nodes >= context.maxNodes) {
                break;
            }
        }
    }

    _getVisibleAspectBuckets(descriptors) {
        const keys = this._aspectBucketKeys();
        const counts = Object.fromEntries(keys.map((key) => [key, 0]));

        for (const descriptor of descriptors) {
            counts[this._classifyPlacementAspect(descriptor.aspect)] += 1;
        }

        const total = Math.max(descriptors.length, 1);
        const proportions = Object.fromEntries(keys.map((key) => [key, counts[key] / total]));

        return {
            keys,
            counts,
            proportions,
            total: descriptors.length,
        };
    }

    _getVisibleAspectHistogram(descriptors) {
        return this._buildAspectHistogram(descriptors.map((descriptor) => descriptor.aspect));
    }

    _aspectBucketKeys() {
        return ["tall-portrait", "portrait", "square", "landscape", "wide"];
    }

    _classifyPlacementAspect(aspect) {
        if (aspect < 0.68) return "tall-portrait";
        if (aspect < 0.9) return "portrait";
        if (aspect < 1.18) return "square";
        if (aspect < 1.85) return "landscape";
        return "wide";
    }

    _tileInventoryProfile(placements, columns, rows, aspectCache = null) {
        const keys = this._aspectBucketKeys();
        const counts = Object.fromEntries(keys.map((key) => [key, 0]));

        for (const placement of placements) {
            const bucket = this._classifyPlacementAspect(this._cachedRectAspect(placement, aspectCache, columns, rows));
            counts[bucket] += 1;
        }

        const total = Math.max(placements.length, 1);
        const proportions = Object.fromEntries(keys.map((key) => [key, counts[key] / total]));

        return {
            keys,
            counts,
            proportions,
            total: placements.length,
        };
    }

    _getPlacementAspectHistogram(placements, columns, rows, aspectCache = null) {
        return this._buildAspectHistogram(
            placements.map((placement) => this._cachedRectAspect(placement, aspectCache, columns, rows))
        );
    }

    _buildAspectHistogram(aspects) {
        const edges = [-1.35, -0.8, -0.42, -0.12, 0.12, 0.42, 0.8, 1.35];
        const counts = new Array(edges.length + 1).fill(0);

        for (const aspect of aspects) {
            const value = Math.log(Math.max(aspect, 0.1));
            let bucket = edges.length;

            for (let index = 0; index < edges.length; index++) {
                if (value < edges[index]) {
                    bucket = index;
                    break;
                }
            }

            counts[bucket] += 1;
        }

        const total = Math.max(aspects.length, 1);
        return {
            counts,
            proportions: counts.map((count) => count / total),
            total: aspects.length,
        };
    }

    _histogramDistance(left, right) {
        let distance = 0;

        for (let index = 0; index < left.proportions.length; index++) {
            const delta = Math.abs(left.proportions[index] - right.proportions[index]);
            const isOuterBucket = index === 0 || index === left.proportions.length - 1;
            distance += delta * (isOuterBucket ? 1.35 : 1);
        }

        return distance;
    }

    _bucketAvailabilityForShapes(shapes, columns, rows) {
        const availability = Object.fromEntries(this._aspectBucketKeys().map((key) => [key, false]));
        const aspectCache = new Map();

        for (const shape of shapes) {
            const bucket = this._classifyPlacementAspect(
                this._cachedRectAspect({ x: 1, y: 1, w: shape.w, h: shape.h }, aspectCache, columns, rows)
            );
            availability[bucket] = true;
        }

        return availability;
    }

    _scoreTilingSearchBranch(placements, occupied, remainingTiles, remainingArea, context, placement, averageArea) {
        if (remainingTiles < 0 || remainingArea < 0 || remainingTiles > remainingArea) {
            return Number.POSITIVE_INFINITY;
        }

        const regionSizes = this._emptyRegionSizes(occupied, context.columns, context.rows);
        const minTilesByRegion = regionSizes.reduce(
            (sum, regionSize) => sum + Math.ceil(regionSize / context.maxShapeArea),
            0
        );

        if (remainingTiles < regionSizes.length || remainingTiles < minTilesByRegion) {
            return Number.POSITIVE_INFINITY;
        }

        const inventoryProfile = this._tileInventoryProfile(
            placements,
            context.columns,
            context.rows,
            context.aspectCache
        );
        const histogramProfile = this._getPlacementAspectHistogram(
            placements,
            context.columns,
            context.rows,
            context.aspectCache
        );
        const distributionPenalty = this._inventoryDistributionPenalty(inventoryProfile, context.targetProfile);
        const histogramPenalty = this._histogramDistance(histogramProfile, context.targetHistogram);
        const feasibilityPenalty = this._inventoryFeasibilityPenalty(
            inventoryProfile,
            context.targetProfile,
            remainingTiles,
            context.bucketAvailability
        );
        const fragmentationPenalty = regionSizes.reduce((sum, regionSize) => {
            if (regionSize === 1) return sum + 0.28;
            if (regionSize === 2) return sum + 0.1;
            if (regionSize < context.maxShapeArea) return sum + 0.03;
            return sum;
        }, 0);
        const slenderPenalty = this._placementSlenderPenalty(
            placement,
            context.aspectCache,
            context.columns,
            context.rows
        );
        const areaPenalty = Math.abs(placement.w * placement.h - averageArea) * 0.06;

        return (
            histogramPenalty * 0.34 +
            distributionPenalty * 0.12 +
            feasibilityPenalty * 0.34 +
            fragmentationPenalty * 0.18 +
            slenderPenalty * 0.18 +
            areaPenalty
        );
    }

    _inventoryDistributionPenalty(inventoryProfile, targetProfile) {
        let penalty = 0;

        for (const key of targetProfile.keys) {
            const actual = inventoryProfile.counts[key];
            const expected = targetProfile.proportions[key] * inventoryProfile.total;
            const delta = actual - expected;
            const isExtreme = key === "tall-portrait" || key === "wide";

            penalty += Math.abs(delta) * (isExtreme ? 0.28 : 0.16);
            penalty += Math.max(0, delta - 0.35) * (isExtreme ? 1.1 : 0.7);
        }

        return penalty;
    }

    _inventoryFeasibilityPenalty(inventoryProfile, targetProfile, remainingTiles, bucketAvailability) {
        let penalty = 0;

        for (const key of targetProfile.keys) {
            const desired = targetProfile.counts[key];
            const current = inventoryProfile.counts[key];
            const futureCapacity = bucketAvailability[key] ? remainingTiles : 0;
            const shortfall = Math.max(0, desired - (current + futureCapacity));
            const isExtreme = key === "tall-portrait" || key === "wide";

            penalty += shortfall * (isExtreme ? 1.4 : 0.9);
        }

        return penalty;
    }

    _emptyRegionSizes(occupied, columns, rows) {
        const visited = new Uint8Array(occupied.length);
        const regionSizes = [];

        for (let index = 0; index < occupied.length; index++) {
            if (occupied[index] || visited[index]) {
                continue;
            }

            let size = 0;
            const stack = [index];
            visited[index] = 1;

            while (stack.length > 0) {
                const current = stack.pop();
                size += 1;

                const x = current % columns;
                const y = Math.floor(current / columns);
                const neighbors = [];

                if (x > 0) neighbors.push(current - 1);
                if (x + 1 < columns) neighbors.push(current + 1);
                if (y > 0) neighbors.push(current - columns);
                if (y + 1 < rows) neighbors.push(current + columns);

                for (const neighbor of neighbors) {
                    if (!occupied[neighbor] && !visited[neighbor]) {
                        visited[neighbor] = 1;
                        stack.push(neighbor);
                    }
                }
            }

            regionSizes.push(size);
        }

        return regionSizes;
    }

    _getAllowedTileShapes(columns, rows, slotCount) {
        const shapes = [
            { w: 2, h: 2, area: 4 },
            { w: 2, h: 1, area: 2 },
            { w: 1, h: 2, area: 2 },
            { w: 1, h: 1, area: 1 },
        ];

        if (columns >= 3 && slotCount >= 7 && columns * rows >= 15) {
            shapes.unshift({ w: 3, h: 1, area: 3 });
        }

        if (rows >= 3 && slotCount >= 7 && columns * rows >= 15) {
            shapes.unshift({ w: 1, h: 3, area: 3 });
        }

        if (columns >= 3 && rows >= 3 && slotCount >= 8 && columns * rows >= 18) {
            shapes.unshift({ w: 3, h: 2, area: 6 }, { w: 2, h: 3, area: 6 });
        }

        if (columns >= 4 && rows >= 2 && slotCount >= 10 && columns * rows >= 24) {
            shapes.unshift({ w: 4, h: 2, area: 8 });
        }

        if (columns >= 2 && rows >= 4 && slotCount >= 10 && columns * rows >= 24) {
            shapes.unshift({ w: 2, h: 4, area: 8 });
        }

        if (columns >= 3 && rows >= 3 && slotCount <= 10 && columns * rows >= 18) {
            shapes.unshift({ w: 3, h: 3, area: 9 });
        }

        return shapes.filter((shape, index, allShapes) => {
            if (shape.w > columns || shape.h > rows) {
                return false;
            }

            return allShapes.findIndex((candidate) => candidate.w === shape.w && candidate.h === shape.h) === index;
        });
    }

    _buildPackedLayout(descriptors) {
        const ordered = [...descriptors].sort((a, b) => a.aspect - b.aspect || a.index - b.index);

        return this._partitionRect({ x: 1, y: 1, w: this.masonryColumns, h: this.masonryRows }, ordered);
    }

    _matchPlacementsToDescriptors(descriptors, placements) {
        const assignment = this._assignDescriptorsToPlacements(descriptors, placements);
        return assignment ? assignment.placements : [];
    }

    _scoreCandidateLayout(descriptors, placements, options = {}) {
        const {
            columns = this.masonryColumns,
            rows = this.masonryRows,
            previousPlacements = null,
            previousGrid = null,
        } = options;
        const aspectCache = new Map();
        const assignment = this._assignDescriptorsToPlacements(descriptors, placements, aspectCache, columns, rows);

        if (!assignment) {
            return null;
        }

        const slenderPenalty = placements.reduce(
            (sum, placement) => sum + this._placementSlenderPenalty(placement, aspectCache, columns, rows),
            0
        );
        const areaVariancePenalty = this._areaVariancePenalty(placements);
        const severeCropPenalty = this._severeCropPenalty(assignment.costs);
        const hardCropPenalty = this._hardCropThresholdPenalty(assignment.visibleFractions);
        const cropScore =
            assignment.totalCrop +
            assignment.worstCrop * 1.9 +
            severeCropPenalty * 0.75 +
            hardCropPenalty.penalty;
        let stabilityPenalty = 0;

        if (this.settings.redrawOnRefresh && previousPlacements && previousGrid) {
            stabilityPenalty = this._smartLayoutStabilityPenalty(
                assignment.placements,
                previousPlacements,
                { columns, rows },
                previousGrid
            );

            if (Number.isFinite(this.previousSmartScore) && cropScore + 0.35 < this.previousSmartScore) {
                stabilityPenalty *= 0.35;
            }
        }

        const score = cropScore + slenderPenalty * 0.32 + areaVariancePenalty * 0.08 + stabilityPenalty * 0.2;

        return {
            ...assignment,
            score,
            cropScore,
            slenderPenalty,
            areaVariancePenalty,
            severeCropPenalty,
            severeCropCount: hardCropPenalty.severeCount,
            rejectedCropCount: hardCropPenalty.rejectedCount,
            hardReject: hardCropPenalty.hardReject,
            worstVisibleFraction: hardCropPenalty.worstVisibleFraction,
            stabilityPenalty,
            columns,
            rows,
        };
    }

    _assignDescriptorsToPlacements(
        descriptors,
        placements,
        aspectCache = new Map(),
        columns = this.masonryColumns,
        rows = this.masonryRows
    ) {
        if (descriptors.length === 0 || descriptors.length !== placements.length) {
            return null;
        }

        const costMatrix = this._buildAssignmentCostMatrix(descriptors, placements, aspectCache, columns, rows);
        const placementByDescriptor = this._solveMinimumCostAssignment(costMatrix);
        let totalCrop = 0;
        let worstCrop = 0;
        const costs = [];
        const visibleFractions = [];

        const resolvedPlacements = descriptors.map((descriptor, descriptorIndex) => {
            const placementIndex = placementByDescriptor[descriptorIndex];
            const placement = placements[placementIndex];
            const cost = costMatrix[descriptorIndex][placementIndex];
            const placementAspect = this._cachedRectAspect(placement, aspectCache, columns, rows);
            const visibleFraction = this._visibleFractionForAspectPair(placementAspect, descriptor.aspect);

            totalCrop += cost;
            worstCrop = Math.max(worstCrop, cost);
            costs.push(cost);
            visibleFractions.push(visibleFraction);

            return {
                x: placement.x,
                y: placement.y,
                w: placement.w,
                h: placement.h,
                index: descriptor.index,
            };
        });

        return {
            placements: resolvedPlacements,
            totalCrop,
            worstCrop,
            costs,
            visibleFractions,
        };
    }

    _buildAssignmentCostMatrix(
        descriptors,
        placements,
        aspectCache = new Map(),
        columns = this.masonryColumns,
        rows = this.masonryRows
    ) {
        const placementAspects = placements.map((placement) =>
            this._cachedRectAspect(placement, aspectCache, columns, rows)
        );

        return descriptors.map((descriptor) =>
            placementAspects.map((placementAspect) => this._coverCropPenalty(placementAspect, descriptor.aspect))
        );
    }

    _solveMinimumCostAssignment(costMatrix) {
        const size = costMatrix.length;
        const potentialsByRow = new Array(size + 1).fill(0);
        const potentialsByColumn = new Array(size + 1).fill(0);
        const matchedRowsByColumn = new Array(size + 1).fill(0);
        const previousColumn = new Array(size + 1).fill(0);

        for (let row = 1; row <= size; row++) {
            matchedRowsByColumn[0] = row;
            let column = 0;
            const minReducedCosts = new Array(size + 1).fill(Number.POSITIVE_INFINITY);
            const usedColumns = new Array(size + 1).fill(false);

            do {
                usedColumns[column] = true;
                const matchedRow = matchedRowsByColumn[column];
                let delta = Number.POSITIVE_INFINITY;
                let nextColumn = 0;

                for (let candidateColumn = 1; candidateColumn <= size; candidateColumn++) {
                    if (usedColumns[candidateColumn]) continue;

                    const reducedCost =
                        costMatrix[matchedRow - 1][candidateColumn - 1] -
                        potentialsByRow[matchedRow] -
                        potentialsByColumn[candidateColumn];

                    if (reducedCost < minReducedCosts[candidateColumn]) {
                        minReducedCosts[candidateColumn] = reducedCost;
                        previousColumn[candidateColumn] = column;
                    }

                    if (minReducedCosts[candidateColumn] < delta) {
                        delta = minReducedCosts[candidateColumn];
                        nextColumn = candidateColumn;
                    }
                }

                for (let candidateColumn = 0; candidateColumn <= size; candidateColumn++) {
                    if (usedColumns[candidateColumn]) {
                        potentialsByRow[matchedRowsByColumn[candidateColumn]] += delta;
                        potentialsByColumn[candidateColumn] -= delta;
                    } else {
                        minReducedCosts[candidateColumn] -= delta;
                    }
                }

                column = nextColumn;
            } while (matchedRowsByColumn[column] !== 0);

            do {
                const nextColumn = previousColumn[column];
                matchedRowsByColumn[column] = matchedRowsByColumn[nextColumn];
                column = nextColumn;
            } while (column !== 0);
        }

        const placementByDescriptor = new Array(size).fill(-1);
        for (let column = 1; column <= size; column++) {
            const row = matchedRowsByColumn[column];
            if (row > 0) {
                placementByDescriptor[row - 1] = column - 1;
            }
        }

        return placementByDescriptor;
    }

    _placementSlenderPenalty(placement, aspectCache = null, columns = this.masonryColumns, rows = this.masonryRows) {
        const aspect = this._cachedRectAspect(placement, aspectCache, columns, rows);
        const inverse = 1 / Math.max(aspect, 0.001);
        return Math.max(0, aspect - 2.4) * 0.9 + Math.max(0, inverse - 2.4) * 0.9;
    }

    _areaVariancePenalty(placements) {
        if (placements.length <= 1) {
            return 0;
        }

        const areas = placements.map((placement) => placement.w * placement.h);
        const meanArea = areas.reduce((sum, area) => sum + area, 0) / areas.length;
        const variance =
            areas.reduce((sum, area) => {
                const delta = area - meanArea;
                return sum + delta * delta;
            }, 0) / areas.length;

        return Math.sqrt(variance) / Math.max(meanArea, 1);
    }

    _cachedRectAspect(rect, aspectCache = null, columns = this.masonryColumns, rows = this.masonryRows) {
        if (!aspectCache) {
            return this._rectAspect(rect, columns, rows);
        }

        const key = `${columns}:${rows}:${rect.x}:${rect.y}:${rect.w}:${rect.h}`;
        if (!aspectCache.has(key)) {
            aspectCache.set(key, this._rectAspect(rect, columns, rows));
        }

        return aspectCache.get(key);
    }

    _severeCropPenalty(costs) {
        return costs.reduce((sum, cost) => {
            const excess = Math.max(0, cost - 0.9);
            return sum + excess + excess * excess * 0.8;
        }, 0);
    }

    _visibleFractionForAspectPair(rectAspect, mediaAspect) {
        const safeRectAspect = Math.max(rectAspect, 0.1);
        const safeMediaAspect = Math.max(mediaAspect, 0.1);
        return Math.min(safeRectAspect / safeMediaAspect, safeMediaAspect / safeRectAspect, 1);
    }

    _hardCropThresholdPenalty(visibleFractions) {
        let penalty = 0;
        let severeCount = 0;
        let rejectedCount = 0;
        let worstVisibleFraction = 1;

        for (const visibleFraction of visibleFractions) {
            worstVisibleFraction = Math.min(worstVisibleFraction, visibleFraction);

            if (visibleFraction < 0.7) {
                severeCount += 1;
                const gap = 0.7 - visibleFraction;
                penalty += 8 + gap * 18 + gap * gap * 40;
            }

            if (visibleFraction < 0.6) {
                rejectedCount += 1;
                const gap = 0.6 - visibleFraction;
                penalty += 24 + gap * 48 + gap * gap * 120;
            }
        }

        return {
            penalty,
            severeCount,
            rejectedCount,
            hardReject: rejectedCount > 0,
            worstVisibleFraction,
        };
    }

    _isBetterSmartLayoutCandidate(candidate, currentBest) {
        if (!currentBest) {
            return true;
        }

        if (candidate.hardReject !== currentBest.hardReject) {
            return !candidate.hardReject;
        }

        if (candidate.rejectedCropCount !== currentBest.rejectedCropCount) {
            return candidate.rejectedCropCount < currentBest.rejectedCropCount;
        }

        if (candidate.severeCropCount !== currentBest.severeCropCount) {
            return candidate.severeCropCount < currentBest.severeCropCount;
        }

        if (Math.abs(candidate.worstVisibleFraction - currentBest.worstVisibleFraction) > 0.0001) {
            return candidate.worstVisibleFraction > currentBest.worstVisibleFraction;
        }

        return candidate.score < currentBest.score;
    }

    _isAcceptableSmartRepair(candidate) {
        if (!candidate) {
            return false;
        }

        if (candidate.hardReject) {
            return false;
        }

        if (candidate.severeCropCount === 0) {
            return true;
        }

        return candidate.worstVisibleFraction >= 0.64 && candidate.cropScore <= (this.previousSmartScore || Infinity) + 0.65;
    }

    _finalizeSmartLayout(best, diagnostics, startedAt, source) {
        const runtimeMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;

        this._recordSmartLayoutDiagnostics({
            ...diagnostics,
            source,
            chosenGrid: { columns: best.columns, rows: best.rows },
            winningScore: best.score,
            cropScore: best.cropScore,
            worstCrop: best.worstCrop,
            severeCropCount: best.severeCropCount,
            rejectedCropCount: best.rejectedCropCount,
            worstVisibleFraction: best.worstVisibleFraction,
            severeCropPenalty: best.severeCropPenalty,
            stabilityPenalty: best.stabilityPenalty,
            runtimeMs,
        });

        return {
            placements: best.placements,
            columns: best.columns,
            rows: best.rows,
            score: best.score,
            cropScore: best.cropScore,
        };
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

    _smartLayoutStabilityPenalty(placements, previousPlacements, grid, previousGrid) {
        let total = 0;
        let matched = 0;

        for (const placement of placements) {
            const previous = previousPlacements.get(placement.index);
            if (!previous) {
                continue;
            }

            const positionShift =
                (Math.abs(placement.x - previous.x) + Math.abs(placement.y - previous.y)) /
                Math.max(grid.columns + grid.rows, 1);
            const spanShift = (Math.abs(placement.w - previous.w) + Math.abs(placement.h - previous.h)) / 3;
            const currentAspect = this._rectAspect(placement, grid.columns, grid.rows);
            const previousAspect = this._rectAspect(previous, previousGrid.columns, previousGrid.rows);
            const aspectShift = Math.abs(Math.log(currentAspect / Math.max(previousAspect, 0.1)));

            total += positionShift * 0.8 + spanShift * 1.1 + aspectShift * 0.75;
            matched += 1;
        }

        return matched > 0 ? total / matched : 0;
    }

    _canPlaceTileAt(occupied, columns, rows, anchorX, anchorY, shape) {
        if (anchorX + shape.w > columns || anchorY + shape.h > rows) {
            return false;
        }

        for (let offsetY = 0; offsetY < shape.h; offsetY++) {
            for (let offsetX = 0; offsetX < shape.w; offsetX++) {
                const index = (anchorY + offsetY) * columns + anchorX + offsetX;
                if (occupied[index]) {
                    return false;
                }
            }
        }

        return true;
    }

    _occupyTile(occupied, columns, anchorX, anchorY, shape) {
        const next = occupied.slice();

        for (let offsetY = 0; offsetY < shape.h; offsetY++) {
            for (let offsetX = 0; offsetX < shape.w; offsetX++) {
                const index = (anchorY + offsetY) * columns + anchorX + offsetX;
                next[index] = 1;
            }
        }

        return next;
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
        const viewportWidth = this.gridEl.clientWidth || window.innerWidth;
        const viewportHeight = this.gridEl.clientHeight || window.innerHeight;
        const cellWidth = (viewportWidth - gap * (columns - 1)) / Math.max(columns, 1);
        const cellHeight = (viewportHeight - gap * (rows - 1)) / Math.max(rows, 1);
        const rectWidth = cellWidth * rect.w + gap * Math.max(rect.w - 1, 0);
        const rectHeight = cellHeight * rect.h + gap * Math.max(rect.h - 1, 0);
        return rectWidth / Math.max(rectHeight, 1);
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
