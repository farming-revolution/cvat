# Copyright (C) CVAT.ai Corporation
# SPDX-License-Identifier: MIT
"""Pure track repair shared by frame saves and their offline verification."""
from copy import deepcopy


def state_at(track, frame):
    shapes = sorted(track["shapes"], key=lambda s: s["frame"])
    left = next((s for s in reversed(shapes) if s["frame"] <= frame), None)
    right = next((s for s in shapes if s["frame"] > frame), None)
    source = left or right
    result = deepcopy(source)
    result.pop("id", None)
    result["frame"] = frame
    result["outside"] = left is None or source["outside"]
    attributes = {}
    for shape in shapes:
        if shape["frame"] > frame:
            break
        attributes.update({a["spec_id"]: deepcopy(a) for a in shape.get("attributes", [])})
    result["attributes"] = list(attributes.values())
    if left is not None and right is not None:
        ratio = (frame - left["frame"]) / (right["frame"] - left["frame"])
        result["points"] = [a + (b - a) * ratio for a, b in zip(left["points"], right["points"])]
        if source["type"] == "rectangle":
            angle = (right.get("rotation", 0) - left.get("rotation", 0) + 180) % 360 - 180
            # CVAT chooses +180 for the exactly opposite-angle case.
            if angle == -180:
                angle = 180
            result["rotation"] = (left.get("rotation", 0) + angle * ratio + 360) % 360
    return result


def required_boundaries(frames, deleted, keys):
    required = set()
    index = 0
    while index < len(frames):
        if frames[index] not in deleted:
            index += 1
            continue
        start = index
        affected = False
        while index < len(frames) and frames[index] in deleted:
            affected = affected or frames[index] in keys
            index += 1
        if affected:
            if start:
                required.add(frames[start - 1])
            if index < len(frames):
                required.add(frames[index])
    return required


def repair_track(track, frames, deleted, previously_deleted=()):
    if any(has_deleted_keyframe(element, deleted) for element in track.get("elements", [])):
        raise ValueError(
            "Frame deletion cannot repair skeleton tracks; relocate their keyframes first"
        )
    active = sorted(
        (s for s in track["shapes"] if s["frame"] not in previously_deleted),
        key=lambda s: s["frame"],
    )
    left = -1
    visible = set()
    for frame in frames:
        while left + 1 < len(active) and active[left + 1]["frame"] <= frame:
            left += 1
        if left >= 0 and not active[left]["outside"]:
            visible.add(frame)
    remains_visible = bool(visible - set(deleted))
    if not has_deleted_keyframe(track, deleted) and (remains_visible or not visible):
        return deepcopy(track)
    if track.get("elements") or any(
        s["type"] not in ("points", "rectangle")
        or len(s["points"]) != (2 if s["type"] == "points" else 4)
        for s in track["shapes"]
    ):
        raise ValueError("Frame deletion preserves single-point and rectangle tracks only")
    geometry = dict(
        track,
        shapes=[s for s in track["shapes"] if s["frame"] not in previously_deleted],
    )
    if not geometry["shapes"]:
        return None
    if not remains_visible:
        return None
    first = min(s["frame"] for s in track["shapes"])
    shapes = {s["frame"]: deepcopy(s) for s in track["shapes"] if s["frame"] not in deleted}
    boundaries = required_boundaries(frames, deleted, {s["frame"] for s in track["shapes"]})
    for index, frame in enumerate(frames):
        if frame not in boundaries or frame < first:
            continue
        if (index and frames[index - 1] in deleted) or (
            index + 1 < len(frames) and frames[index + 1] in deleted
        ):
            existing_id = shapes.get(frame, {}).get("id")
            shapes[frame] = state_at(geometry, frame)
            shapes[frame]["attributes"] = state_at(track, frame)["attributes"]
            if existing_id is not None:
                shapes[frame]["id"] = existing_id
    result = deepcopy(track)
    result["shapes"] = [shapes[f] for f in sorted(shapes)]
    result["frame"] = min(shapes)
    return result


def has_deleted_keyframe(track, deleted):
    return any(s["frame"] in deleted for s in track["shapes"]) or any(
        has_deleted_keyframe(e, deleted) for e in track.get("elements", [])
    )
