const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const MasonryLayout = require('../src/masonry-layout.js');

const context = vm.createContext({ MasonryLayout, clearTimeout, setTimeout });
const source = fs.readFileSync(require.resolve('../src/renderer.js'), 'utf8');
vm.runInContext(source.slice(0, source.indexOf('const grid = new MediaGrid')) + '\nthis.MediaGrid = MediaGrid;', context);

test('Rotation finds a known matching ratio beyond the old 18-file sample', () => {
    const grid = Object.create(context.MediaGrid.prototype);
    const landscape = { path: 'landscape', type: 'video' };
    const portraits = Array.from({ length: 20 }, (_, index) => ({ path: `portrait-${index}`, type: 'image' }));
    grid.mediaFiles = [landscape, ...portraits];
    grid.pool = [...grid.mediaFiles];
    grid.displayedItems = [];
    grid.reservedMediaKeys = new Set();
    grid.ignoredMedia = new Set();
    grid.filteredMedia = new Map();
    grid.mediaMetrics = new Map(grid.mediaFiles.map(media => [media.path, { aspect: media === landscape ? 16 / 9 : 9 / 16 }]));
    grid.aspectProfiles = new Map();
    grid.settings = { mediaFilter: 'mixed', slotCount: 1 };
    assert.equal(grid.getNextMedia(16 / 9), landscape, 'A matching landscape file must win over portrait files');
});

test('Locking during rotation metadata lookup cancels the replacement', async () => {
    const grid = Object.create(context.MediaGrid.prototype);
    const media = { path: 'kept-image', type: 'image' };
    const item = { cell: { isConnected: true }, media, mediaEl: {}, renderVersion: 0, locked: false };
    grid.running = true;
    grid.settings = { gridMode: 'smart-masonry' };
    grid.mediaGeneration = 1;
    grid._prepareRotationCandidates = () => new Promise(resolve => { finishLookup = resolve; });
    let finishLookup;
    let selections = 0;
    grid.getNextMedia = () => { selections++; return null; };
    const replacement = grid._replaceItem(item);
    item.locked = true;
    item.renderVersion++;
    finishLookup();
    await replacement;
    assert.equal(item.media, media);
    assert.equal(selections, 0, 'A stale lookup must not select replacement media');
});
