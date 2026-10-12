# Simplify a plant track

In the Standard workspace, use **Simplify track** (the compress icon beside the
keyframe star) on an unlocked, single-point track. Correct the remaining points,
then inspect the intermediate frames and add keyframes where linear interpolation
is inaccurate. This edits the current job's local annotations; persistence follows
CVAT's normal Save/auto-save settings.

The operation affects only the selected track. It preserves:

- The native track ID, group, label, `fr_origin` and `fr_tracking_id`.
- First and last keyframes and each continuous visible section's endpoints.
- All outside keyframes and both sides of visibility, occlusion, z-order and
  effective attribute changes (including sparse mutable attributes).
- Other tracks, including the automatic Ignore partner, and image tags/shapes.

Intermediate position keyframes are removed in one **Simplified track** history
entry. Normal Undo/Redo restores the complete change, including after subsequent
point edits. Protected transition keyframes can mean more than two remain.
Locked, read-only, skeleton-child and multi-point tracks cannot be simplified.

## Validation

Run from the repository root:

```bash
BABEL_DISABLE_CACHE=1 node tests/unit/track-simplification.cjs
BABEL_DISABLE_CACHE=1 node tests/unit/track-simplification-button.cjs
npx tsc --noEmit -p cvat-core/tsconfig.json
npx tsc --noEmit -p cvat-ui/tsconfig.json
yarn build:cvat-ui
```

Deployment requires only a rebuilt `cvat_ui` image: the changed core code is
bundled into the UI. Keep the previous UI image and Compose override for rollback;
do not restart backend workers or run annotation migrations. Existing saved
annotations are unaffected until an annotator uses the button and saves.
