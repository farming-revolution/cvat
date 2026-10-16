# Tracks and deleted frames

Frame deletion in the job editor now repairs single-point tracks and rectangle
tracks before changing the local frame state. The same operation accepts a list
of frames, so the quality-control bulk action is one undoable edit. The existing
controls and normal Save button remain in use.

The repair samples the pre-deletion interpolation at retained boundaries, carries
forward effective mutable attributes, removes excluded keyframes, and removes a
track only when no visible observations remain in the job. It does not move tags
or standalone shapes. A locked or unsupported affected track rejects the whole
local operation before any frame or track is changed. Frame steps, sparse frame
catalogues, and job boundaries use the actual job catalogue.

Simplify remains limited to single-point tracks. It first normalizes legacy
keyframes on deleted frames, including one- and two-keyframe tracks, then
simplifies each retained interval while protecting gap boundaries, visibility,
occlusion, z-order, and attribute transitions. Normalization and simplification
share one history entry. Unlike deletion, Simplify intentionally changes
intermediate positions. For legacy data it uses the original stored keyframes;
a new deletion preserves the editor's current interpolation, which already skips
previously deleted keyframes.

Undo/redo includes both frames and annotations. Restoring a frame after a save
or reload uses the repaired track's interpolation; removed keyframes are not
archived. Nothing is repaired when a job opens or switches frames.

## Atomic save protocol

`GET /api/jobs/{id}/annotations-with-frames` reads a consistent full annotation
snapshot, deleted-frame flags, and `frame_save_revision`. It requires annotation
and frame-metadata read permissions. A new UI falls back to the ordinary annotation
GET on an older server, but refuses to save frame changes without atomic support.
Ordinary labeling remains available.

`POST /api/jobs/{id}/annotations-with-frames` accepts:

- `annotations`: the complete intended annotation snapshot in CVAT's existing format;
- `deleted_frames`: the intended deleted-frame set within this job;
- `baseline_revision`: the revision received with the baseline.

It requires both annotation-edit and metadata-edit permissions. Task/job locks and
one database transaction cover frame changes, the edited job, and repairs to saved
tracks in overlapping jobs. Deletions outside the edited job are retained, including validation-pool deletions
and restorations that also affect linked placeholder frames. Writing
another job's tracks also requires permissions for that job. Unsupported affected
tracks, validation errors, or missing permissions roll back the entire save.
Existing native IDs are retained; new boundary keyframes receive ordinary native
IDs. No schema migration, special annotation attributes, or persistent repair
archive is introduced.

The revision has separate annotation and shared-state digests. Normal annotation
writes return their revision in `X-CVAT-Frame-Save-Revision`, leaving the ordinary
annotation JSON unchanged, including for worker hashing and sync baselines. The
UI advances only its annotation digest after these writes; it keeps its original
shared-state baseline so concurrent deletions cannot be silently restored. Revision hashing canonicalizes attribute/object ordering across server processes. Job
status, assignment timestamps and other unrelated timestamps do not stale a save.
A mismatching baseline returns HTTP 409 and retains local edits. If an uncertain
response is retried and the complete intended state already exists, the endpoint
reconciles IDs and returns it without creating duplicate annotations. Existing
IDs are reserved before matching identical new objects.

Frame-only legacy requests that require repair, and annotation writes that put
keyframes on deleted frames, are rejected. The task-level core frame API still
supports deletions requiring no repair; callers needing repair must use the job
API. Annotation/frame requests can no longer bypass the combined transaction.
Annotation-import and automatic-annotation processes must run the same backend
code so their writes use the same guards and locking order.

## Validation

Run the Node suites individually with `node tests/unit/<file>.cjs`, including
`track-frame-boundaries.cjs`, `annotation-frame-save.cjs`, and the existing
Simplify, sidebar and diagnostic suites. Run core/UI TypeScript checks,
changed-file ESLint, and the production webpack build.

The isolated backend runner uses an in-memory SQLite database, no production
configuration mounts, and no external networking:

```sh
DJANGO_SETTINGS_MODULE=tests.backend.frame_save_settings \
  python manage.py test tests.backend.test_frame_save tests.backend.test_frame_boundaries --noinput
```

The same settings optionally support a disposable PostgreSQL container named
`fr-frame-tests-db` on an internal-only Docker network. Set
`FRAME_TEST_POSTGRES_HOST=fr-frame-tests-db` to run the concurrent-writer test
with real row locks. Never point these settings at a production database.

The geometry fixtures derive from the original 577991 and 577837 incident
snapshots with anonymous identity attributes. They cover 50 tracks and 1,947
retained observations. Browser interpolation, backend/export interpolation and
the unchanged worker interpolation agree after repair; the existing worker
safeguard rejects the originals and accepts repaired data. No worker changes or
production repair are part of this feature.

Browser validation uses the production Arnika and weed-enrichment tasks with all
non-GET requests blocked or simulated locally. It checks deletion, exact undo/
redo, a single combined save, and cached-frame responsiveness with no per-frame
metadata or repair requests.

## Rollout and rollback

Commit/push to `farming/v2.64.0`; build immutable images from that revision.
Activation requires the user's concrete production confirmation. Preserve the
existing compose configuration and all rollback images. Update backend annotation
writers consistently, verify read-only API health, then activate the UI. Retain
old UI assets for open tabs. Do not enqueue production test jobs or change any
annotations as a deployment test. Leave dfd002 and Dashboard deployments unchanged.

The previous server/UI rollback tags are `fr-height-1a53c4718`; record the separate
previous CVAT queue-worker images before any activation. Repaired tracks remain
ordinary annotations, so rolling back software needs no annotation rollback.
An older UI may be asked to reload when attempting a frame-only deletion that
requires repair; this safeguard deliberately prevents the old bug from recurring.

## Validation results (2026-10-16)

- 155 core tests in 14 suites passed, including 77 frame-boundary cases and five
  combined-save cases.
- 32 isolated PostgreSQL backend/diagnostic tests passed, including real concurrent
  writers, rollback, overlap permissions and retry identity reconciliation.
- All 11 existing dataset-manager annotation tests passed separately.
- Core and UI TypeScript checks and changed-file ESLint passed. The production UI
  build passed with the existing asset-size warnings.
- Original 577991/577837 fixtures: 50 tracks, 1,947 retained observations agree
  between the core, backend/export and unchanged worker interpolation. The worker
  safeguard rejects the original invalid endpoints and accepts the repaired ones.
- Read-only production-backed browser runs passed for Arnika and weed enrichment.
  Candidate deletion/undo/redo restored exact annotation snapshots; a simulated
  combined save used one request and left no spurious unsaved changes. No browser
  writes reached production, and frame switches made no annotation/metadata requests.

Cached-frame benchmarks used both baseline/candidate and reversed run orders.
Arnika run medians were 64–69 ms for the baseline and 66–70 ms for the candidate.
For weed enrichment, previous/next transitions have very different costs, so a
pooled median is misleading. With fresh browser processes, 48 cached transitions
per run and separate direction measurements, mean transition times were 333–346
ms for the baseline and 331–355 ms for the candidate (aggregate difference about
1%). Browser CPU time showed the same overlapping variation. There was no
consistent regression across run order; no repair code or extra metadata requests
ran during switching. These are headless-browser comparisons, not promises about
labelers' hardware or network latency.
