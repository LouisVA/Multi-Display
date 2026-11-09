const { app } = require("electron");
const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

const run = promisify(execFile);

async function runCastHelper(action, { signal, receiverKey } = {}) {
    const script = app.isPackaged
        ? path.join(process.resourcesPath, "app.asar.unpacked", "src", "windows-cast.ps1")
        : path.join(__dirname, "windows-cast.ps1");
    const executable = path.join(process.env.SystemRoot || "C:\\Windows",
        "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-Action", action];
    if (receiverKey) args.push("-ReceiverKey", receiverKey);
    const { stdout } = await run(executable, args, { signal, windowsHide: true, timeout: 70000 });
    return JSON.parse(stdout.trim() || "null");
}

module.exports = {
    connectMiracast: (signal) => runCastHelper("Connect", { signal }),
    disconnectMiracast: (receiverKey) => runCastHelper("Disconnect", { receiverKey }),
    inspectDisplays: () => runCastHelper("Inspect"),
};
