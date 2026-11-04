// Keep only the latest calculation. Termination also stops obsolete CPU work.
class LayoutWorkerClient {
    constructor() {
        this.worker = null;
        this.pending = null;
    }

    calculate(context, descriptors, options) {
        this.cancel();
        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject };
            try {
                if (!this.worker) {
                    this.worker = new Worker(new URL("layout-worker.js", document.baseURI));
                }
                this.timeout = setTimeout(() => this._fail(new Error("Layout worker timed out")), 10000);
                this.worker.onmessage = ({ data }) => {
                    const pending = this.pending;
                    if (!pending) return;
                    this.pending = null;
                    clearTimeout(this.timeout);
                    if (data.error) pending.reject(new Error(data.error));
                    else pending.resolve(data);
                };
                this.worker.onerror = (event) => {
                    event.preventDefault();
                    this._fail(new Error(event.message || "Layout worker failed"));
                };
                this.worker.onmessageerror = () => this._fail(new Error("Invalid layout worker response"));
                this.worker.postMessage({ context, descriptors, options });
            } catch (error) {
                this._fail(error);
            }
        });
    }

    _fail(error) {
        const pending = this.pending;
        this.pending = null;
        clearTimeout(this.timeout);
        this.worker?.terminate();
        this.worker = null;
        pending?.reject(error);
    }

    cancel() {
        if (!this.pending) return;
        const pending = this.pending;
        this.pending = null;
        clearTimeout(this.timeout);
        this.worker.terminate();
        this.worker = null;
        pending.resolve(null);
    }

    dispose() {
        this.cancel();
        this.worker?.terminate();
        this.worker = null;
    }
}
