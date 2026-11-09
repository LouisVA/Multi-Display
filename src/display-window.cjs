const { BrowserWindow, screen } = require("electron");
const path = require("node:path");

function setupDisplayWindow(controls) {
    const contents = controls.webContents;
    let output = null;
    let controlDisplayId = screen.getDisplayMatching(controls.getBounds()).id;

    function availableDisplays() {
        return screen.getAllDisplays().filter((display) => display.id !== controlDisplayId);
    }

    function state() {
        return {
            activeId: output?.ready ? output.id : null,
            displays: availableDisplays().map(({ id, label, size }) => ({
                id,
                label: `${label || "Display"} (${size.width} × ${size.height})`,
            })),
        };
    }

    function sendState() {
        if (!contents.isDestroyed()) contents.send("grid-display-state", state());
    }

    function closeOutput() {
        if (output && !output.window.isDestroyed()) output.window.destroy();
    }

    function displaysChanged() {
        controlDisplayId = screen.getDisplayMatching(controls.getBounds()).id;
        if (output && !availableDisplays().some((display) => display.id === output.id)) {
            closeOutput();
        } else {
            sendState();
        }
    }

    function controlsMoved() {
        if (screen.getDisplayMatching(controls.getBounds()).id !== controlDisplayId) displaysChanged();
    }

    contents.ipc.handle("grid-display-state", state);
    contents.ipc.handle("grid-display-close", closeOutput);
    contents.ipc.handle("grid-display-open", async (_event, id) => {
        const display = availableDisplays().find((entry) => entry.id === id);
        if (!display) return false;
        if (output?.id === id) return true;
        closeOutput();

        const window = new BrowserWindow({
            ...display.bounds,
            frame: false,
            show: false,
            focusable: false,
            skipTaskbar: true,
            backgroundColor: "#000000",
            webPreferences: {
                preload: path.join(__dirname, "display-output-preload.cjs"),
                contextIsolation: true,
                nodeIntegration: false,
                allowFileAccessFromFileUrls: true,
            },
        });
        const current = { id, window, ready: false, wasThrottled: contents.getBackgroundThrottling() };
        output = current;
        window.once("closed", () => {
            if (output !== current) return false;
            output = null;
            if (!contents.isDestroyed() && current.ready) contents.setBackgroundThrottling(current.wasThrottled);
            sendState();
        });
        window.webContents.once("render-process-gone", () => {
            if (output === current) closeOutput();
        });
        try {
            await window.loadFile(path.join(__dirname, "display-output.html"));
        } catch (error) {
            if (output !== current) return;
            closeOutput();
            throw error;
        }
        if (output !== current) return false;
        window.setFullScreen(true);
        window.showInactive();
        current.ready = true;
        // The rotation timers and the source videos must keep running if the PC window is minimized.
        contents.setBackgroundThrottling(false);
        sendState();
        return true;
    });
    contents.ipc.on("grid-display-frame", (_event, frame) => {
        if (output?.ready) output.window.webContents.send("grid-display-frame", frame);
    });

    const events = ["display-added", "display-removed", "display-metrics-changed"];
    for (const event of events) screen.on(event, displaysChanged);
    controls.on("move", controlsMoved);
    contents.on("render-process-gone", closeOutput);
    contents.on("did-start-loading", closeOutput);
    controls.once("closed", () => {
        for (const event of events) screen.off(event, displaysChanged);
        closeOutput();
    });
}

module.exports = { setupDisplayWindow };
