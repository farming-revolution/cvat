# Copyright (C) 2026 Farming Revolution
# SPDX-License-Identifier: MIT
"""Offline browser/export/worker parity fixtures from the two original incidents."""
import json
from pathlib import Path
import unittest
from cvat.apps.engine.track_frame_boundaries import repair_track
from cvat.apps.dataset_manager.annotation import TrackManager


class BoundaryReplayTests(unittest.TestCase):
    def test_original_incidents_match_backend_export_and_worker_after_repair(self):
        fixtures = json.loads(
            (Path(__file__).parents[1] / "unit/fixtures/frame-boundary-incidents.json").read_text()
        )
        count = 0
        for case in fixtures:
            with self.subTest(incident=case["incident"], track=case["track"]["id"]):
                repaired = repair_track(case["track"], case["frames"], set(case["deleted"]))
                self.assertEqual(repaired["id"], case["track"]["id"])
                self.assertEqual(repaired["attributes"], case["track"]["attributes"])
                self.assertFalse(any(s["frame"] in case["deleted"] for s in repaired["shapes"]))
                actual = list(
                    TrackManager.get_interpolated_shapes(
                        repaired,
                        min(case["frames"]),
                        max(case["frames"]) + 1,
                        "2d",
                        deleted_frames=case["deleted"],
                    )
                )
                actual = {
                    s["frame"]: s
                    for s in actual
                    if not s["outside"] and s["frame"] not in case["deleted"]
                }
                self.assertEqual(set(actual), {s["frame"] for s in case["expected"]})
                for expected in case["expected"]:
                    state = actual[expected["frame"]]
                    for a, b in zip(state["points"], expected["points"]):
                        self.assertAlmostEqual(a, b, places=8)
                    self.assertEqual(state["occluded"], expected["occluded"])
                    self.assertEqual(
                        {a["spec_id"]: a["value"] for a in state["attributes"]},
                        {a["spec_id"]: a["value"] for a in expected["attributes"]},
                    )
                    count += 1
        self.assertEqual(count, 1947)
