const assert = require('node:assert/strict');
const { setTimeout: wait } = require('node:timers/promises');
const { BrowserWindow, screen } = require('electron');

async function until(condition, message) {
    const deadline = Date.now() + 5000;
    do {
        const value = await condition();
        if (value) return value;
        await wait(20);
    } while (Date.now() < deadline);
    throw new Error(message);
}

const readGrid = `(() => {
    const grid = document.getElementById('grid');
    return {
        fit: grid.dataset.fitMode,
        gap: grid.style.gap,
        columns: grid.style.gridTemplateColumns,
        rows: grid.style.gridTemplateRows,
        cells: Array.from(grid.children, cell => ({
            column: cell.style.gridColumn, row: cell.style.gridRow,
            source: cell.querySelector('.media-element')?.getAttribute('src'),
        })),
    };
})()`;

async function runDisplayBenchmark(controls, folder, repetitions) {
    const pc = (script) => controls.webContents.executeJavaScript(script);
    const output = () => BrowserWindow.getAllWindows().find((window) => window !== controls);
    const originalDisplays = screen.getAllDisplays;
    const controlDisplay = screen.getDisplayMatching(controls.getBounds());
    const externalDisplay = originalDisplays.call(screen).find(({ id }) => id !== controlDisplay.id);
    const target = externalDisplay || { ...controlDisplay, id: 205849731, label: 'Test display' };
    let available = [controlDisplay];
    const defaults = await pc('({ ...grid.settings })');
    screen.getAllDisplays = () => available;
    const results = [];

    try {
        for (let repetition = 1; repetition <= repetitions; repetition++) {
            const started = performance.now();
            try {
                screen.emit('display-removed', {}, target);
                await until(() => pc("document.getElementById('show-grid-display').disabled"), 'Show must be disabled without another display');
                assert.equal(await pc('window.mediaAPI.openGridDisplay(-999)'), false, 'Invalid display IDs must be rejected');
                assert.equal(output(), undefined, 'An invalid request must not open a window');
                available = [controlDisplay, target];
                screen.emit('display-added', {}, target);
                await until(() => pc("!document.getElementById('show-grid-display').disabled"), 'A connected display must enable Show');
                await pc(`(async () => {
                    const files = await window.mediaAPI.getMediaFiles(${JSON.stringify(folder)});
                    const video = files.find(file => file.type === 'video');
                    const images = files.filter(file => file.type === 'image');
                    grid.setMedia([video, ...images.slice(0, 3)]);
                    grid.updateSettings({ gridMode: 'uniform', slotCount: 4, fitMode: 'fit', gap: 6, videoBehavior: 'loop', imageTime: 120 });
                    gridEl.style.display = 'grid';
                    grid.start();
                    document.getElementById('show-grid-display').click();
                })()`);
                const view = await until(() => {
                    const candidate = output();
                    return candidate?.isVisible() ? candidate : null;
                }, 'Show must open a visible output window');
                const tv = (script) => view.webContents.executeJavaScript(script);
                assert(view.isFullScreen(), 'The grid must open full-screen');
                assert(!view.focusable, 'The grid must leave focus with the PC controls');
                if (externalDisplay) {
                    assert.equal(screen.getDisplayMatching(view.getBounds()).id, target.id, 'The grid must open on the selected display');
                }
                assert(await tv("!document.querySelector('button, #settings-panel, #empty-state')"), 'The output must contain only the grid');
                await until(() => tv("document.querySelectorAll('.grid-cell').length === 4"), 'The output must show all four cells');
                assert.deepEqual(await tv(readGrid), await pc(readGrid), 'The output must match the PC layout, media, gap, and Fit setting');
                await until(() => tv("Boolean(document.querySelector('video')?.currentTime > 0)"), 'The output video must play');
                assert(await tv("document.querySelector('video').muted"), 'The output video must stay muted');
                await pc("document.getElementById('pause-btn').click()");
                await until(() => tv("document.querySelector('video').paused"), 'Pausing on the PC must pause the output video');
                await pc("document.getElementById('pause-btn').click()");
                await until(() => tv("!document.querySelector('video').paused"), 'Resuming on the PC must resume the output video');

                const merged = await pc(`(() => {
                    const geometry = grid._readCurrentGeometry();
                    const items = grid.displayedItems;
                    const first = items.findIndex((item, index) => items.some((other, otherIndex) =>
                        other.media.type === 'image' && grid._isFullEdgeNeighbor(geometry[index], geometry[otherIndex])));
                    const second = items.findIndex((item, index) =>
                        item.media.type === 'image' && grid._isFullEdgeNeighbor(geometry[first], geometry[index]));
                    grid.updateSettings({ fitMode: 'crop' });
                    return grid.mergeItems(first, second);
                })()`);
                assert(merged, 'The PC must merge a pair of adjacent cells');
                await until(() => tv("document.querySelectorAll('.grid-cell').length === 3 && document.getElementById('grid').dataset.fitMode === 'crop'"), 'The output must follow merging and Crop');
                assert.deepEqual(await tv(readGrid), await pc(readGrid), 'The output must match the merged PC layout');
                const replacement = await pc(`(async () => {
                    const item = grid.displayedItems.find(item => item.media.type === 'image');
                    const source = item.media.url;
                    await grid._replaceItem(item);
                    return source;
                })()`);
                await until(() => tv(`!Array.from(document.querySelectorAll('.media-element')).some(element => element.getAttribute('src') === ${JSON.stringify(replacement)})`), 'The output must follow media rotation');
                assert.deepEqual(await tv(readGrid), await pc(readGrid), 'The rotated output must match the PC grid');

                await pc("document.getElementById('stop-grid-display').click()");
                await until(() => !output(), 'Stop must close the output');
                await until(() => pc("!document.getElementById('show-grid-display').disabled"), 'Stop must allow the grid to be shown again');
                await pc("document.getElementById('show-grid-display').click()");
                await until(() => output()?.isVisible(), 'Show must reopen the output');
                available = [controlDisplay];
                screen.emit('display-removed', {}, target);
                await until(() => !output(), 'Display removal must close the output');
                await until(() => pc("document.getElementById('stop-grid-display').hidden"), 'Display removal must clear the active state');
                assert.equal(await pc('grid.displayedItems.length'), 3, 'Stopping the output must leave the PC grid open');
                results.push({
                    name: 'grid-on-display',
                    repetition,
                    elapsedMs: +(performance.now() - started).toFixed(2),
                    externalDisplay: Boolean(externalDisplay),
                    followsLayoutAndPlayback: true,
                    stopsOnDisconnect: true,
                });
            } catch (error) {
                throw new Error(`grid-on-display, repetition ${repetition}: ${error.message}`, { cause: error });
            }
        }
    } finally {
        output()?.destroy();
        screen.getAllDisplays = originalDisplays;
        screen.emit('display-added', {}, target);
        await pc(`grid.stop(); grid.updateSettings(${JSON.stringify(defaults)}); setDirty(false);`);
    }
    return results;
}

module.exports = { runDisplayBenchmark };
