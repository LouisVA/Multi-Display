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


Install the development dependencies with `npm ci`. Start the app with `npm start`.

Build an installer with `npm run dist`. The installed app includes Electron and does not need Node.js.

Run `npm test` to check layout scoring and grid coverage against cases from the original app.
Run `npm run benchmark` for the complete app benchmark. It runs six cases three times each:

- Show the first grid in a folder with 1,000 images.
- Limit concurrent metadata probes.
- Calculate a Smart layout while the interface event loop continues.
- Cancel old layout work after a grid change.
- Release video sources after rotation and grid removal.
- Reuse cached dimensions, invalidate changed files, and handle failed or stalled probes.

The benchmark uses the installed Electron runtime and a small local video fixture.
It has no paid model calls or AI scoring tiers. It allows 32 MiB for temporary files.
It requires 10 GiB of free disk space after that allowance. An explicitly agreed exception can be set with
`MULTI_DISPLAY_BENCHMARK_MIN_FREE_GIB`. Results are saved in `out/benchmark-results.json`.
