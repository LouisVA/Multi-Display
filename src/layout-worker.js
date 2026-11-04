importScripts("masonry-layout.js");

self.onmessage = ({ data }) => {
    try {
        const engine = new MasonryLayout(data.context);
        const layout = engine._buildSmartMasonryLayout(data.descriptors, data.options);
        self.postMessage({ layout, diagnostics: engine.lastSmartLayoutDiagnostics });
    } catch (error) {
        self.postMessage({ error: error.message });
    }
};
