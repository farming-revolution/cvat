# Point-control rendering regression

`single-point-controls.cjs` exports a Playwright page check for a loaded plant-track
job. Register `window.__prof = { store, actions }` using `cvatUI.registerComponent`
first. Use an isolated browser and block every non-read API request. Never run this
against an annotator's existing browser session.

The check uses local versioned canvas snapshots to exercise coordinate changes,
visibility, outside states, occlusion, selection and point-count transitions. It
checks DOM-node reuse and screen-space handle alignment, then exercises a real
mouse drag and keyboard undo/redo without saving. Use task 3769/job 3686 as the
production-derived fixture (client ID 1 must be a visible single-point track).

The optimization deliberately retains the SVG plugin's coordinate observer and
existing interaction handlers. Multipoint/topology changes retain the rebuilding
path. Sidebar controls retain their existing props, memoization and handlers;
only the responsive Ant Design grid wrappers become static flex rows. No backend,
annotation serialization, save protocol or frame-deletion changes are involved.

For performance, warm frames first, alternate cached frames 0/1 and compare the
same viewport and sidebar tab. Repeat Objects -> Labels -> Objects and compare
both task 3769 and task 3768. Record canvas-ready plus two animation frames, CPU
profiles and API requests. Cold image download time is a separate measurement.
