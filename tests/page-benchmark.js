async function runPerformanceSuite(folder, repetitions) {
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

    grid.stop();
    grid.layoutWorker.dispose();
    grid.metadata.dispose();
    return results;
}
