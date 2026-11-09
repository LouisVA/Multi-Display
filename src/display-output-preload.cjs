const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("displayOutput", {
    onFrame: (callback) => {
        ipcRenderer.on("grid-display-frame", (_event, frame) => callback(frame));
    },
});
