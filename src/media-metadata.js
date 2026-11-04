// Probe only requested media. Keep decoding work and the persistent cache bounded.
class MediaMetadata {
    constructor({ concurrency = 4, timeoutMs = 5000, maxEntries = 2000, storage } = {}) {
        this.concurrency = concurrency;
        this.timeoutMs = timeoutMs;
        this.maxEntries = maxEntries;
        this.active = 0;
        this.queue = [];
        this.jobs = new Map();
        this.cache = new Map();
        this.storageKey = "multi-display:media-dimensions:v1";
        this.flushTimer = null;
        try {
            this.storage = storage === undefined ? globalThis.localStorage : storage;
            const saved = this.storage?.getItem(this.storageKey) || "[]";
            const entries = saved.length <= 512 * 1024 ? JSON.parse(saved) : [];
            if (Array.isArray(entries)) {
                for (const entry of entries.slice(-maxEntries)) {
                    if (Array.isArray(entry) && typeof entry[0] === "string" && this._valid(entry[1])) {
                        this.cache.set(entry[0], { ...this._dimensions(entry[1]), persistent: true });
                    }
                }
            }
        } catch {
            // An unavailable or corrupt cache must not prevent folder loading.
        }
    }

    _identity(media) {
        const persistent = Number.isFinite(media.size) && Number.isFinite(media.modified);
        return {
            key: JSON.stringify([media.path || media.url, persistent ? media.size : null, persistent ? media.modified : null]),
            persistent,
        };
    }

    _valid(value) {
        return Number.isFinite(value?.width) && value.width > 0 &&
            Number.isFinite(value?.height) && value.height > 0 && Number.isFinite(value.width / value.height);
    }

    _dimensions({ width, height }) {
        return { width, height, aspect: width / height, measured: true };
    }

    _fallback(media) {
        return media.type === "video"
            ? { width: 16, height: 9, aspect: 16 / 9, measured: false }
            : { width: 1, height: 1, aspect: 1, measured: false };
    }

    get(media) {
        const { key, persistent } = this._identity(media);
        const cached = this.cache.get(key);
        if (cached) {
            this.cache.delete(key);
            this.cache.set(key, cached);
            return Promise.resolve(this._dimensions(cached));
        }
        if (this.jobs.has(key)) return this.jobs.get(key).promise;

        const job = { key, persistent, media, started: false, settled: false, cleanup: null };
        job.promise = new Promise((resolve) => { job.resolve = resolve; });
        this.jobs.set(key, job);
        this.queue.push(job);
        this._drain();
        return job.promise;
    }

    peek(media) {
        const cached = this.cache.get(this._identity(media).key);
        return cached ? this._dimensions(cached) : null;
    }

    remember(media, dimensions) {
        if (!this._valid(dimensions)) return;
        const { key, persistent } = this._identity(media);
        const metadata = this._dimensions(dimensions);
        this._store(key, persistent, metadata);
        const job = this.jobs.get(key);
        if (job) this._finish(job, metadata);
    }

    _store(key, persistent, metadata) {
        this.cache.delete(key);
        this.cache.set(key, { ...metadata, persistent });
        while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
        if (persistent && this.storage) {
            clearTimeout(this.flushTimer);
            this.flushTimer = setTimeout(() => this.flush(), 250);
        }
    }

    _drain() {
        if (this.canceling) return;
        while (this.active < this.concurrency && this.queue.length) {
            const job = this.queue.shift();
            if (job.settled) continue;
            this._start(job);
        }
    }

    _start(job) {
        job.started = true;
        this.active += 1;
        const isVideo = job.media.type === "video";
        const element = isVideo ? document.createElement("video") : new Image();
        const timer = setTimeout(() => this._finish(job, this._fallback(job.media)), this.timeoutMs);
        job.cleanup = () => {
            clearTimeout(timer);
            element.onload = element.onloadedmetadata = element.onerror = null;
            if (isVideo) element.pause();
            element.removeAttribute("src");
            if (isVideo) element.load();
        };
        const loaded = () => {
            const dimensions = isVideo
                ? { width: element.videoWidth, height: element.videoHeight }
                : { width: element.naturalWidth, height: element.naturalHeight };
            if (this._valid(dimensions)) this.remember(job.media, dimensions);
            else this._finish(job, this._fallback(job.media));
        };
        if (isVideo) {
            element.preload = "metadata";
            element.muted = true;
            element.onloadedmetadata = loaded;
        } else {
            element.onload = loaded;
        }
        element.onerror = () => this._finish(job, this._fallback(job.media));
        try {
            element.src = job.media.url;
            if (isVideo) element.load();
        } catch {
            this._finish(job, this._fallback(job.media));
        }
    }

    _finish(job, metadata) {
        if (job.settled) return;
        job.settled = true;
        job.cleanup?.();
        if (job.started) this.active -= 1;
        this.jobs.delete(job.key);
        job.resolve(metadata);
        this._drain();
    }

    cancel() {
        this.canceling = true;
        for (const job of this.jobs.values()) this._finish(job, this._fallback(job.media));
        this.queue = [];
        this.canceling = false;
    }

    flush() {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
        try {
            const entries = [];
            let characters = 2;
            for (const [key, value] of [...this.cache].reverse()) {
                if (!value.persistent) continue;
                const entry = [key, { width: value.width, height: value.height }];
                const length = JSON.stringify(entry).length + 1;
                if (characters + length > 512 * 1024) continue;
                entries.push(entry);
                characters += length;
            }
            this.storage?.setItem(this.storageKey, JSON.stringify(entries.reverse()));
        } catch {
            this.storage = null;
        }
    }

    dispose() {
        this.cancel();
        this.flush();
    }
}

if (typeof module !== "undefined") module.exports = MediaMetadata;
