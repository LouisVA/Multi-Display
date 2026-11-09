(() => {
    const grid = document.getElementById("grid");
    const select = document.getElementById("grid-display-select");
    const showButton = document.getElementById("show-grid-display");
    const stopButton = document.getElementById("stop-grid-display");
    const status = document.getElementById("grid-display-status");
    const mediaIds = new WeakMap();
    const videoEvents = ["play", "pause", "seeked", "ended", "loadedmetadata"];
    let nextMediaId = 0;
    let state = { activeId: null, displays: [] };
    let busy = false;
    let observer = null;
    let timer;
    let queued = false;

    function readMedia(cell) {
        const element = cell.querySelector(".media-element");
        const source = element?.getAttribute("src");
        if (!source) return null;
        if (!mediaIds.has(element)) mediaIds.set(element, ++nextMediaId);
        const video = element instanceof HTMLVideoElement;
        return {
            id: mediaIds.get(element),
            source,
            video,
            paused: video && (element.paused || element.ended),
            loop: video && element.loop,
            time: video ? element.currentTime : 0,
            error: element.classList.contains("media-error"),
            fading: element.classList.contains("fade-out"),
            opacity: element.style.opacity,
            transition: element.style.transition,
        };
    }

    function queueFrame() {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            if (!observer) return;
            const { display, gap, gridAutoFlow, gridAutoRows, gridTemplateColumns, gridTemplateRows } = grid.style;
            window.mediaAPI.sendGridFrame({
                style: { display, gap, gridAutoFlow, gridAutoRows, gridTemplateColumns, gridTemplateRows },
                fit: grid.dataset.fitMode,
                cells: Array.from(grid.children, (cell) => ({
                    column: cell.style.gridColumn,
                    row: cell.style.gridRow,
                    media: readMedia(cell),
                })),
            });
        });
    }

    function setSharing(sharing) {
        if (sharing && !observer) {
            observer = new MutationObserver(queueFrame);
            observer.observe(grid, {
                subtree: true,
                childList: true,
                attributeFilter: ["style", "src", "loop", "class", "data-fit-mode"],
            });
            for (const event of videoEvents) grid.addEventListener(event, queueFrame, true);
            // Correct drift between the PC and output video players.
            timer = setInterval(() => {
                if ([...grid.querySelectorAll("video")].some((video) => !video.paused)) queueFrame();
            }, 1000);
            queueFrame();
        } else if (!sharing && observer) {
            observer.disconnect();
            observer = null;
            for (const event of videoEvents) grid.removeEventListener(event, queueFrame, true);
            clearInterval(timer);
        }
    }

    function updateButtons() {
        select.disabled = busy || !state.displays.length;
        showButton.disabled = busy || !select.value || Number(select.value) === state.activeId;
        stopButton.hidden = state.activeId === null;
        stopButton.disabled = busy;
    }

    function updateState(next) {
        const selected = select.value;
        const activeChanged = state.activeId !== next.activeId;
        state = next;
        select.replaceChildren(...state.displays.map(({ id, label }) => new Option(label, String(id))));
        if (!state.displays.length) {
            select.append(new Option("No other display", ""));
        } else if (activeChanged && state.activeId !== null) {
            select.value = String(state.activeId);
        } else if (state.displays.some(({ id }) => String(id) === selected)) {
            select.value = selected;
        }
        const active = state.displays.find(({ id }) => id === state.activeId);
        status.textContent = active ? `Showing the grid on ${active.label}.`
            : activeChanged ? "Grid display stopped."
            : state.displays.length ? "The controls stay in this window."
            : "For Miracast, connect with Win + K. Then choose Extend with Win + P.";
        setSharing(Boolean(active));
        // Changing the target can leave the observer running if status messages arrive together.
        if (active && activeChanged) queueFrame();
        updateButtons();
    }

    async function changeDisplay(action, errorMessage) {
        busy = true;
        updateButtons();
        try {
            if (await action() === false) status.textContent = errorMessage;
        } catch {
            status.textContent = errorMessage;
        } finally {
            busy = false;
            updateButtons();
        }
    }

    select.addEventListener("change", updateButtons);
    showButton.addEventListener("click", () => {
        const id = Number(select.value);
        void changeDisplay(() => window.mediaAPI.openGridDisplay(id), "Could not open the grid on this display.");
    });
    stopButton.addEventListener("click", () => {
        void changeDisplay(window.mediaAPI.closeGridDisplay, "Could not stop the grid display.");
    });
    window.mediaAPI.onDisplayState(updateState);
    window.mediaAPI.getDisplayState().then(updateState).catch(() => {
        status.textContent = "Could not get the list of displays.";
    });
})();
