# Convert an existing IMAGE task to static (file_system) chunk cache, reading the
# source images in-place from the mounted share instead of the copied-in raw data.
#
# Annotations are stored in the DB independently of chunk storage, so this script
# never touches annotation tables - it only regenerates chunks and flips the
# storage flags. The copied raw images are NOT deleted by this script; remove them
# manually after verifying the task renders correctly.
#
# This uses the internal CVAT API, so Pylint is disabled.
# pylint: disable=all

from __future__ import annotations

import argparse
import shutil

import django
from django.conf import settings
from django.db import connection, transaction
from django.db.migrations.recorder import MigrationRecorder
from unittest.mock import Mock, PropertyMock, patch

django.setup()

from cvat.apps.engine import models
from cvat.apps.engine.media_extractors import MEDIA_TYPES
from cvat.apps.engine.task import _create_static_chunks

EXPECTED_LAST_ENGINE_MIGRATION = "0100_alter_task_mode"


def _ensure_last_engine_applied_migration_name():
    recorder = MigrationRecorder(connection)
    applied = list(
        recorder.Migration.objects.filter(app="engine").values_list("name", flat=True)
    )
    assert applied, "No migrations applied for app 'engine'"
    highest = max(applied, key=lambda name: int(name.split("_")[0]))
    assert highest == EXPECTED_LAST_ENGINE_MIGRATION, (
        f"Last applied engine migration is '{highest}', expected "
        f"'{EXPECTED_LAST_ENGINE_MIGRATION}'. Verify the script still works and "
        f"update EXPECTED_LAST_ENGINE_MIGRATION."
    )


def _build_image_extractor(data: models.Data, *, read_root, dimension):
    images = list(data.images.order_by("frame").all())
    assert images, f"Data #{data.id} has no images"
    source_paths = [read_root / img.path for img in images]
    return MEDIA_TYPES["image"]["extractor"](
        source_paths=source_paths,
        step=data.get_frame_step(),
        start=data.start_frame,
        stop=data.stop_frame,
        dimension=dimension,
        # Preserve the exact DB frame order; do not re-sort.
        sorting_method=models.SortingMethod.PREDEFINED,
    )


def _cleanup_static_cache(data: models.Data):
    for quality in models.FrameQuality:
        folder = data.get_static_cache_dirname(quality)
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir(parents=True)


def main():
    parser = argparse.ArgumentParser(
        description="Switch an image task to static cache, reading source images "
        "in-place from the share (storage=SHARE), without copying data."
    )
    parser.add_argument("task_id", type=int)
    parser.add_argument(
        "--keep-local-storage",
        action="store_true",
        help="Generate static chunks but keep storage=LOCAL (read copied raw data). "
        "By default storage is switched to SHARE so the raw copies can be removed.",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=None,
        help="Override the number of frames per chunk before regenerating. Smaller "
        "values reduce the initial load time per job (fewer bytes per chunk) at the "
        "cost of more chunk files. If omitted, the existing chunk_size is kept.",
    )
    args = parser.parse_args()

    if args.chunk_size is not None:
        assert args.chunk_size >= 1, "--chunk-size must be >= 1"

    with transaction.atomic():
        _ensure_last_engine_applied_migration_name()

        task: models.Task = models.Task.objects.select_for_update().get(pk=args.task_id)
        data: models.Data = task.data

        assert task.mode == "annotation", (
            f"Task #{task.id} mode is '{task.mode}', this script only handles image tasks."
        )

        if args.keep_local_storage:
            read_root = data.get_upload_dirname()
            target_storage = data.storage
        else:
            read_root = settings.SHARE_ROOT
            target_storage = models.StorageChoice.SHARE

        extractor = _build_image_extractor(data, read_root=read_root, dimension=task.dimension)

        # Sanity: every DB image must resolve to an extractor path.
        extractor_paths = {extractor.get_path(i) for i in extractor.frame_range}
        for img in data.images.all():
            p = read_root / img.path
            assert p in extractor_paths, f"Frame {img.frame} path not found in extractor: {p}"
            assert p.exists(), f"Source image missing on disk: {p}"

        data.storage_method = models.StorageMethodChoice.FILE_SYSTEM
        data.storage = target_storage
        update_fields = ["storage_method", "storage"]
        if args.chunk_size is not None and args.chunk_size != data.chunk_size:
            data.chunk_size = args.chunk_size
            update_fields.append("chunk_size")
        _cleanup_static_cache(data)

        with patch("cvat.apps.engine.task.ImportRQMeta", return_value=Mock()) as mock:
            type(mock.for_job.return_value).task_progress = PropertyMock()
            _create_static_chunks(task, media_extractor=extractor, upload_dir=read_root)

        data.save(update_fields=update_fields)

    print(
        f"Task #{task.id}: switched to static cache "
        f"(storage={data.storage}, storage_method={data.storage_method}, "
        f"chunk_size={data.chunk_size})."
    )


if __name__ == "__main__":
    main()
