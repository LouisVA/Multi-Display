const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

async function withStore(run) {
    const prefix = path.join(os.tmpdir(), 'multi-display-delete-test-');
    const userData = fs.mkdtempSync(prefix);
    const handlers = new Map();
    const electron = {
        app: { whenReady: () => ({ then() {} }), on() {}, getPath: () => userData },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../main.js'), 'utf8'), {
        require: name => name === 'electron' ? electron : require(name),
        process,
        console,
        __dirname: path.dirname(require.resolve('../main.js')),
    });
    const invoke = (name, ...args) => handlers.get(name)(null, ...args);
    const snapshot = {
        version: 1,
        settings: { gridMode: 'uniform', slotCount: 1, imageTime: 10, videoBehavior: 'loop', gap: 2, redrawOnRefresh: false, mediaFilter: 'mixed', fitMode: 'crop' },
        geometry: [{ x: 1, y: 1, w: 1, h: 1 }],
        grid: { columns: 1, rows: 1 },
        masonry: { columns: 1, rows: 1 },
        pins: [], ignored: [],
    };
    try {
        await run({ invoke, snapshot, userData, folder: path.join(userData, 'media') });
    } finally {
        assert(path.resolve(userData).startsWith(path.resolve(prefix)), 'Only the test directory can be removed');
        fs.rmSync(userData, { recursive: true, force: true });
    }
}

test('Concurrent save/delete preserves other layouts and rejects stale or invalid deletions', async () => {
    await withStore(async ({ invoke, snapshot, folder }) => {
        const first = await invoke('save-preset', folder, 'Delete me', snapshot);
        const otherFolder = folder + '-other';
        const other = await invoke('save-preset', otherFolder, 'Other folder', snapshot);
        const [removed, ...saved] = await Promise.all([
            invoke('delete-preset', folder, first.id),
            ...Array.from({ length: 8 }, (_, index) => invoke('save-preset', folder, `Keep ${index}`, snapshot)),
        ]);
        assert.equal(removed, first.id);
        const remaining = await invoke('list-presets', folder);
        assert.equal(remaining.length, 8);
        assert.deepEqual(new Set(remaining.map(item => item.id)), new Set(saved.map(item => item.id)));
        await assert.rejects(invoke('delete-preset', folder, first.id), /no longer exists/);
        await assert.rejects(invoke('delete-preset', folder, ''), /valid saved layout/);
        await assert.rejects(invoke('delete-preset', folder, other.id), /no longer exists/);
        assert.equal((await invoke('list-presets', folder)).length, 8);
        assert.equal((await invoke('list-presets', otherFolder))[0].id, other.id);
        await invoke('delete-preset', otherFolder, other.id);
        assert.equal((await invoke('list-presets', otherFolder)).length, 0);
    });
});

test('Deleting from a corrupt store does not rewrite its contents', async () => {
    await withStore(async ({ invoke, snapshot, folder, userData }) => {
        const saved = await invoke('save-preset', folder, 'Keep me', snapshot);
        const storeDir = path.join(userData, 'presets');
        const storeFile = path.join(storeDir, fs.readdirSync(storeDir)[0]);
        fs.writeFileSync(storeFile, '{broken-store');
        await assert.rejects(invoke('delete-preset', folder, saved.id), /could not be read/);
        assert.equal(fs.readFileSync(storeFile, 'utf8'), '{broken-store');
        assert.equal(fs.readdirSync(storeDir).length, 1, 'No temporary write may remain');
    });
});
