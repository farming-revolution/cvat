# Copyright (C) 2026 Farming Revolution
# SPDX-License-Identifier: MIT
"""Pure storage tests: no services, credentials or database required."""
import concurrent.futures
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

source = Path(__file__).parents[2] / 'cvat/apps/engine/height_diagnostic.py'
if not source.exists():  # isolated server image stores the tests separately
    source = Path.cwd() / 'cvat/apps/engine/height_diagnostic.py'
spec = importlib.util.spec_from_file_location('height_diagnostic', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class HeightDiagnosticTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        fixture = json.loads((Path(__file__).parents[1] / 'unit/fixtures/height-projection.json').read_text())[0]['metadata']
        self.catalog = {k: fixture[k] for k in ('version', 'task_id', 'data_id', 'frame_fingerprint', 'frames', 'deleted_frames')}
        self.bag = dict(fixture['bags'][0], target_frame='ground')
        self.payload = {k: fixture[k] for k in ('version', 'task_id', 'data_id', 'frame_fingerprint')}
        self.payload['bag'] = self.bag

    def test_optional_atomic_idempotent_storage(self):
        before = copy.deepcopy(self.catalog)
        self.assertEqual(module.read_document(self.tmp.name, self.catalog)['status'], 'missing')
        self.assertTrue(module.write_bag(self.tmp.name, self.catalog, self.payload))
        path = Path(self.tmp.name) / module.FILENAME
        stamp = path.stat().st_mtime_ns
        self.assertFalse(module.write_bag(self.tmp.name, self.catalog, self.payload))
        self.assertEqual(stamp, path.stat().st_mtime_ns)
        self.assertEqual(module.read_document(self.tmp.name, self.catalog)['bags'], [self.bag])
        self.assertEqual(self.catalog, before)

    def test_invalid_updates_leave_existing_document_unchanged(self):
        module.write_bag(self.tmp.name, self.catalog, self.payload)
        path = Path(self.tmp.name) / module.FILENAME
        original = path.read_bytes()
        mutations = [lambda p: p.update(version=2), lambda p: p.update(data_id=55),
                     lambda p: p.update(frame_fingerprint='changed'),
                     lambda p: p['bag'].update(horizontal_height_m=-1),
                     lambda p: p['bag']['frames'][0].update(name='other.png'),
                     lambda p: p['bag']['frames'][0]['projection'].__setitem__(0, float('nan')),
                     lambda p: p['bag']['frames'].append(p['bag']['frames'][0])]
        for mutate in mutations:
            bad = copy.deepcopy(self.payload)
            mutate(bad)
            with self.assertRaises(ValueError):
                module.write_bag(self.tmp.name, self.catalog, bad)
            self.assertEqual(path.read_bytes(), original)

    def test_concurrent_disjoint_bags_and_overlap_rejection(self):
        payloads = []
        for i in range(3):
            p = copy.deepcopy(self.payload)
            p['bag']['bag_id'] = i + 1
            p['bag']['frames'] = p['bag']['frames'][i*3:(i+1)*3]
            payloads.append(p)
        with concurrent.futures.ThreadPoolExecutor() as pool:
            list(pool.map(lambda p: module.write_bag(self.tmp.name, self.catalog, p), payloads))
        self.assertEqual(len(module.read_document(self.tmp.name, self.catalog)['bags']), 3)
        with self.assertRaises(ValueError):
            module.write_bag(self.tmp.name, self.catalog, self.payload)

    def test_stale_and_corrupt_documents_disable_reading(self):
        module.write_bag(self.tmp.name, self.catalog, self.payload)
        self.assertEqual(module.read_document(self.tmp.name, dict(self.catalog, data_id=99))['status'], 'stale')
        (Path(self.tmp.name) / module.FILENAME).write_text('broken')
        self.assertEqual(module.read_document(self.tmp.name, self.catalog)['status'], 'invalid')
        with self.assertRaises(ValueError):
            module.write_bag(self.tmp.name, self.catalog, self.payload)
        self.assertEqual((Path(self.tmp.name) / module.FILENAME).read_text(), 'broken')

    def test_refresh_preserves_other_bags_and_rejects_inconsistent_catalogues(self):
        first = copy.deepcopy(self.payload)
        first['bag']['frames'] = first['bag']['frames'][:4]
        second = copy.deepcopy(self.payload)
        second['bag']['bag_id'] = 2
        second['bag']['frames'] = second['bag']['frames'][4:]
        module.write_bag(self.tmp.name, self.catalog, first)
        module.write_bag(self.tmp.name, self.catalog, second)
        catalog = dict(self.catalog, frame_fingerprint='after-delete', deleted_frames=[0])
        first['frame_fingerprint'] = catalog['frame_fingerprint']
        module.write_bag(self.tmp.name, catalog, first)
        self.assertEqual(len(module.read_document(self.tmp.name, catalog)['bags']), 2)
        path = Path(self.tmp.name) / module.FILENAME
        before = path.read_bytes()
        incompatible = copy.deepcopy(catalog)
        incompatible['frame_fingerprint'] = 'renamed-foreign-frame'
        incompatible['frames'][5]['name'] = 'different.png'
        first['frame_fingerprint'] = incompatible['frame_fingerprint']
        with self.assertRaises(ValueError):
            module.write_bag(self.tmp.name, incompatible, first)
        self.assertEqual(before, path.read_bytes())

    def test_frame_catalogue_uses_annotation_indices_and_tracks_frame_step(self):
        from types import SimpleNamespace
        images = [SimpleNamespace(path=f['name'], width=f['width'], height=f['height']) for f in self.catalog['frames']]
        data = SimpleNamespace(id=2, size=9, start_frame=10, stop_frame=26, deleted_frames=[2],
                               get_frame_step=lambda: 2, images=SimpleNamespace(order_by=lambda _: images))
        task = SimpleNamespace(id=3, data=data)
        result = module.catalogue(task)
        self.assertEqual([f['frame'] for f in result['frames']], list(range(9)))
        self.assertEqual(result['frame_step'], 2)
        data.deleted_frames = [3]
        self.assertNotEqual(result['frame_fingerprint'], module.catalogue(task)['frame_fingerprint'])


if __name__ == '__main__':
    unittest.main()
