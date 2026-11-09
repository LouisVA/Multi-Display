const outputGrid = document.getElementById("grid");
const outputTiles = [];

function syncVideo(video, { loop, paused, time }) {
    video.loop = loop;
    if (!video.readyState) return;
    const tolerance = paused ? 0.04 : 0.35;
    if (Math.abs(video.currentTime - time) > tolerance) video.currentTime = time;
    if (paused) video.pause();
    else if (video.paused) video.play().catch(() => {});
}

function setTileMedia(tile, media) {
    if (media?.source !== tile.media?.source || media?.video !== tile.media?.video || media?.id !== tile.media?.id) {
        if (tile.element instanceof HTMLVideoElement) {
            tile.element.pause();
            tile.element.removeAttribute("src");
            tile.element.load();
        }
        tile.element?.remove();
        tile.element = null;
        if (media) {
            const element = document.createElement(media.video ? "video" : "img");
            element.className = "media-element";
            if (media.video) {
                element.muted = true;
                element.playsInline = true;
                element.preload = "auto";
                element.addEventListener("loadedmetadata", () => {
                    if (tile.element === element) syncVideo(element, tile.media);
                });
            } else {
                element.alt = "";
            }
            element.src = media.source;
            tile.cell.appendChild(element);
            tile.element = element;
        }
    }
    tile.media = media;
    if (!media) return;
    tile.element.classList.toggle("media-error", media.error);
    tile.element.classList.toggle("fade-out", media.fading);
    tile.element.style.opacity = media.opacity;
    tile.element.style.transition = media.transition;
    if (media.video) syncVideo(tile.element, media);
}

window.displayOutput.onFrame(({ style, fit, cells }) => {
    Object.assign(outputGrid.style, style);
    outputGrid.dataset.fitMode = fit;
    while (outputTiles.length > cells.length) {
        const tile = outputTiles.pop();
        setTileMedia(tile, null);
        tile.cell.remove();
    }
    for (const [index, { column, row, media }] of cells.entries()) {
        if (!outputTiles[index]) {
            const cell = document.createElement("div");
            cell.className = "grid-cell";
            outputGrid.appendChild(cell);
            outputTiles.push({ cell, media: null, element: null });
        }
        const tile = outputTiles[index];
        tile.cell.style.gridColumn = column;
        tile.cell.style.gridRow = row;
        setTileMedia(tile, media);
    }
});
