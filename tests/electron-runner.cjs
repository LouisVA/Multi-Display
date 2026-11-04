// Run the actual app, preload bridge, media decoder and browser worker.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { app, BrowserWindow } = require('electron');

const session = path.resolve(__dirname, '../out/benchmark-session');
const fixtures = path.join(session, 'media');
const emptyFolder = path.join(session, 'empty-media');
const resultsPath = path.resolve(__dirname, '../out/benchmark-results.json');
const expectedGrowthBytes = 32 * 1024 * 1024;
const benchmarkCaseCount = 7;
const minimumFreeGiB = Number(process.env.MULTI_DISPLAY_BENCHMARK_MIN_FREE_GIB || 10);
if (!Number.isFinite(minimumFreeGiB) || minimumFreeGiB < 0) throw new Error('Invalid minimum disk reserve');
const disk = fs.statfsSync(__dirname);
const freeBytes = disk.bavail * disk.bsize;
fs.mkdirSync(path.dirname(session), { recursive: true });
if (freeBytes - expectedGrowthBytes < minimumFreeGiB * 1024 ** 3) {
    const blocked = { passed: false, started: false, reason: 'disk reserve unavailable', freeBytes, expectedGrowthBytes, minimumFreeGiB };
    fs.writeFileSync(path.resolve(__dirname, '../out/benchmark-blocked.json'), JSON.stringify(blocked, null, 2));
    console.error(`Benchmark blocked: the required ${minimumFreeGiB} GiB disk reserve is unavailable (${(freeBytes / 1024 ** 3).toFixed(3)} GiB free).`);
    app.exit(1);
} else {
    fs.mkdirSync(fixtures, { recursive: true });
    fs.mkdirSync(emptyFolder, { recursive: true });
    fs.mkdirSync(path.join(session, 'profile'), { recursive: true });
    fs.writeFileSync(path.resolve(__dirname, '../out/benchmark-resource-plan.json'), JSON.stringify({
        freeBytes, expectedGrowthBytes, minimumFreeGiB, modelSpendCeilingUSD: 0, paidModelCalls: 0,
        cases: benchmarkCaseCount, repetitions: 3, scoring: 'deterministic assertions and performance limits',
    }, null, 2));
    app.setPath('userData', path.join(session, 'profile'));
    require('../main.js');
    run().catch((error) => {
        console.error(error.stack);
        fs.writeFileSync(resultsPath, JSON.stringify({ passed: false, error: error.stack }, null, 2));
        app.exit(1);
    });
}

function crc32(buffer) {
    let crc = -1;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ -1) >>> 0;
}

function png(width, height) {
    const chunk = (name, bytes) => {
        const type = Buffer.from(name);
        const header = Buffer.alloc(4);
        header.writeUInt32BE(bytes.length);
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
        return Buffer.concat([header, type, bytes, checksum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const pixels = Buffer.alloc((width * 4 + 1) * height, 0x80);
    for (let y = 0; y < height; y++) pixels[y * (width * 4 + 1)] = 0;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function run() {
    const watchdog = setTimeout(() => {
        console.error('Benchmark exceeded the 180 second execution limit.');
        app.exit(1);
    }, 180000);
    for (let index = 0; index < 1000; index++) {
        fs.writeFileSync(path.join(fixtures, `${index}.png`), png(16 + index % 6 * 8, 16 + Math.floor(index / 6) % 6 * 8));
    }
    fs.copyFileSync(path.join(__dirname, 'fixtures/clip.webm'), path.join(fixtures, 'clip.webm'));
    await app.whenReady();
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    // Hidden windows can receive paint frames only once a second. Measure the
    // displayed app without taking keyboard focus from the user.
    window.showInactive();
    if (window.webContents.isLoading()) {
        await new Promise((resolve, reject) => {
            window.webContents.once('did-finish-load', resolve);
            window.webContents.once('did-fail-load', (_event, code, description) => reject(new Error(`${code}: ${description}`)));
        });
    }
    const errors = [];
    window.webContents.on('console-message', (event) => {
        if (event.level === 'error' && !event.message.includes('ERR_FILE_NOT_FOUND')) errors.push(event.message);
    });
    const suite = fs.readFileSync(path.join(__dirname, 'page-benchmark.js'), 'utf8');
    await window.webContents.executeJavaScript(suite);
    const results = await window.webContents.executeJavaScript(`runPerformanceSuite(${JSON.stringify(fixtures)}, 3, ${JSON.stringify(emptyFolder)})`);
    if (errors.length) throw new Error(`Renderer errors: ${errors.join('; ')}`);
    if (results.length !== benchmarkCaseCount * 3) {
        throw new Error(`Expected ${benchmarkCaseCount * 3} benchmark runs; received ${results.length}.`);
    }
    fs.writeFileSync(resultsPath, JSON.stringify({ passed: true, cases: benchmarkCaseCount, repetitions: 3, results }, null, 2));
    for (const result of results) console.log(JSON.stringify(result));
    console.log(`PASS: ${benchmarkCaseCount} cases, 3 repetitions each; real Electron app and worker.`);
    clearTimeout(watchdog);
    app.exit(0);
}
