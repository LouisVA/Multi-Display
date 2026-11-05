const assert = require('node:assert/strict');
const { test } = require('node:test');
const MasonryLayout = require('../src/masonry-layout.js');

function createLandscapeCase() {
    const viewport = { width: 1280, height: 800 };
    const count = 4;
    const aspect = 2.2;
    const context = {
        viewport,
        settings: { gridMode: 'smart-masonry', slotCount: count, gap: 2, redrawOnRefresh: false },
        aspectProfile: { count, median: aspect, mean: aspect, spread: 0 },
    };
    const seed = new MasonryLayout(context);
    const dimensions = seed._masonryGridDimensions(count, 'smart-masonry');
    const engine = new MasonryLayout({ ...context, masonryColumns: dimensions.columns, masonryRows: dimensions.rows });
    const descriptors = Array.from({ length: count }, (_, index) => ({ index, aspect }));
    return { engine, descriptors, aspect };
}

function createAspectLayout(viewport, aspects) {
    const logarithms = aspects.map((aspect) => Math.log(aspect));
    const sortedAspects = [...aspects].sort((left, right) => left - right);
    const mean = Math.exp(logarithms.reduce((sum, value) => sum + value, 0) / aspects.length);
    const meanLog = Math.log(mean);
    const spread = Math.sqrt(logarithms.reduce((sum, value) => sum + (value - meanLog) ** 2, 0) / aspects.length);
    const aspectProfile = {
        count: aspects.length,
        median: sortedAspects[Math.floor(sortedAspects.length / 2)],
        mean,
        spread,
    };
    const context = {
        viewport,
        settings: { gridMode: 'smart-masonry', slotCount: aspects.length, gap: 2, redrawOnRefresh: false },
        aspectProfile,
    };
    const seed = new MasonryLayout(context);
    const dimensions = seed._masonryGridDimensions(aspects.length, 'smart-masonry');
    const engine = new MasonryLayout({ ...context, masonryColumns: dimensions.columns, masonryRows: dimensions.rows });
    const descriptors = aspects.map((aspect, index) => ({ index, aspect }));
    const layout = engine._buildSmartMasonryLayout(descriptors, { reason: 'build' });
    return { engine, descriptors, layout };
}

function visibleFractions(engine, layout, descriptors) {
    const aspectByIndex = new Map(descriptors.map(({ index, aspect }) => [index, aspect]));
    return layout.placements.map((placement) => {
        const tileAspect = engine._rectAspect(placement, layout.columns, layout.rows);
        return engine._visibleFractionForAspectPair(tileAspect, aspectByIndex.get(placement.index));
    });
}

function assertFullCoverage(layout) {
    const occupied = new Set();
    for (const placement of layout.placements) {
        for (let y = placement.y; y < placement.y + placement.h; y++) {
            for (let x = placement.x; x < placement.x + placement.w; x++) {
                const key = `${x}:${y}`;
                assert(!occupied.has(key), `Grid cell ${key} must not overlap`);
                occupied.add(key);
            }
        }
    }
    assert.equal(occupied.size, layout.columns * layout.rows, 'The layout must cover the full integer grid');
}

test('Smart layout keeps landscape media out of portrait tiles when a better full-coverage tiling exists', () => {
    const { engine, descriptors, aspect } = createLandscapeCase();
    const layout = engine._buildSmartMasonryLayout(descriptors, { reason: 'build' });
    const actualFractions = visibleFractions(engine, layout, descriptors);

    // A 6x2 tiling with four 3x1 tiles is full coverage and has no portrait tile.
    const comparisonEngine = new MasonryLayout({
        viewport: { width: 1280, height: 800 },
        settings: { gridMode: 'smart-masonry', slotCount: 4, gap: 2, redrawOnRefresh: false },
        masonryColumns: 6,
        masonryRows: 2,
    });
    const comparison = {
        columns: 6,
        rows: 2,
        placements: [1, 2, 3, 4].map((index) => ({ x: ((index - 1) % 2) * 3 + 1, y: Math.floor((index - 1) / 2) + 1, w: 3, h: 1, index: index - 1 })),
    };
    const comparisonFractions = visibleFractions(comparisonEngine, comparison, descriptors);
    assertFullCoverage(comparison);
    assert(comparisonFractions.every((fraction) => fraction >= 0.7));

    assertFullCoverage(layout);
    assert(
        Math.min(...actualFractions) >= Math.min(...comparisonFractions) - 0.01,
        `The engine must not prefer a portrait crop (${Math.min(...actualFractions).toFixed(3)}) over an available landscape tiling (${Math.min(...comparisonFractions).toFixed(3)}); source=${engine.lastSmartLayoutDiagnostics?.source}`
    );
    assert(layout.placements.length === descriptors.length);
    assert(descriptors.every((descriptor) => descriptor.aspect > 1 && aspect > 1));
});

