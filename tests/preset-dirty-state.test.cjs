const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

function createSession(dirty) {
    const source = fs.readFileSync(require.resolve('../src/renderer.js'), 'utf8');
    const dialogs = [];
    const restored = [];
    const persistence = {
        dirty, busy: false, folderPath: 'C:/test-media', selectedPresetId: 'deleted', files: [],
        presets: [{ id: 'deleted', title: 'Deleted layout' }, { id: 'retained', title: 'Retained layout', snapshot: {} }],
    };
    const context = vm.createContext({
        persistence, presetName: { value: 'Deleted layout' },
        grid: { restoreState: async snapshot => restored.push(snapshot) },
        window: { mediaAPI: { deletePreset: async (_folder, id) => id, getMediaFiles: async () => [] } },
        presetLabel: preset => preset.title,
        setDirty(value = true) { persistence.dirty = Boolean(value); },
        showDecision: async ({ title }) => { dialogs.push(title); return title === 'Delete saved layout?' ? 'save' : 'cancel'; },
        showMessage: async (_title, message) => { throw Error(message); },
        renderPresetOptions() {}, syncSettingsControls() {}, renderIgnoredGallery() {},
        saveNew() {}, overwrite() {}, saveCurrent() { throw Error('Unexpected save'); },
    });
    const deletion = source.slice(source.indexOf('async function deleteSelectedPreset()'), source.indexOf('async function saveCurrent()'));
    const navigation = source.slice(source.indexOf('async function confirmLeave('), source.indexOf('grid.onChange ='));
    vm.runInContext(deletion + navigation, context);
    return { context, persistence, dialogs, restored };
}

test('Deleting an unchanged layout does not prompt when opening another layout', async () => {
    const session = createSession(false);
    assert.equal(await session.context.persistence.deletePreset(), true);
    assert.equal(session.persistence.dirty, false, 'Deleting a saved copy must not mark the current grid as edited');
    assert.equal(await session.context.persistence.loadPreset('retained'), true);
    assert.deepEqual(session.dialogs, ['Delete saved layout?']);
    assert.equal(session.restored.length, 1);
});

test('Deleting a layout preserves genuine unsaved edits and their leave prompt', async () => {
    const session = createSession(true);
    assert.equal(await session.context.persistence.deletePreset(), true);
    assert.equal(session.persistence.dirty, true);
    assert.equal(await session.context.persistence.loadPreset('retained'), false);
    assert.deepEqual(session.dialogs, ['Delete saved layout?', 'Unsaved layout']);
    assert.equal(session.restored.length, 0, 'Cancel must keep the edited grid');
});
