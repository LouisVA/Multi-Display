const assert = require('node:assert/strict');
const { test } = require('node:test');
const cases = require('./layout-cases.json');
const MasonryLayout = require('../src/masonry-layout.js');

function assertQuality(engine, actual, original, descriptors) {
    const byIndex = new Map(descriptors.map(item => [item.index, item.aspect]));
    const quality = layout => {
        const fractions = layout.placements.map(rect => {
            const tile = engine._rectAspect(rect, layout.columns, layout.rows);
            const media = byIndex.get(rect.index);
            return Math.min(tile / media, media / tile, 1);
        });
        return [fractions.filter(value => value < 0.6).length, fractions.filter(value => value < 0.7).length,
            -Math.min(...fractions), fractions.reduce((sum, value) => sum + 1 - value, 0)];
    };
    const current = quality(actual);
    const baseline = quality(original);
    // Preserve the original results as a quality floor. Improved geometry need
    // not have identical coordinates, but it must not make crop quality worse.
    for (let index = 0; index < current.length; index++) {
        if (Math.abs(current[index] - baseline[index]) <= 0.0001) continue;
        assert(current[index] < baseline[index], `Crop quality regressed: ${JSON.stringify({ current, baseline })}`);
        break;
    }
}

function assertCoverage(layout, count) {
    assert(Number.isInteger(layout.columns) && layout.columns >= 1 && layout.columns <= 48);
    assert(Number.isInteger(layout.rows) && layout.rows >= 1 && layout.rows <= 48);
    const occupied = new Set();
    const indices = new Set();
    for (const placement of layout.placements) {
        assert([placement.x, placement.y, placement.w, placement.h].every(Number.isInteger));
        assert(placement.x > 0 && placement.y > 0 && placement.w > 0 && placement.h > 0);
        assert(placement.x + placement.w <= layout.columns + 1);
        assert(placement.y + placement.h <= layout.rows + 1);
        assert(!indices.has(placement.index));
        indices.add(placement.index);
        for (let y = placement.y; y < placement.y + placement.h; y++) {
            for (let x = placement.x; x < placement.x + placement.w; x++) {
                assert(!occupied.has(`${x},${y}`), 'Tiles must not overlap');
                occupied.add(`${x},${y}`);
            }
        }
    }
    assert.equal(occupied.size, layout.columns * layout.rows, 'The grid must have no gaps');
    assert.equal(layout.placements.length, count);
}

for (const fixture of cases) {
    test(`Smart layout meets original quality and full coverage: ${fixture.name}`, () => {
        const engine = new MasonryLayout(fixture.context);
        const layout = engine._buildSmartMasonryLayout(fixture.descriptors, { reason: 'build' });
        assertQuality(engine, layout, fixture.expected, fixture.descriptors);
        assertCoverage(layout, fixture.descriptors.length);
        engine.previousSmartPlacements = new Map(layout.placements.map((tile) => [tile.index, { ...tile }]));
        engine.previousSmartGrid = { columns: layout.columns, rows: layout.rows };
        engine.previousSmartScore = layout.cropScore;
        engine.settings.redrawOnRefresh = true;
        engine.aspectProfile = fixture.refreshProfile;
        const refreshed = engine._buildSmartMasonryLayout(fixture.refreshDescriptors, { reason: 'refresh', changedIndex: 0 });
        assertQuality(engine, refreshed, fixture.refreshExpected, fixture.refreshDescriptors);
        assertCoverage(refreshed, fixture.refreshDescriptors.length);
    });
}
