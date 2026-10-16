# Copyright (C) CVAT.ai Corporation
# SPDX-License-Identifier: MIT
"""Atomic annotation/frame saves; no migration or persistent repair archive."""
import hashlib
import json
from copy import deepcopy

from django.db import transaction
from rest_framework.exceptions import APIException, ValidationError

from cvat.apps.engine import models
from cvat.apps.engine.track_frame_boundaries import repair_track, has_deleted_keyframe

KINDS = ("tags", "shapes", "tracks")


class StaleFrameSave(APIException):
    status_code = 409
    default_detail = "Annotations or frames changed on the server. Local edits were kept; reload and review before saving."


def lock_task_for_job(job_id):
    task_id = models.Job.objects.values_list("segment__task_id", flat=True).get(pk=job_id)
    models.Task.objects.select_for_update().get(pk=task_id)
    return task_id


def job_frames(job):
    data = job.segment.task.data
    return sorted((f - data.start_frame) // data.get_frame_step() for f in job.segment.frame_set)


def semantic(item):
    """Compare API and core representations, ignoring nested database IDs/default omissions."""
    result = {
        key: item.get(key, default)
        for key, default in (
            ("frame", None),
            ("label_id", None),
            ("group", 0),
            ("source", None),
            ("type", None),
            ("points", []),
            ("rotation", 0),
            ("occluded", False),
            ("outside", False),
            ("z_order", 0),
            ("descriptions", []),
            ("score", 1),
        )
    }
    result["group"] = result["group"] or 0
    result["attributes"] = sorted(
        ({"spec_id": a["spec_id"], "value": a["value"]} for a in item.get("attributes", [])),
        key=lambda a: a["spec_id"],
    )
    result["elements"] = [semantic(v) for v in item.get("elements", [])]
    result["shapes"] = [
        semantic(v) for v in sorted(item.get("shapes", []), key=lambda s: s["frame"])
    ]
    return result


def matched_snapshot(actual, desired):
    ordered = {"version": actual.get("version", 0)}
    for kind in KINDS:
        available = list(actual.get(kind, []))
        reserved = {v["id"] for v in desired.get(kind, []) if v.get("id") is not None}
        ordered[kind] = []
        for item in desired.get(kind, []):
            match = next(
                (
                    v
                    for v in available
                    if (
                        (
                            v.get("id") not in reserved
                            if item.get("id") is None
                            else item["id"] == v.get("id")
                        )
                        and semantic(item) == semantic(v)
                    )
                ),
                None,
            )
            if match is None:
                return None
            available.remove(match)
            ordered[kind].append(match)
        if available:
            return None
    return ordered


def snapshot_revision(job, annotations):
    # Content, not status/assignment timestamps: marking a saved job in progress
    # must not make its next frame save stale. Include overlapping saved tracks.
    from cvat.apps.dataset_manager.task import get_job_data

    task = job.segment.task
    data = models.Data.objects.get(pk=task.data_id)
    frames = set(job_frames(job))
    overlaps = []
    for other in (
        models.Job.objects.filter(segment__task=task)
        .select_related(
            "segment__task__data",
        )
        .order_by("pk")
    ):
        if other.id != job.id and frames.intersection(job_frames(other)):
            overlaps.append((other.id, get_job_data(other.id)))
    labels = task.project.label_set if task.project_id else task.label_set
    value = {
        "overlaps": overlaps,
        "deleted": sorted(set(data.deleted_frames) & frames),
        "data": [
            data.pk,
            data.start_frame,
            data.stop_frame,
            data.frame_filter,
            sorted(frames),
        ],
        "labels": list(labels.order_by("id").values()),
        "attributes": list(
            models.AttributeSpec.objects.filter(label__in=labels.all()).order_by("id").values()
        ),
        "validation_disabled": sorted(
            set(
                getattr(
                    getattr(data, "validation_layout", None),
                    "disabled_frames",
                    [],
                )
            )
            & frames
        ),
    }

    def digest(document):
        def canonical(value, field=None):
            if isinstance(value, dict):
                return {key: canonical(item, key) for key, item in value.items()}
            if isinstance(value, (list, tuple)):
                items = [canonical(item) for item in value]
                if field in ("attributes", "tracks", "shapes", "tags", "elements"):
                    # DB readback uses sets for some attributes, and equal-frame
                    # objects need not have a stable query order across workers.
                    items.sort(
                        key=lambda item: (
                            item.get("frame", -1),
                            item.get("spec_id", item.get("id", -1)),
                            str(item.get("value", "")),
                        )
                    )
                return items
            return value

        return hashlib.sha256(
            json.dumps(canonical(document), sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()

    return digest(annotations) + ":" + digest(value)


def with_attribute_defaults(snapshot, job):
    """Use the same defaults/inheritance as JobAnnotation.init_from_db()."""
    from cvat.apps.dataset_manager.task import JobAnnotation

    defaults = JobAnnotation(job.id).db_attributes

    def fill(item, inherited):
        values = {a["spec_id"]: dict(a) for a in inherited}
        values.update({a["spec_id"]: a for a in item.get("attributes", [])})
        item["attributes"] = list(values.values())

    def visit(item, track):
        if item["label_id"] not in defaults:
            raise ValidationError("Unknown label ID")
        label = defaults[item["label_id"]]
        fill(item, label["immutable" if track else "all"].values())
        if track:
            inherited = label["mutable"].values()
            for shape in sorted(item["shapes"], key=lambda s: s["frame"]):
                fill(shape, inherited)
                inherited = shape["attributes"]
        for element in item.get("elements", []):
            visit(element, track)

    for kind in KINDS:
        for item in snapshot[kind]:
            visit(item, kind == "tracks")
    return snapshot


def checkpoint(job_id, response):
    from cvat.apps.dataset_manager.task import get_job_data

    job = models.Job.objects.select_related("segment__task__data").get(pk=job_id)
    full = get_job_data(job_id)
    deleted = set(job.segment.task.data.deleted_frames)
    if job.type == models.JobType.GROUND_TRUTH:
        deleted.update(job.segment.task.data.validation_layout.disabled_frames)
    return dict(
        response,
        frame_save_revision=snapshot_revision(job, full),
        frame_save_deleted_frames=sorted(deleted & set(job_frames(job))),
    )


def guard_legacy_deletion(task, deleted, jobs=None):
    from cvat.apps.dataset_manager.task import get_job_data

    if not deleted:
        return
    for job in jobs if jobs is not None else models.Job.objects.filter(segment__task=task):
        previous = set(job.segment.task.data.deleted_frames)
        if job.type == models.JobType.GROUND_TRUTH:
            previous.update(job.segment.task.data.validation_layout.disabled_frames)
        for track in get_job_data(job.id)["tracks"]:
            try:
                needs_repair = (
                    repair_track(track, job_frames(job), previous | deleted, previous) != track
                )
            except ValueError:
                needs_repair = True
            if needs_repair:
                raise ValidationError(
                    "Deleting these frames requires track repair. Reload the current CVAT editor and save frames with annotations."
                )


def guard_annotation_keyframes(job, annotations):
    deleted = set(models.Data.objects.get(pk=job.segment.task.data_id).deleted_frames)
    if job.type == models.JobType.GROUND_TRUTH:
        deleted.update(job.segment.task.data.validation_layout.disabled_frames)
    for track in annotations.tracks:
        if has_deleted_keyframe(track, deleted):
            raise ValidationError(
                "Track keyframes cannot be saved on deleted frames. Use the current editor to repair their boundaries."
            )


@transaction.atomic
def save_with_frames(job_id, body, check_permission):
    from cvat.apps.dataset_manager import task as dm
    from cvat.apps.engine.serializers import (
        JobDataMetaWriteSerializer,
        LabeledDataSerializer,
    )

    if not isinstance(body, dict):
        raise ValidationError("Expected an object containing annotations and deleted_frames")
    task_id = lock_task_for_job(job_id)
    jobs = list(
        models.Job.objects.select_for_update(of=("self",))
        .filter(segment__task_id=task_id)
        .select_related(
            "segment__task__data",
        )
        .order_by("pk")
    )
    job = next(j for j in jobs if j.id == int(job_id))
    check_permission(job)
    current = dm.get_job_data(job.id)
    desired = body.get("annotations")
    if not isinstance(desired, dict) or any(not isinstance(desired.get(k), list) for k in KINDS):
        raise ValidationError("Expected a complete annotation snapshot")
    if not isinstance(body.get("baseline_revision"), str):
        raise ValidationError("Missing frame-save baseline revision")
    serializer = LabeledDataSerializer(
        data=desired, context={"annotation_action": dm.PatchAction.UPDATE}
    )
    serializer.is_valid(raise_exception=True)
    desired = with_attribute_defaults(serializer.validated_data, job)
    metadata = JobDataMetaWriteSerializer(
        instance=job,
        data={"deleted_frames": body.get("deleted_frames")},
        context={"atomic_frame_save": True},
    )
    metadata.is_valid(raise_exception=True)
    requested_deleted = set(metadata.validated_data["deleted_frames"])
    before_deleted = set(job.segment.task.data.deleted_frames)
    existing_deleted = before_deleted & set(job_frames(job))
    if job.type == models.JobType.GROUND_TRUTH:
        existing_deleted |= set(job.segment.task.data.validation_layout.disabled_frames) & set(
            job_frames(job)
        )
    if snapshot_revision(job, current) != body["baseline_revision"]:
        # An uncertain HTTP response may be retried. Reconcile the already
        # committed full desired state; never submit its ID-less objects again.
        matched = matched_snapshot(current, desired)
        if requested_deleted == existing_deleted and matched is not None:
            return checkpoint(job.id, matched)
        raise StaleFrameSave()
    for kind in KINDS:
        ids = [v["id"] for v in desired[kind] if v.get("id") is not None]
        if len(ids) != len(set(ids)) or not set(ids) <= {v["id"] for v in current[kind]}:
            raise ValidationError("Unknown or duplicate retained annotation IDs")
    before_per_job = {
        other.id: before_deleted
        | (
            set(other.segment.task.data.validation_layout.disabled_frames)
            if other.type == models.JobType.GROUND_TRUTH
            else set()
        )
        for other in jobs
    }
    metadata.save()
    # Materialize the intended deletion state within this same transaction, then
    # repair every affected job before commit. Other requests cannot see half a save.
    for other in jobs:
        other.segment.task.data.refresh_from_db()
        deleted = set(other.segment.task.data.deleted_frames)
        if other.id != job.id and not ((deleted - before_deleted) & set(job_frames(other))):
            continue
        if other.type == models.JobType.GROUND_TRUTH:
            deleted.update(other.segment.task.data.validation_layout.disabled_frames)
        original = current if other.id == job.id else dm.get_job_data(other.id)
        proposed = deepcopy(desired if other.id == job.id else original)
        repaired = []
        for track in proposed["tracks"]:
            try:
                value = (
                    repair_track(track, job_frames(other), deleted, before_per_job[other.id])
                    if deleted - before_per_job[other.id]
                    else track
                )
            except ValueError as error:
                raise ValidationError(str(error)) from error
            if value is not None:
                repaired.append(value)
        proposed["tracks"] = repaired
        # The editor must have previewed its own complete repair; do not silently
        # change its current snapshot or lose its new-object ordering.
        if other.id == job.id and matched_snapshot(dict(proposed, version=0), desired) is None:
            raise ValidationError(
                "Frame-boundary repair differs from the preview. Local edits were kept; reload and review."
            )
        updates = {k: [] for k in KINDS}
        removals = {k: [] for k in KINDS}
        for kind in KINDS:
            old = {v["id"]: v for v in original[kind]}
            retained = {v["id"] for v in proposed[kind] if v.get("id") is not None}
            removals[kind] = [{"id": key} for key in old.keys() - retained]
            updates[kind] = [
                v
                for v in proposed[kind]
                if v.get("id") is None or semantic(v) != semantic(old[v["id"]])
            ]
        if any(updates.values()) or any(removals.values()):
            check_permission(other)
            if any(updates.values()):
                serializer = LabeledDataSerializer(
                    data=updates, context={"annotation_action": dm.PatchAction.UPDATE}
                )
                serializer.is_valid(raise_exception=True)
                dm.patch_job_data(other.id, serializer.validated_data, dm.PatchAction.UPDATE)
            if any(removals.values()):
                dm.patch_job_data(other.id, removals, dm.PatchAction.DELETE)
    saved = dm.get_job_data(job.id)
    matched = matched_snapshot(saved, desired)
    if matched is None:
        raise ValidationError("Saved annotations did not match the requested snapshot")
    return checkpoint(job.id, matched)
