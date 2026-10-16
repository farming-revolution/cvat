# Copyright (C) 2026 Farming Revolution
# SPDX-License-Identifier: MIT
"""Real isolated ORM/transaction tests. No production mounts, queues or network.
DJANGO_SETTINGS_MODULE=tests.backend.frame_save_settings python manage.py test tests.backend.test_frame_save
"""
from copy import deepcopy
from unittest.mock import patch

from django.test import TestCase
from rest_framework.exceptions import ValidationError, PermissionDenied
from cvat.apps.engine import models
from cvat.apps.engine.frame_deletion import checkpoint, save_with_frames, StaleFrameSave
from cvat.apps.engine.track_frame_boundaries import repair_track
from cvat.apps.engine.serializers import JobDataMetaWriteSerializer
from cvat.apps.dataset_manager.task import (
    get_job_data,
    patch_job_data,
    put_job_data,
    PatchAction,
)


class FrameSaveTests(TestCase):
    def setUp(self):
        self.events = patch("cvat.apps.dataset_manager.task.handle_annotations_change").start()
        self.addCleanup(patch.stopall)
        self.data = models.Data.objects.create(
            size=12, start_frame=0, stop_frame=11, image_quality=70
        )
        self.task = models.Task.objects.create(
            name="isolated test", data=self.data, mode="interpolation"
        )
        segment = models.Segment.objects.create(task=self.task, start_frame=0, stop_frame=11)
        self.job = models.Job.objects.create(segment=segment)
        self.label = models.Label.objects.create(task=self.task, name="Plant", type="points")
        self.attribute = models.AttributeSpec.objects.create(
            label=self.label,
            name="size",
            mutable=True,
            input_type="select",
            default_value="tiny",
            values="tiny\nsmall",
        )
        payload = {"version": 0, "tags": [], "shapes": [], "tracks": [self.track()]}
        put_job_data(self.job.id, payload)
        self.baseline = checkpoint(self.job.id, get_job_data(self.job.id))

    def track(self):
        return {
            "frame": 0,
            "label_id": self.label.id,
            "source": "manual",
            "group": 0,
            "attributes": [],
            "elements": [],
            "shapes": [
                {
                    "frame": f,
                    "type": "points",
                    "points": [float(f + 10), float(f * f + 10)],
                    "rotation": 0,
                    "outside": False,
                    "occluded": False,
                    "z_order": 0,
                    "attributes": [
                        {
                            "spec_id": self.attribute.id,
                            "value": "tiny" if f < 7 else "small",
                        }
                    ],
                }
                for f in (0, 3, 7, 11)
            ],
        }

    def request(self, deleted=(3,), **kwargs):
        desired = {k: deepcopy(self.baseline[k]) for k in ("tags", "shapes", "tracks")}
        desired["tracks"] = [
            repair_track(t, list(range(12)), set(deleted)) for t in desired["tracks"]
        ]
        desired["tracks"] = [t for t in desired["tracks"] if t is not None]
        return dict(
            annotations=desired,
            deleted_frames=list(deleted),
            baseline_revision=self.baseline["frame_save_revision"],
            **kwargs,
        )

    def test_atomic_save_preserves_track_id_and_retry_is_idempotent(self):
        body = self.request()
        body["annotations"]["shapes"].append(
            {
                "frame": 1,
                "label_id": self.label.id,
                "source": "manual",
                "group": 0,
                "type": "points",
                "points": [4.0, 5.0],
                "rotation": 0,
                "outside": False,
                "occluded": False,
                "z_order": 0,
                "attributes": [{"spec_id": self.attribute.id, "value": "tiny"}],
            }
        )
        result = save_with_frames(self.job.id, body, lambda j: None)
        self.assertEqual(result["tracks"][0]["id"], self.baseline["tracks"][0]["id"])
        self.assertEqual(result["frame_save_deleted_frames"], [3])
        retry = save_with_frames(self.job.id, body, lambda j: None)
        self.assertEqual(result, retry)
        self.assertEqual(models.LabeledShape.objects.filter(job=self.job).count(), 1)

    def test_stale_submission_does_not_change_either_resource(self):
        body = self.request()
        changed = deepcopy(self.baseline["tracks"][0])
        changed["shapes"][0]["points"] = [99.0, 99.0]
        patch_job_data(
            self.job.id,
            {"tags": [], "shapes": [], "tracks": [changed]},
            PatchAction.UPDATE,
        )
        before = get_job_data(self.job.id)
        with self.assertRaises(StaleFrameSave):
            save_with_frames(self.job.id, body, lambda j: None)
        self.data.refresh_from_db()
        self.assertEqual(self.data.deleted_frames, [])
        self.assertEqual(get_job_data(self.job.id), before)

    def test_rollback_if_annotations_invalid_after_frame_update(self):
        body = self.request()
        body["annotations"]["tracks"][0]["label_id"] = 9999999
        with self.assertRaises(Exception):
            save_with_frames(self.job.id, body, lambda j: None)
        self.data.refresh_from_db()
        self.assertEqual(self.data.deleted_frames, [])
        self.assertEqual(get_job_data(self.job.id)["tracks"], self.baseline["tracks"])

    def test_old_frame_only_and_annotation_only_bypasses_are_rejected(self):
        serializer = JobDataMetaWriteSerializer(self.job, data={"deleted_frames": [3]})
        serializer.is_valid(raise_exception=True)
        with self.assertRaises(ValidationError):
            serializer.save()
        save_with_frames(self.job.id, self.request(), lambda j: None)
        with self.assertRaises(ValidationError):
            patch_job_data(
                self.job.id,
                {"tags": [], "shapes": [], "tracks": self.baseline["tracks"]},
                PatchAction.UPDATE,
            )

    def test_overlapping_job_is_repaired_and_requires_permission(self):
        segment = models.Segment.objects.create(task=self.task, start_frame=2, stop_frame=11)
        other = models.Job.objects.create(segment=segment)
        other_track = self.track()
        other_track["frame"] = 3
        other_track["shapes"] = other_track["shapes"][1:]
        put_job_data(other.id, {"tags": [], "shapes": [], "tracks": [other_track]})
        self.baseline = checkpoint(self.job.id, get_job_data(self.job.id))
        other_before = get_job_data(other.id)

        def deny_other(job):
            if job.id == other.id:
                raise PermissionDenied()

        with self.assertRaises(PermissionDenied):
            save_with_frames(self.job.id, self.request(), deny_other)
        self.data.refresh_from_db()
        self.assertEqual(self.data.deleted_frames, [])
        self.assertEqual(get_job_data(other.id), other_before)
        save_with_frames(self.job.id, self.request(), lambda j: None)
        repaired = get_job_data(other.id)["tracks"][0]
        self.assertEqual(repaired["id"], other_before["tracks"][0]["id"])
        self.assertEqual(repaired["frame"], 4)
        self.assertNotIn(3, [s["frame"] for s in repaired["shapes"]])

    def test_restore_uses_repaired_interpolation_without_original_keyframes(self):
        saved = save_with_frames(self.job.id, self.request(), lambda j: None)
        self.baseline = saved
        restored = save_with_frames(self.job.id, self.request(deleted=()), lambda j: None)
        self.assertEqual(saved["tracks"], restored["tracks"])
        self.assertEqual(restored["frame_save_deleted_frames"], [])

    def test_sparse_new_track_attributes_and_new_tag_use_defaults(self):
        body = self.request()
        new_track = self.track()
        for shape in new_track["shapes"]:
            shape["attributes"] = []
        new_track = repair_track(new_track, list(range(12)), {3})
        body["annotations"]["tracks"].append(new_track)
        body["annotations"]["tags"].append(
            {
                "frame": 2,
                "label_id": self.label.id,
                "group": 0,
                "source": "manual",
                "attributes": [],
            }
        )
        result = save_with_frames(self.job.id, body, lambda j: None)
        self.assertEqual(len(result["tracks"]), 2)
        self.assertEqual(len(result["tags"]), 1)

    def test_frames_outside_job_remain_deleted(self):
        self.data.deleted_frames = [11]
        self.data.save()
        segment = models.Segment.objects.create(task=self.task, start_frame=0, stop_frame=5)
        other = models.Job.objects.create(segment=segment)
        baseline = checkpoint(other.id, get_job_data(other.id))
        body = dict(
            annotations={k: baseline[k] for k in ("tags", "shapes", "tracks")},
            baseline_revision=baseline["frame_save_revision"],
            deleted_frames=[1],
        )
        save_with_frames(other.id, body, lambda j: None)
        self.data.refresh_from_db()
        self.assertEqual(set(self.data.deleted_frames), {1, 11})

    def test_delete_track_when_all_observations_are_deleted(self):
        result = save_with_frames(
            self.job.id, self.request(deleted=tuple(range(12))), lambda j: None
        )
        self.assertEqual(result["tracks"], [])
        self.assertEqual(result["frame_save_deleted_frames"], list(range(12)))

    def test_own_job_status_and_task_timestamp_do_not_stale_the_baseline(self):
        self.job.state = models.StateChoice.IN_PROGRESS
        self.job.save()
        self.task.touch()
        saved = save_with_frames(self.job.id, self.request(), lambda j: None)
        self.assertEqual(saved["frame_save_deleted_frames"], [3])

    def test_retained_native_shape_ids_are_preserved(self):
        before = {s["frame"]: s["id"] for s in self.baseline["tracks"][0]["shapes"]}
        saved = save_with_frames(self.job.id, self.request(), lambda j: None)
        after = {s["frame"]: s["id"] for s in saved["tracks"][0]["shapes"]}
        for frame in before.keys() & after.keys():
            self.assertEqual(after[frame], before[frame])

    def test_unsupported_overlap_rolls_back_already_repaired_current_job(self):
        segment = models.Segment.objects.create(task=self.task, start_frame=0, stop_frame=11)
        other = models.Job.objects.create(segment=segment)
        unsupported = self.track()
        for shape in unsupported["shapes"]:
            shape["points"] += [50.0, 60.0]
        put_job_data(other.id, {"tags": [], "shapes": [], "tracks": [unsupported]})
        self.baseline = checkpoint(self.job.id, get_job_data(self.job.id))
        with self.assertRaises(ValidationError):
            save_with_frames(self.job.id, self.request(), lambda j: None)
        self.data.refresh_from_db()
        self.assertEqual(self.data.deleted_frames, [])
        self.assertEqual(get_job_data(self.job.id)["tracks"], self.baseline["tracks"])

    def test_frame_steps_are_task_relative(self):
        self.data.start_frame = 10
        self.data.stop_frame = 32
        self.data.frame_filter = "step=2"
        self.data.save()
        self.baseline = checkpoint(self.job.id, get_job_data(self.job.id))
        saved = save_with_frames(self.job.id, self.request(), lambda j: None)
        self.assertEqual(saved["frame_save_deleted_frames"], [3])
        self.assertEqual([s["frame"] for s in saved["tracks"][0]["shapes"]], [0, 2, 4, 7, 11])

    def test_endpoint_requires_annotation_and_metadata_permissions(self):
        from types import SimpleNamespace as NS
        from django.urls import resolve
        from cvat.apps.engine.permissions import JobPermission

        match = resolve(f"/api/jobs/{self.job.id}/annotations-with-frames")
        self.assertEqual(match.func.actions["post"], "annotations_with_frames")
        scopes = JobPermission._get_scopes(
            NS(method="POST"), NS(action="annotations_with_frames"), self.job
        )
        self.assertEqual(
            scopes,
            [
                JobPermission.Scopes.UPDATE_ANNOTATIONS,
                JobPermission.Scopes.UPDATE_METADATA,
            ],
        )

    def test_annotation_payload_remains_unchanged_and_baseline_uses_headers(self):
        from rest_framework.test import APIRequestFactory
        from cvat.apps.engine.views import JobViewSet

        factory = APIRequestFactory()
        view = JobViewSet()
        view.get_object = lambda: self.job
        view.request = factory.get("/")
        view.request.query_params = {}
        response = view.annotations(view.request, self.job.id)
        self.assertEqual(set(response.data), {"version", "tracks", "shapes", "tags"})
        self.assertEqual(response.data, get_job_data(self.job.id))

    def test_normal_save_cannot_advance_past_a_concurrent_frame_change(self):
        other_baseline = self.baseline["frame_save_revision"]
        saved = save_with_frames(self.job.id, self.request(), lambda j: None)
        other_body = dict(
            annotations={k: saved[k] for k in ("tags", "shapes", "tracks")},
            deleted_frames=[],
            baseline_revision=saved["frame_save_revision"].split(":")[0]
            + ":"
            + other_baseline.split(":")[1],
        )
        with self.assertRaises(StaleFrameSave):
            save_with_frames(self.job.id, other_body, lambda j: None)

    def test_legacy_restore_without_new_deletion_does_not_silently_repair_other_frames(
        self,
    ):
        self.data.deleted_frames = [3, 7]
        self.data.save()
        self.baseline = checkpoint(self.job.id, get_job_data(self.job.id))
        body = dict(
            annotations={k: self.baseline[k] for k in ("tags", "shapes", "tracks")},
            deleted_frames=[7],
            baseline_revision=self.baseline["frame_save_revision"],
        )
        saved = save_with_frames(self.job.id, body, lambda j: None)
        self.assertEqual(saved["tracks"], self.baseline["tracks"])
        self.assertEqual(saved["frame_save_deleted_frames"], [7])

    def test_retry_reserves_existing_ids_before_matching_identical_new_objects(self):
        body = self.request()
        new = deepcopy(body["annotations"]["tracks"][0])
        new.pop("id", None)
        for shape in new["shapes"]:
            shape.pop("id", None)
        body["annotations"]["tracks"].insert(0, new)
        saved = save_with_frames(self.job.id, body, lambda j: None)
        self.assertEqual(saved["tracks"][1]["id"], self.baseline["tracks"][0]["id"])
        self.assertNotEqual(saved["tracks"][0]["id"], saved["tracks"][1]["id"])
        self.assertEqual(save_with_frames(self.job.id, body, lambda j: None), saved)

    def test_revision_is_independent_of_database_list_order(self):
        from cvat.apps.engine.frame_deletion import snapshot_revision

        original = get_job_data(self.job.id)
        original["tracks"][0]["attributes"] = [
            {"spec_id": 100, "value": "first"},
            {"spec_id": 101, "value": "second"},
        ]
        reordered = deepcopy(original)
        reordered["tracks"][0]["shapes"].reverse()
        reordered["tracks"][0]["attributes"].reverse()
        self.assertEqual(
            snapshot_revision(self.job, original), snapshot_revision(self.job, reordered)
        )
        reordered["tracks"][0]["shapes"][0]["points"][0] += 1
        self.assertNotEqual(
            snapshot_revision(self.job, original), snapshot_revision(self.job, reordered)
        )

    def make_validation_pool(self):
        models.ValidationLayout.objects.create(
            task_data=self.data,
            mode=models.ValidationMode.GT_POOL,
            frames=[0, 1, 2],
            disabled_frames=[],
        )
        segment = models.Segment.objects.create(task=self.task, start_frame=0, stop_frame=2)
        gt = models.Job.objects.create(segment=segment, type=models.JobType.GROUND_TRUTH)
        models.Image.objects.create(
            data=self.data, frame=3, real_frame=1, is_placeholder=True, width=100, height=100
        )
        self.data.deleted_frames = [10]
        self.data.save()
        return gt

    def test_validation_pool_preserves_shapes_and_other_deleted_frames(self):
        point = dict(
            self.track()["shapes"][0], frame=3, label_id=self.label.id, group=0, source="manual"
        )
        put_job_data(self.job.id, {"tags": [], "tracks": [], "shapes": [point]})
        original = get_job_data(self.job.id)
        gt = self.make_validation_pool()
        baseline = checkpoint(gt.id, get_job_data(gt.id))
        body = dict(
            annotations={k: baseline[k] for k in ("tracks", "shapes", "tags")},
            deleted_frames=[1],
            baseline_revision=baseline["frame_save_revision"],
        )
        save_with_frames(gt.id, body, lambda j: None)
        self.data.refresh_from_db()
        self.assertEqual(self.data.deleted_frames, [1, 3, 10])
        self.assertEqual(get_job_data(self.job.id), original)
        baseline = checkpoint(gt.id, get_job_data(gt.id))
        body.update(deleted_frames=[], baseline_revision=baseline["frame_save_revision"])
        save_with_frames(gt.id, body, lambda j: None)
        self.data.refresh_from_db()
        self.assertEqual(self.data.deleted_frames, [10])
        self.assertEqual(get_job_data(self.job.id), original)

    def test_legacy_validation_pool_deletion_cannot_bypass_placeholder_repair(self):
        gt = self.make_validation_pool()
        serializer = JobDataMetaWriteSerializer(gt, data={"deleted_frames": [1]})
        serializer.is_valid(raise_exception=True)
        with self.assertRaises(ValidationError):
            serializer.save()
        self.data.refresh_from_db()
        self.assertEqual(self.data.deleted_frames, [10])
        self.assertEqual(self.data.validation_layout.disabled_frames, [])


from django.test import TransactionTestCase
from django.db import connection, close_old_connections
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless


class FrameSaveConcurrencyTests(TransactionTestCase):
    setUp = FrameSaveTests.setUp
    track = FrameSaveTests.track
    request = FrameSaveTests.request

    @skipUnless(connection.vendor == "postgresql", "Requires real PostgreSQL row locks")
    def test_concurrent_frame_saves_serialize_and_reject_stale_second_writer(self):
        barrier = Barrier(2)
        bodies = [self.request(deleted=(3,)), self.request(deleted=(7,))]

        def save(body):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                return save_with_frames(self.job.id, body, lambda j: None)[
                    "frame_save_deleted_frames"
                ]
            except StaleFrameSave:
                return "stale"
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, bodies))
        self.assertEqual(results.count("stale"), 1)
        self.data.refresh_from_db()
        self.assertIn(self.data.deleted_frames, ([3], [7]))
        self.assertEqual(models.LabeledTrack.objects.filter(job=self.job).count(), 1)
