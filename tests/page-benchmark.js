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
    const check = async (name, body) => {
        for (let repetition = 1; repetition <= repetitions; repetition++) {
            grid.stop();
            const started = performance.now();
            const metrics = await body();
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
        assert(grid.mediaMetrics.size <= 12, 'Only visible media should be measured');
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

    assert(results.length === 7 * repetitions, `The complete suite must produce ${7 * repetitions} case runs`);
    grid.stop();
    grid.layoutWorker.dispose();
    grid.metadata.dispose();
    return results;
}