test('Smart layout keeps mixed aspect ratios well-fitted on tall and wide screens', () => {
    const cases = [
        {
            viewport: { width: 540, height: 960 },
            aspects: [2.2, 1.8, 1.55, 1.3, 1.1, 0.95, 0.8, 0.68, 0.58, 0.5, 0.42, 0.35],
        },
        {
            viewport: { width: 1280, height: 800 },
            aspects: [2.2, 1.8, 1.55, 1.3, 1.1, 0.95, 0.8, 0.68],
        },
    ];

    for (const fixture of cases) {
        const { engine, descriptors, layout } = createAspectLayout(fixture.viewport, fixture.aspects);
        const score = engine._scoreCandidateLayout(descriptors, layout.placements, {
            columns: layout.columns,
            rows: layout.rows,
        });
        assertFullCoverage(layout);
        assert.equal(layout.placements.length, descriptors.length);
        assert(layout.columns <= 48 && layout.rows <= 48, 'Exported integer grid dimensions must remain at most 48');
        assert(score.worstVisibleFraction >= 0.75, `Mixed-media layout should avoid severe crops: ${score.worstVisibleFraction.toFixed(3)}`);
        assert.equal(score.rejectedCropCount, 0, 'The layout should not reject any media through extreme cropping');
    }
});

test('Optimize scores the current full-coverage layout and does not reduce its quality', () => {
    const { engine, descriptors, aspect } = createLandscapeCase();
    const currentLayout = {
        columns: 6,
        rows: 2,
        placements: [
            { x: 1, y: 1, w: 3, h: 1, index: 0 },
            { x: 4, y: 1, w: 3, h: 1, index: 1 },
            { x: 1, y: 2, w: 3, h: 1, index: 2 },
            { x: 4, y: 2, w: 3, h: 1, index: 3 },
        ],
    };
    const currentScore = engine._scoreCandidateLayout(descriptors, currentLayout.placements, currentLayout);
    assert(engine._isValidTiling(currentLayout.placements, currentLayout.columns, currentLayout.rows, descriptors.length));
    assertFullCoverage(currentLayout);
    assert(currentScore.worstVisibleFraction >= 0.7, 'The valid current grid is a strong quality fallback');

    const optimized = engine._buildSmartMasonryLayout(descriptors, { reason: 'optimize', currentLayout });
    const optimizedScore = engine._scoreCandidateLayout(descriptors, optimized.placements, {
        columns: optimized.columns,
        rows: optimized.rows,
    });

    assertFullCoverage(optimized);
    assert(optimizedScore.worstVisibleFraction >= currentScore.worstVisibleFraction - 0.001);
    assert(optimizedScore.severeCropCount <= currentScore.severeCropCount);
    assert(descriptors.every((descriptor) => descriptor.aspect === aspect));
});

test('Refresh runs global search when its local repair still has severe crops', () => {
    const { engine } = createLandscapeCase();

    assert.equal(engine._isAcceptableSmartRepair({
        hardReject: false,
        severeCropCount: 1,
        worstVisibleFraction: 0.69,
        cropScore: 0,
    }), false);
    assert.equal(engine._isAcceptableSmartRepair({
        hardReject: false,
        severeCropCount: 0,
        worstVisibleFraction: 0.9,
    }), true);
});
