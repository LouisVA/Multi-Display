const assert = require('node:assert/strict');
const { test } = require('node:test');
const cases = require('./layout-cases.json');
const MasonryLayout = require('../src/masonry-layout.js');

for (const fixture of cases) {
    test(`Smart layout preserves scoring and full coverage: ${fixture.name}`, () => {
        const engine = new MasonryLayout(fixture.context);
        const layout = engine._buildSmartMasonryLayout(fixture.descriptors, { reason: 'build' });
        assert.deepEqual(layout, fixture.expected);
        const occupied = new Set();
        for (const placement of layout.placements) {
            assert(placement.x > 0 && placement.y > 0);
            assert(placement.x + placement.w <= layout.columns + 1);
            assert(placement.y + placement.h <= layout.rows + 1);
            for (let y = placement.y; y < placement.y + placement.h; y++) {
                for (let x = placement.x; x < placement.x + placement.w; x++) {
                    assert(!occupied.has(`${x},${y}`), 'Tiles must not overlap');
                    occupied.add(`${x},${y}`);
                }
            }
        }
        assert.equal(occupied.size, layout.columns * layout.rows, 'The grid must have no gaps');
        assert.equal(layout.placements.length, fixture.descriptors.length);
        engine.previousSmartPlacements = new Map(layout.placements.map((tile) => [tile.index, { ...tile }]));
        engine.previousSmartGrid = { columns: layout.columns, rows: layout.rows };
        engine.previousSmartScore = layout.cropScore;
        engine.settings.redrawOnRefresh = true;
        engine.aspectProfile = fixture.refreshProfile;
        assert.deepEqual(engine._buildSmartMasonryLayout(fixture.refreshDescriptors, { reason: 'refresh', changedIndex: 0 }), fixture.refreshExpected);
    });
}
