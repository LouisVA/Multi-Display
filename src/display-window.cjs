const { BrowserWindow, screen } = require("electron");
const path = require("node:path");
const { setTimeout: wait } = require("node:timers/promises");
const windowsCast = require("./windows-cast.cjs");

function setupDisplayWindow(controls) {
    const contents = controls.webContents;
    const canCast = process.platform === "win32";
    let output = null;
    let pendingCast = null;
    let disconnecting = false;
    let castMessage = "";
    let controlDisplayId = screen.getDisplayMatching(controls.getBounds()).id;

    function availableDisplays() {
        return screen.getAllDisplays().filter((display) => display.id !== controlDisplayId);
    }

    function state() {
        return {
            activeId: output?.ready ? output.id : null,
            canCast,
            connecting: Boolean(pendingCast),
            disconnecting,
            castMessage,
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

    function disconnectReceiver(key) {
        disconnecting = true;
        sendState();
        void windowsCast.disconnectMiracast(key).catch((error) => {
            console.warn("Windows could not disconnect the wireless display:", error.message);
            castMessage = "The grid stopped. The wireless display is still connected in Windows.";
        }).finally(() => {
            disconnecting = false;
            sendState();
        });
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

    async function openOutput(id, receiverKey = null) {
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
            if (output !== current) return;
            output = null;
            if (!contents.isDestroyed() && current.ready) contents.setBackgroundThrottling(current.wasThrottled);
            if (current.ready && receiverKey) disconnectReceiver(receiverKey);
            sendState();
        });
        window.webContents.once("render-process-gone", () => {
            if (output === current) closeOutput();
        });
        try {
            await window.loadFile(path.join(__dirname, "display-output.html"));
        } catch (error) {
            if (output !== current) return false;
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
    }

    async function findReceiverDisplay(receiver, signal) {
        const { X: x, Y: y, Width: width, Height: height } = receiver;
        const deadline = Date.now() + 4000;
        do {
            const expected = screen.screenToDipRect(null, { x, y, width, height });
            const display = availableDisplays().find(({ bounds }) =>
                ["x", "y", "width", "height"].every((key) => Math.abs(bounds[key] - expected[key]) <= 2));
            if (display) return display;
            await wait(100, undefined, { signal });
        } while (Date.now() < deadline);
        return null;
    }

    async function startCast() {
        if (!canCast || pendingCast || output || disconnecting) return;
        const controller = new AbortController();
        pendingCast = controller;
        castMessage = "Choose a wireless display in Windows.";
        sendState();
        let receiver;
        try {
            receiver = await windowsCast.connectMiracast(controller.signal);
            if (controller.signal.aborted) return;
            if (!receiver) {
                castMessage = "No wireless display connected. Click Cast to try again.";
                return;
            }
            castMessage = "Opening the grid on your display…";
            sendState();
            const display = await findReceiverDisplay(receiver, controller.signal);
            if (!display || !(await openOutput(display.id, receiver.Key))) {
                throw new Error("The wireless display did not become available for the grid.");
            }
            castMessage = "";
        } catch (error) {
            if (!controller.signal.aborted) {
                console.warn("Could not cast the grid:", error.message);
                castMessage = "Could not open the grid on the wireless display.";
            }
        } finally {
            if (receiver && !output?.ready && !disconnecting) disconnectReceiver(receiver.Key);
            pendingCast = null;
            if (controller.signal.aborted) castMessage = "";
            sendState();
        }
    }

    function stopCast() {
        pendingCast?.abort();
        closeOutput();
    }

    contents.ipc.handle("grid-display-state", state);
    contents.ipc.handle("grid-display-close", stopCast);
    contents.ipc.handle("grid-display-open", (_event, id) => pendingCast ? false : openOutput(id));
    contents.ipc.handle("grid-cast-start", startCast);
    contents.ipc.on("grid-display-frame", (_event, frame) => {
        if (output?.ready) output.window.webContents.send("grid-display-frame", frame);
    });

    const events = ["display-added", "display-removed", "display-metrics-changed"];
    for (const event of events) screen.on(event, displaysChanged);
    controls.on("move", controlsMoved);
    contents.on("render-process-gone", stopCast);
    contents.on("did-start-loading", stopCast);
    controls.once("closed", () => {
        for (const event of events) screen.off(event, displaysChanged);
        stopCast();
    });
}

module.exports = { setupDisplayWindow };
