# Multi-Display

Display multiple videos and images at the same time from a folder.

The settings panel supports three layout modes:

- Uniform for evenly sized slots.
- Masonry for varied tile sizes.
- Smart masonry for tile spans chosen from each image or video aspect ratio.

Use the Visible Slots slider to control how many items are shown at once in any mode.

The smart masonry mode aims to minimize cropping by matching the visible media set to a full-frame masonry partition.
It calculates the layout in a background worker so the controls can remain responsive.

The app loads visible media first. It does not wait for dimensions from the whole folder.
It runs at most four metadata probes at once and releases video resources when a tile changes.
It caches up to 2,000 media dimensions between sessions. The saved cache has a text size limit.
File size or modification time changes invalidate cached dimensions. Failed probes are not saved.

The settings panel also includes:

- Keep Grid or Redraw Grid on refresh for masonry modes.
- Mixed, Images, or Videos filtering for the current folder.
- Crop or Fit rendering, depending on whether filling the tile or preserving the full media matters more.
- Click a tile to lock it in place. Drag one tile onto another to swap their media. A locked video loops until you unlock it.
- Ctrl-click two tiles that share a full edge to merge them into a rectangle. The first tile keeps its media and lock. The released media remains eligible for later display.
- Right-click a tile to ignore that media. Restore ignored media from the gallery in Settings.
- Saved layouts keep their tile positions and merged spans when you save, pin, swap, filter, change the gap, or resize the window. A new grid mode or slot count starts a new layout.
- Save named layouts for the current folder. Each layout records its settings, tile positions, locked media, and ignored media. Choose Save New or Overwrite. The app asks whether to save, discard, or cancel when you leave unsaved changes.
- Optimize Current Grid arranges the visible tiles for less cropping, including frozen or merged layouts. It keeps the current media and locks. Undo restores the previous layout while the visible tiles stay unchanged.


Install the development dependencies with `npm ci`. Start the app with `npm start`.

Build an installer with `npm run dist`. The installed app includes Electron and does not need Node.js.

Run `npm test` to check layout scoring and grid coverage against cases from the original app.
Run `npm run benchmark` for the complete app benchmark. It runs nine cases three times each:

- Show the first grid in a folder with 1,000 images.
- Limit concurrent metadata probes.
- Calculate a Smart layout while the interface event loop continues.
- Cancel old layout work after a grid change.
- Release video sources after rotation and grid removal.
- Reuse cached dimensions, invalidate changed files, and handle failed or stalled probes.
- Check tile locking and swapping, ignored media, saved layout geometry, missing locked media, UI prompts, and preset storage.
- Check Ctrl-click tile merging, valid and invalid shapes, released media, locks, and saved merged layouts.
- Check Smart Grid optimization quality, identity preservation, Undo, and optimized preset save/load.

The benchmark uses the installed Electron runtime and a small local video fixture.
It has no paid model calls or AI scoring tiers. It allows 32 MiB for temporary files.
It requires 10 GiB of free disk space after that allowance. An explicitly agreed exception can be set with
`MULTI_DISPLAY_BENCHMARK_MIN_FREE_GIB`. Results are saved in `out/benchmark-results.json`.
