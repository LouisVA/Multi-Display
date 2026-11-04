async function runPerformanceSuite(folder, repetitions, emptyFolder) {
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async (condition, message) => {
        const deadline = performance.now() + 15000;
        while (!condition()) {
            if (performance.now() > deadline) throw new Error(message);
            await wait(10);
        }
    };
    const files = await window.mediaAPI.getMediaFiles(folder);
    document.getElementById('empty-state').style.display = 'none';
    gridEl.style.display = 'grid';
    const images = files.filter((file) => file.type === 'image');
    const video = files.find((file) => file.type === 'video');
    assert(images.length === 1000 && video, 'The fixture scan must include 1,000 images and one video');
    assert(files.every((file) => Number.isFinite(file.size) && Number.isFinite(file.modified)), 'File identities are required');
    const results = [];
    // Let the initial window resize debounce finish before measuring folder load.
    // There is no active grid during this setup period.
    await new Promise((resolve) => {
        let settledTimer;
        const finish = () => {
            window.removeEventListener('resize', afterResize);
            resolve();
        };
        const afterResize = () => {
            clearTimeout(settledTimer);
            settledTimer = setTimeout(finish, 350);
        };
        window.addEventListener('resize', afterResize);
        afterResize();
    });
    const check = async (name, body) => {
        for (let repetition = 1; repetition <= repetitions; repetition++) {
            grid.stop();
            const started = performance.now();
            let metrics;
            try {
                metrics = await body();
            } catch (error) {
                throw new Error(`${name}, repetition ${repetition}: ${error.message}`);
            }
            results.push({ name, repetition, elapsedMs: +(performance.now() - started).toFixed(2), ...metrics });
        }
    };

    await check('first-grid-large-folder', async () => {
        grid.metadata.cache.clear();
        grid.updateSettings({ gridMode: 'uniform', slotCount: 12, mediaFilter: 'mixed' });
        const started = performance.now();
        await grid.setMedia(images);
        assert(grid.metadata.active === 0 && grid.metadata.jobs.size === 0, 'Opening a folder must not probe all files');
        grid.start();
        const constructedAt = performance.now();
        assert(grid.displayedItems.length === 12, 'The first grid must have 12 tiles');
        await until(() => grid.displayedItems.every((item) => item.mediaEl.naturalWidth > 0), 'Visible images did not load');
        const loadedAt = performance.now();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const firstGridMs = performance.now() - started;
        const timings = {
            constructionMs: +(constructedAt - started).toFixed(2),
            imageLoadMs: +(loadedAt - constructedAt).toFixed(2),
            paintWaitMs: +(performance.now() - loadedAt).toFixed(2),
            visibility: document.visibilityState,
        };
        assert(firstGridMs < 500, `The loaded first grid must be ready within 500 ms: ${JSON.stringify(timings)}`);
        assert(grid.mediaMetrics.size <= 12, `Only visible media should be measured: ${grid.mediaMetrics.size} measured for ${grid.displayedItems.length} tiles`);
        return { firstGridMs: +firstGridMs.toFixed(2), files: images.length, measured: grid.mediaMetrics.size, ...timings };
    });

    await check('bounded-metadata-probes', async () => {
        const service = new MediaMetadata({ storage: null });
        let peak = 0;
        const start = service._start.bind(service);
        service._start = (job) => { start(job); peak = Math.max(peak, service.active); };
        const values = await Promise.all(images.slice(0, 100).map((media) => service.get(media)));
        assert(peak <= 4 && peak > 0, 'At most four metadata probes may run together');
        assert(values.every((value) => value.measured && value.width > 0), 'Every probe must return actual dimensions');
        assert(service.active === 0 && service.jobs.size === 0, 'Finished probes must release their resources');
        service.dispose();
        return { probes: 100, peak };
    });

    await check('smart-worker-responsiveness', async () => {
        grid.updateSettings({ gridMode: 'smart-masonry', slotCount: 24 });
        grid.setMedia(images.slice(0, 36));
        grid.lastSmartLayoutDiagnostics = null;
        let ticks = 0;
        const heartbeat = setInterval(() => { ticks++; }, 5);
        grid.start();
        await until(() => grid.previousSmartPlacements?.size === 24, 'The Smart worker did not return a layout');
        clearInterval(heartbeat);
        assert(grid.layoutWorker.worker && grid.lastSmartLayoutDiagnostics?.source !== 'worker-fallback', 'Smart scoring must run in the actual worker');
        assert(ticks > 0, 'The interface event loop must run during layout work');
        const placements = [...grid.previousSmartPlacements.values()];
        const cells = new Set();
        for (const tile of placements) {
            for (let y = tile.y; y < tile.y + tile.h; y++) {
                for (let x = tile.x; x < tile.x + tile.w; x++) {
                    assert(!cells.has(`${x}:${y}`), 'Smart tiles must not overlap');
                    cells.add(`${x}:${y}`);
                }
            }
        }
        assert(cells.size === grid.masonryColumns * grid.masonryRows, 'Smart tiles must fill the grid');
        return { tiles: placements.length, eventLoopTicks: ticks, workerMs: grid.lastSmartLayoutDiagnostics.runtimeMs };
    });

    await check('obsolete-work-cancellation', async () => {
        const client = new LayoutWorkerClient();
        const context = { viewport: { width: 1280, height: 800 }, settings: { gap: 2, gridMode: 'smart-masonry' } };
        const obsolete = client.calculate(context, Array.from({ length: 48 }, (_, index) => ({ index, aspect: 0.5 + index % 5 })), { reason: 'build' });
        client.cancel();
        assert(await obsolete === null && !client.pending, 'Obsolete worker requests must settle');
        client.dispose();
        const originalWorker = globalThis.Worker;
        globalThis.Worker = class { constructor() { throw new Error('Worker unavailable'); } };
        try {
            let rejected = false;
            try { await client.calculate(context, [], {}); } catch { rejected = true; }
            assert(rejected && !client.pending, 'Worker startup failures must settle the request');
        } finally {
            globalThis.Worker = originalWorker;
        }
        grid.setMedia(images.slice(0, 24));
        grid.updateSettings({ gridMode: 'smart-masonry', slotCount: 24 });
        grid.start();
        grid.updateSettings({ gridMode: 'uniform', slotCount: 4 });
        await wait(100);
        assert(grid.displayedItems.length === 4 && !grid.previousSmartPlacements, 'Old Smart results must not alter a new grid');
        assert(!grid.layoutWorker.pending, 'No obsolete layout request may remain');
        return { tiles: grid.displayedItems.length };
    });

    await check('video-resource-release', async () => {
        const created = [];
        const create = document.createElement.bind(document);
        document.createElement = (name, ...args) => {
            const element = create(name, ...args);
            if (name === 'video') created.push(element);
            return element;
        };
        try {
            const service = new MediaMetadata({ storage: null });
            const metadata = await service.get(video);
            assert(metadata.measured && metadata.width === 48 && metadata.height === 32, 'The real video decoder must return 48 by 32');
            service.dispose();
            grid.updateSettings({ gridMode: 'uniform', slotCount: 2 });
            grid.setMedia([video]);
            grid.start();
            await until(() => grid.displayedItems.every((item) => item.mediaEl.videoWidth > 0), 'Visible video did not load');
            const retired = grid.displayedItems.map((item) => item.mediaEl);
            grid._replaceItem(grid.displayedItems[0]);
            await wait(650);
            assert(!retired[0].hasAttribute('src') && retired[0].paused, 'A rotated video must release its source');
            grid.stop();
            assert(created.every((element) => !element.hasAttribute('src') && element.paused), 'Every removed video and probe must release its source');
            return { releasedVideos: created.length };
        } finally {
            document.createElement = create;
        }
    });

    await check('cache-invalidation-and-failures', async () => {
        let saved = null;
        const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
        let service = new MediaMetadata({ storage, maxEntries: 2, timeoutMs: 100 });
        await service.get(images[0]);
        service.dispose();
        service = new MediaMetadata({ storage, maxEntries: 2, timeoutMs: 100 });
        let starts = 0;
        const start = service._start.bind(service);
        service._start = (job) => { starts++; start(job); };
        const warm = await service.get(images[0]);
        assert(warm.measured && starts === 0, 'A new session must reuse persisted dimensions');
        await service.get({ ...images[0], modified: images[0].modified + 1 });
        assert(starts === 1, 'A changed file must invalidate cached dimensions');
        await service.get(images[1]);
        assert(service.cache.size === 2, 'The cache must stay within its entry limit');
        const broken = { ...images[2], path: images[2].path + '.missing', url: images[2].url + '.missing' };
        const failed = await service.get(broken);
        assert(!failed.measured, 'Unreadable files must return fallback dimensions');
        assert(!service.cache.has(service._identity(broken).key), 'Failures must not be persisted');
        // A disconnected probe must settle on cancel, even if the browser sends no event.
        const originalImage = globalThis.Image;
        globalThis.Image = class { removeAttribute() {} };
        try {
            const canceled = service.get(broken);
            service.cancel();
            assert(!(await canceled).measured && service.active === 0, 'Canceled probes must settle and release slots');
            const timedOut = await service.get(broken);
            assert(!timedOut.measured && service.active === 0, 'Stalled probes must time out');
        } finally {
            globalThis.Image = originalImage;
            service.dispose();
        }
        return { warmProbes: 0, changedFileProbes: 1, cacheLimit: 2 };
    });

    await check('grid-interactions-and-saved-layouts', async () => {
        const waitFor = (condition, message) => until(condition, message);
        const answerDialog = async (promise, buttonId) => {
            await waitFor(() => !document.getElementById('decision-dialog').hidden, 'The decision dialog did not open');
            document.getElementById(buttonId).click();
            return promise;
        };
        const setGap = (value) => {
            const slider = document.getElementById('gap-slider');
            slider.value = String(value);
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const clickPresetSave = async (title) => {
            document.getElementById('preset-name').value = title;
            const previous = persistenceController.presets.length;
            document.getElementById('save-new-preset').click();
            await waitFor(() => persistenceController.presets.length === previous + 1, `Preset ${title} was not saved`);
            const preset = persistenceController.presets.find((item) => item.title === title);
            assert(preset && Number.isFinite(Date.parse(preset.createdAt)), 'A named preset must have a saved timestamp');
            return preset;
        };
        const fileKey = (media) => media?.path || media?.url;
        const allFiles = files;
        const controller = persistenceController;
        controller.folderPath = folder;
        controller.files = allFiles;
        controller.selectedPresetId = null;
        controller.dirty = false;
        openSettings();
        assert(document.getElementById('settings-toggle').hidden, 'The gear must not overlap the Settings close button');
        for (let tab = 0; tab < 3; tab++) {
            document.getElementById(`settings-tab-${tab}`).click();
            assert([...document.querySelectorAll('.settings-page')].filter(page => !page.hidden).length === 1, 'Only the selected Settings group must be shown');
            assert(!document.getElementById(`settings-page-${tab}`).hidden, 'The selected Settings tab must reveal its controls');
        }
        grid.stop();
        grid.updateSettings({ gridMode: 'uniform', slotCount: 8, imageTime: 120, videoBehavior: 'rotate', mediaFilter: 'mixed', gap: 2 });
        await grid.setMedia(allFiles);
        // Put the video in the first cell so lock, filter, and loop checks are repeatable.
        grid.pool = [video];
        grid.start();
        assert(grid.displayedItems.length === 8, 'The interaction grid must contain eight cells');
        assert(new Set(grid.displayedItems.map((item) => fileKey(item.media))).size === 8, 'Visible media must be unique when enough eligible files exist');

        const videoItem = grid.displayedItems[0];
        videoItem.cell.click();
        assert(videoItem.locked && videoItem.timer === null && videoItem.mediaEl.loop, 'Clicking a video must lock it and keep it looping');
        grid.reshufflePool();
        assert(!grid.pool.some((media) => fileKey(media) === fileKey(video)), 'A pinned file must not return to the replacement pool');

        const pinnedImage = grid.displayedItems[1];
        const pinnedImageKey = fileKey(pinnedImage.media);
        grid.updateSettings({ imageTime: 3 });
        await waitFor(() => pinnedImage.transitionTimer !== null, 'An image must enter its rotation transition');
        pinnedImage.cell.click();
        await wait(750);
        assert(pinnedImage.locked && fileKey(pinnedImage.media) === pinnedImageKey && pinnedImage.timer === null, 'A locked image must retain its file and cancel rotation');
        assert(Number(getComputedStyle(pinnedImage.mediaEl).opacity) > 0.99, 'Locking an image during rotation must leave it visible');
        for (const fitMode of ['crop', 'fit']) {
            grid.updateSettings({ fitMode });
            const badge = getComputedStyle(pinnedImage.cell, '::before');
            assert(badge.content.includes('🔒') && Number(badge.zIndex) > 0 && badge.pointerEvents === 'none', 'The lock badge must overlay both Crop and Fit media without blocking clicks');
        }
        grid.updateSettings({ imageTime: 120, fitMode: 'crop' });

        const left = grid.displayedItems[1];
        const right = grid.displayedItems[2];
        const leftMedia = left.media;
        const rightMedia = right.media;
        const transfer = new DataTransfer();
        left.cell.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
        const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
        right.cell.dispatchEvent(drop);
        assert(drop.defaultPrevented && left.media === rightMedia && right.media === leftMedia, 'Dragging a tile onto another must swap their media');
        assert(left.mediaEl.parentElement === left.cell && right.mediaEl.parentElement === right.cell, 'Swapped media elements must stay inside their destination cells');

        document.querySelector('[data-media-filter="image"]').click();
        assert(grid.displayedItems[0].locked && fileKey(grid.displayedItems[0].media) === fileKey(video), 'An image filter must retain a pinned video');
        assert(grid.displayedItems.slice(1).every((item) => item.media?.type === 'image'), 'A media filter must apply to unlocked cells');
        document.querySelector('[data-media-filter="mixed"]').click();

        // Ignore a visible tile while playback is paused, then restore it from the real gallery.
        document.getElementById('pause-btn').click();
        const ignoredItem = grid.displayedItems[3];
        const ignoredKey = fileKey(ignoredItem.media);
        const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        ignoredItem.cell.dispatchEvent(contextMenu);
        assert(contextMenu.defaultPrevented && grid.ignoredMedia.has(ignoredKey), 'Right-click must ignore the selected media');
        await wait(650);
        assert(!grid.displayedItems.some((item) => fileKey(item.media) === ignoredKey), 'Ignoring media must remove its visible copies while paused');
        if (document.getElementById('ignored-gallery').hidden) document.getElementById('restore-ignored').click();
        document.getElementById('restore-ignored').click();
        const restoreButton = document.querySelector('#ignored-gallery button');
        assert(restoreButton, 'The ignored gallery must show a Restore action');
        restoreButton.click();
        assert(!grid.ignoredMedia.has(ignoredKey) && grid.countMediaForFilter() === allFiles.length, 'Restoring media must return it to the eligible set');
        document.getElementById('pause-btn').click();

        // Save a pinned uniform layout, then check its dimensions after a container resize.
        const uniformState = grid.exportState();
        assert(uniformState.geometry.length === 8 && uniformState.grid.columns > 0 && uniformState.grid.rows > 0, 'A saved uniform layout must include its geometry and grid dimensions');
        assert(uniformState.geometry.every((tile) => [tile.x, tile.y, tile.w, tile.h].every(Number.isFinite)), 'Saved geometry must use numeric positions and spans');
        controller.folderPath = folder;
        controller.files = allFiles;
        controller.presets = await window.mediaAPI.listPresets(folder);
        controller.selectedPresetId = null;
        controller.dirty = false;
        document.getElementById('save-new-preset').disabled = false;
        const runId = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
        const uniformPreset = await clickPresetSave(`Issue 5 uniform ${runId}`);
        const originalUniformGrid = { ...uniformState.grid };
        const originalWidth = gridEl.style.width;
        gridEl.style.width = `${Math.max(320, gridEl.clientWidth - 120)}px`;
        window.dispatchEvent(new Event('resize'));
        await wait(300);
        assert(grid.frozenGrid.columns === originalUniformGrid.columns && grid.frozenGrid.rows === originalUniformGrid.rows, 'A viewport resize must preserve saved uniform grid dimensions');
        gridEl.style.width = originalWidth;
        window.dispatchEvent(new Event('resize'));

        // All three leave choices must work. Save opens a second choice when a preset is selected.
        setGap(5);
        const cancelLeave = controller.confirmLeave('leave');
        assert(await answerDialog(cancelLeave, 'decision-cancel') === false, 'Cancel must keep the current layout open');
        const discardLeave = controller.confirmLeave('leave');
        assert(await answerDialog(discardLeave, 'decision-discard') === true, 'Discard must allow the requested action');
        setGap(4);
        const saveLeave = controller.confirmLeave('leave');
        await waitFor(() => !document.getElementById('decision-dialog').hidden, 'The Save prompt did not open');
        document.getElementById('decision-save').click();
        await waitFor(() => !document.getElementById('decision-dialog').hidden, 'Save must ask whether to create or overwrite a preset');
        const saveCount = controller.presets.length;
        document.getElementById('decision-save').click();
        assert(await saveLeave === true, 'Save must complete the requested action');
        await waitFor(() => controller.presets.length === saveCount + 1, 'Save from the leave prompt must create a preset');

        // Change to masonry through the real control. Preserve a second named preset and its dimensions.
        document.querySelector('[data-mode="masonry"]').click();
        await answerDialog(new Promise((resolve) => {
            const poll = setInterval(() => {
                if (grid.settings.gridMode === 'masonry') { clearInterval(poll); resolve(true); }
            }, 5);
        }), 'decision-save');
        await waitFor(() => grid.displayedItems.every((item) => item.cell.style.gridColumn && item.cell.style.gridRow), 'Masonry geometry did not finish');
        const masonryState = grid.exportState();
        const masonryPreset = await clickPresetSave(`Issue 5 masonry ${runId}`);
        assert(masonryState.grid.columns > 0 && masonryState.grid.rows > 0, 'A saved masonry preset must include its grid dimensions');
        const beforeOverwrite = (await window.mediaAPI.listPresets(folder)).find((item) => item.id === masonryPreset.id);
        setGap(6);
        document.getElementById('overwrite-preset').click();
        await waitFor(() => !controller.dirty && !document.getElementById('overwrite-preset').disabled, 'Overwrite did not finish');
        const overwritten = (await window.mediaAPI.listPresets(folder)).find((item) => item.id === masonryPreset.id);
        assert(overwritten && overwritten.updatedAt >= beforeOverwrite.updatedAt && overwritten.snapshot.settings.gap === 6, 'Overwrite must update the selected preset on disk');
        controller.selectedPresetId = uniformPreset.id;
        assert(await controller.loadPreset(uniformPreset.id), 'The saved uniform preset must load through the persistence controller');
        assert(grid.settings.gridMode === 'uniform' && grid.displayedItems[0].locked && fileKey(grid.displayedItems[0].media) === fileKey(video), 'Loading a preset must restore its pinned video and layout mode');

        // A missing saved file must remain a named pin. The user can fill that slot and keep it locked.
        const missingKey = `${folder}/missing-pinned-image.png`;
        const missingState = structuredClone(uniformPreset.snapshot);
        missingState.pins = [{ index: 0, mediaKey: missingKey }];
        await grid.restoreState(missingState, allFiles);
        const missingPin = grid.displayedItems[0];
        assert(missingPin.locked && !missingPin.media && missingPin.missingMediaKey === missingKey, 'A missing pinned file must restore as an empty locked slot');
        assert(grid.exportState().pins.some((pin) => pin.index === 0 && pin.mediaKey === missingKey), 'Re-saving a missing pin must keep its file key');
        controller.files = allFiles;
        controller.selectedPresetId = null;
        const missingPreset = await clickPresetSave(`Issue 5 missing pin ${runId}`);
        const persistedMissing = (await window.mediaAPI.listPresets(folder)).find((item) => item.id === missingPreset.id);
        assert(persistedMissing.snapshot.pins[0].mediaKey === missingKey, 'The persisted missing pin must not have a null file key');
        assert(await controller.loadPreset(missingPreset.id), 'The saved missing-pin preset must reload');
        const missingCell = grid.displayedItems[0];
        missingCell.cell.click();
        assert(missingCell.locked && missingCell.media && fileKey(missingCell.media) !== missingKey, 'Clicking a missing pin must fill it with random media and keep it locked');
        assert(grid.exportState().pins.every((pin) => typeof pin.mediaKey === 'string' && pin.mediaKey.length > 0), 'Filled pins must remain valid when re-saved');

        // Save and load the same preset for a folder that now has no media files.
        controller.folderPath = emptyFolder;
        controller.files = allFiles;
        controller.selectedPresetId = null;
        const emptyPreset = await clickPresetSave(`Issue 5 empty folder ${runId}`);
        assert(await controller.loadPreset(emptyPreset.id), 'A saved layout must load after its folder has no media files');
        assert(controller.files.length === 0 && grid.displayedItems.length === emptyPreset.snapshot.settings.slotCount, 'An empty folder must retain the saved tile count');
        assert(grid.displayedItems.some((item) => item.locked && !item.media && item.missingMediaKey), 'Missing folder media must remain an empty locked pin');

        const emptyFolderTiles = grid.displayedItems.length;
        grid.stop();
        controller.dirty = false;
        return { uniqueVisible: 8, presetsSaved: controller.presets.length, pinnedVideo: true, ignoredRestored: true, emptyFolderTiles };
    });

    await check('ctrl-click-tile-merging', async () => {
        const waitFor = (condition, message) => until(condition, message);
        const fileKey = (media) => media?.path || media?.url;
        const ctrlClick = (item) => item.cell.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true, ctrlKey: true,
        }));
        const cancelSelection = () => document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true,
        }));
        const rectOf = (item) => grid.layoutGeometry[grid.displayedItems.indexOf(item)];
        const tileAt = (x, y, w = 1, h = 1) => grid.displayedItems.find((item) => {
            const rect = rectOf(item);
            return rect && rect.x === x && rect.y === y && rect.w === w && rect.h === h;
        });
        const sameGeometry = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const attemptMerge = (first, second) => {
            ctrlClick(first);
            assert(first.selectedForMerge && first.cell.classList.contains('merge-selected'), 'Ctrl-click must highlight the first selected tile');
            ctrlClick(second);
            const selected = first.selectedForMerge;
            cancelSelection();
            return selected;
        };
        const findFullEdgePair = () => {
            for (let left = 0; left < grid.displayedItems.length; left++) {
                const a = rectOf(grid.displayedItems[left]);
                for (let right = left + 1; right < grid.displayedItems.length; right++) {
                    const b = rectOf(grid.displayedItems[right]);
                    const horizontal = a.y === b.y && a.h === b.h && (a.x + a.w === b.x || b.x + b.w === a.x);
                    const vertical = a.x === b.x && a.w === b.w && (a.y + a.h === b.y || b.y + b.h === a.y);
                    if (horizontal || vertical) return [grid.displayedItems[left], grid.displayedItems[right]];
                }
            }
            return null;
        };
        const assertNoOverlap = () => {
            const occupied = new Set();
            for (const item of grid.displayedItems) {
                const rect = rectOf(item);
                for (let y = rect.y; y < rect.y + rect.h; y++) {
                    for (let x = rect.x; x < rect.x + rect.w; x++) {
                        const key = `${x}:${y}`;
                        assert(!occupied.has(key), 'Merged tiles must not overlap another tile');
                        occupied.add(key);
                    }
                }
            }
        };

        grid.stop();
        grid.updateSettings({ gridMode: 'uniform', slotCount: 12, imageTime: 120, mediaFilter: 'mixed', gap: 2 });
        await grid.setMedia(files);
        grid.pool = [video];
        grid.start();
        grid.freezeLayout();
        const controller = persistenceController;
        controller.folderPath = folder;
        controller.files = files;
        controller.presets = await window.mediaAPI.listPresets(folder);
        controller.selectedPresetId = null;
        controller.dirty = false;
        assert(grid.displayedItems.length === 12, 'The merge layout must start with 12 tiles');
        const first = tileAt(1, 1);
        const topRight = tileAt(2, 1);
        const lowerLeft = tileAt(1, 2);
        const lowerRight = tileAt(2, 2);
        assert(first && topRight && lowerLeft && lowerRight, 'The uniform grid must expose the expected adjacent cells');
        assert(first.media.type === 'video', 'The test video must be the first tile');

        assert(controller.dirty === false, 'The merge fixture must start with no unsaved changes');
        ctrlClick(first);
        assert(first.selectedForMerge && !first.locked, 'Ctrl-click selection must not toggle the normal lock state');
        assert(controller.dirty === false, 'Merge selection must not mark the layout as changed');
        ctrlClick(first);
        assert(!first.selectedForMerge && !first.locked, 'Ctrl-clicking the same tile twice must cancel selection');
        ctrlClick(first);
        assert(first.selectedForMerge, 'Ctrl-click must select the tile again after cancellation');
        cancelSelection();
        assert(!first.selectedForMerge && !first.locked, 'Escape must cancel a merge selection without changing the tile');

        const reverseFirst = tileAt(2, 3);
        const reverseSecond = tileAt(1, 3);
        const reverseMedia = reverseFirst.media;
        grid._replaceItem(reverseFirst);
        await waitFor(() => reverseFirst.transitionTimer !== null, 'The reverse-order tile must enter a pending media transition');
        ctrlClick(reverseFirst);
        reverseSecond.cell.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
        assert(!grid.displayedItems.includes(reverseSecond) && reverseFirst.media === reverseMedia, 'Reverse-order selection must retain the first selected media');
        assert(reverseFirst.transitionTimer === null && !reverseFirst.mediaEl.classList.contains('fade-out'), 'Merging the first tile must cancel its pending fade');

        const otherPin = tileAt(4, 3);
        const otherPinMedia = otherPin.media;
        otherPin.cell.click();
        assert(otherPin.locked, 'A second locked tile must be present');

        const firstMedia = first.media;
        const firstMediaEl = first.mediaEl;
        first.cell.click();
        topRight.cell.click();
        assert(first.locked && topRight.locked && first.media.type === 'video' && first.mediaEl.loop, 'Both merge inputs can be locked while a video keeps looping');
        controller.dirty = false;

        const invalidDiagonal = tileAt(2, 2);
        const diagonalGeometry = grid.layoutGeometry.map((rect) => ({ ...rect }));
        assert(attemptMerge(first, invalidDiagonal), 'A diagonal second selection must keep the first tile selected until Escape');
        assert(sameGeometry(grid.layoutGeometry, diagonalGeometry) && controller.dirty === false, 'A rejected diagonal must keep geometry and dirty state unchanged');
        assert(first.locked && invalidDiagonal.media, 'A rejected diagonal must keep media and locks');

        const releasedTop = topRight.media;
        ctrlClick(first);
        assert(first.selectedForMerge, 'The first Ctrl-click must select the tile');
        topRight.cell.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
        assert(!grid.displayedItems.includes(topRight) && first.locked && first.media === firstMedia && first.mediaEl === firstMediaEl, 'A horizontal merge must keep the first video, its element, and its lock');
        assert(topRight.timer === null && topRight.transitionTimer === null, 'A removed tile must release both timers');
        grid.reshufflePool();
        assert(grid.pool.some((media) => fileKey(media) === fileKey(releasedTop)) && !grid.ignoredMedia.has(fileKey(releasedTop)), 'A locked second tile must return to the eligible pool after reshuffle, without being ignored');

        controller.dirty = false;
        const mergedFirstGeometry = grid.layoutGeometry.map((rect) => ({ ...rect }));
        for (const badNeighbor of [lowerLeft, tileAt(3, 2), lowerRight]) {
            assert(attemptMerge(first, badNeighbor), 'An invalid L-shaped or partial-edge selection must keep the first tile selected until Escape');
            assert(sameGeometry(grid.layoutGeometry, mergedFirstGeometry) && controller.dirty === false, 'An invalid merge must leave geometry and dirty state unchanged');
            assert(first.locked && first.media === firstMedia && badNeighbor.media, 'An invalid merge must keep the media and lock states');
        }

        const releasedLower = lowerRight.media;
        ctrlClick(lowerLeft);
        lowerRight.cell.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
        assert(rectOf(lowerLeft).w === 2 && rectOf(lowerLeft).h === 1, 'A second horizontal merge must make a two-cell rectangle');
        assert(grid.pool.some((media) => fileKey(media) === fileKey(releasedLower)), 'A second released tile must also return to the pool');
        ctrlClick(first);
        lowerLeft.cell.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
        const repeatedShape = rectOf(first);
        assert(repeatedShape.x === 1 && repeatedShape.y === 1 && repeatedShape.w === 2 && repeatedShape.h === 2, 'A repeated vertical merge must make a two-by-two tile');
        assert(first.locked && first.media === firstMedia, 'Repeated merges must preserve the first media and its lock');
        assert(otherPin.locked && otherPin.media === otherPinMedia, 'A separate locked tile must remain unchanged');
        assert(!grid.ignoredMedia.has(fileKey(releasedTop)) && !grid.ignoredMedia.has(fileKey(releasedLower)), 'Merging must not add released media to the ignored set');
        assertNoOverlap();

        const uniformSnapshot = grid.exportState();
        assert(uniformSnapshot.geometry[0].w === 2 && uniformSnapshot.geometry[0].h === 2, 'Export must preserve the merged uniform tile span');
        controller.presets = await window.mediaAPI.listPresets(folder);
        controller.selectedPresetId = null;
        controller.dirty = false;
        const runId = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
        document.getElementById('preset-name').value = `Tile merge ${runId}`;
        const oldPresetCount = controller.presets.length;
        document.getElementById('save-new-preset').click();
        await waitFor(() => controller.presets.length === oldPresetCount + 1, 'Save New must write the merged layout through the app IPC');
        const uniformPreset = controller.presets.find((preset) => preset.title === `Tile merge ${runId}`);
        let diskPreset = (await window.mediaAPI.listPresets(folder)).find((preset) => preset.id === uniformPreset.id);
        assert(diskPreset.snapshot.geometry[0].w === 2 && diskPreset.snapshot.geometry[0].h === 2, 'The saved preset file must contain the merged span');

        document.querySelector('[data-media-filter="image"]').click();
        document.getElementById('gap-slider').value = '7';
        document.getElementById('gap-slider').dispatchEvent(new Event('input', { bubbles: true }));
        const originalWidth = gridEl.style.width;
        gridEl.style.width = `${Math.max(320, gridEl.clientWidth - 140)}px`;
        window.dispatchEvent(new Event('resize'));
        await wait(300);
        const changedGeometry = grid.layoutGeometry.map((rect) => ({ ...rect }));
        assert(changedGeometry[0].w === 2 && changedGeometry[0].h === 2, 'Filter, gap, and resize must retain the uniform merge span');
        assert(grid.displayedItems[0].locked && fileKey(grid.displayedItems[0].media) === fileKey(video), 'Filtering must keep the merged pinned video');
        document.getElementById('overwrite-preset').click();
        await waitFor(() => !controller.dirty, 'Overwrite must finish saving the changed merged layout');
        diskPreset = (await window.mediaAPI.listPresets(folder)).find((preset) => preset.id === uniformPreset.id);
        assert(diskPreset.snapshot.settings.mediaFilter === 'image' && diskPreset.snapshot.settings.gap === 7, 'Overwrite must save the changed filter and gap');
        assert(diskPreset.snapshot.geometry[0].w === 2 && diskPreset.snapshot.geometry[0].h === 2, 'Overwrite must retain merged geometry on disk');
        gridEl.style.width = originalWidth;
        window.dispatchEvent(new Event('resize'));
        assert(await controller.loadPreset(uniformPreset.id), 'The overwritten merged preset must load through the renderer and IPC');
        assert(grid.layoutGeometry[0].w === 2 && grid.layoutGeometry[0].h === 2, 'Loading the preset must restore its merged span');

        for (const mode of ['masonry', 'smart-masonry']) {
            grid.stop();
            grid.updateSettings({ gridMode: mode, slotCount: 12, mediaFilter: 'mixed' });
            await grid.setMedia(files);
            grid.pool = [...images.slice(0, 11), video];
            grid.start();
            await waitFor(() => grid.layoutGeometry?.length === 12 && grid.displayedItems.every((item) => item.cell.style.gridColumn && item.cell.style.gridRow), `${mode} geometry did not finish`);
            const pair = findFullEdgePair();
            assert(pair, `${mode} must have two tiles with a shared full edge`);
            const firstRect = { ...rectOf(pair[0]) };
            const secondRect = { ...rectOf(pair[1]) };
            const originalMedia = pair[0].media;
            ctrlClick(pair[0]);
            pair[1].cell.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
            const mergedRect = rectOf(pair[0]);
            assert(mergedRect.w * mergedRect.h === firstRect.w * firstRect.h + secondRect.w * secondRect.h, `${mode} merge must fill its rectangular union`);
            assert(pair[0].media === originalMedia && !grid.displayedItems.includes(pair[1]), `${mode} merge must keep first media and release the second tile`);
            await wait(100);
            assert(sameGeometry(rectOf(pair[0]), mergedRect), `${mode} layout work must not overwrite the merged geometry`);
            assertNoOverlap();
        }

        grid.stop();
        controller.dirty = false;
        return { horizontal: true, vertical: true, repeated: true, invalidRejected: 3, presets: 1, masonryModes: 2 };
    });

    assert(results.length === 8 * repetitions, `The complete suite must produce ${8 * repetitions} case runs`);
    grid.stop();
    grid.layoutWorker.dispose();
    grid.metadata.dispose();
    return results;
}
