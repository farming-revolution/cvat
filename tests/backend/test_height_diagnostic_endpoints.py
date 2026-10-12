# Copyright (C) 2026 Farming Revolution
# SPDX-License-Identifier: MIT
"""Run in the server image with --network none; ORM and transactions are mocked.

Tests real routed view methods and scope selection without a database or queues.
"""
import copy
from contextlib import nullcontext
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'cvat.settings.production')
import django
django.setup()
from django.urls import resolve
from cvat.apps.engine import views
from cvat.apps.engine.permissions import TaskPermission, JobPermission


class EndpointsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        fixture = json.loads((Path(__file__).parents[1] / 'unit/fixtures/height-projection.json').read_text())[0]
        self.catalog = {k: fixture['metadata'][k] for k in ('version','task_id','data_id','frame_fingerprint','frames','deleted_frames')}
        self.catalog.update(start_frame=10, stop_frame=26, frame_step=2)
        self.bag = dict(fixture['metadata']['bags'][0], target_frame='ground')
        self.payload = {k:self.catalog[k] for k in ('version','task_id','data_id','frame_fingerprint')}
        self.payload['bag'] = self.bag
        self.task = NS(id=1, data_id=1, data=None, get_dirname=lambda:self.tmp.name, save=Mock())
        self.view = views.TaskViewSet()
        self.view.get_object = Mock(return_value=self.task)

    def test_upload_and_job_subset_do_not_save_models(self):
        with patch.object(views.height_diagnostic, 'catalogue', return_value=self.catalog), \
             patch.object(views.transaction, 'atomic', return_value=nullcontext()), \
             patch.object(views.models.Task.objects, 'select_for_update') as tasks, \
             patch.object(views.models.Data.objects, 'select_for_update') as data:
            tasks.return_value.get.return_value=self.task
            first=self.view.height_diagnostic_metadata(NS(method='PUT', data=self.payload),1)
            self.assertTrue(first.data['changed'])
            self.assertFalse(self.view.height_diagnostic_metadata(NS(method='PUT',data=self.payload),1).data['changed'])
            job=views.JobViewSet()
            job.get_object=Mock(return_value=NS(segment=NS(task=self.task,frame_set={14,16,18})))
            result=job.height_diagnostic_metadata(NS(method='GET'),2)
            self.assertEqual([f['frame'] for f in result.data['frames']],[2,3,4])
            self.assertEqual([f['frame'] for f in result.data['bags'][0]['frames']],[2,3,4])
            self.assertEqual(result['Cache-Control'],'no-store')
            self.task.save.assert_not_called()
            data.return_value.get.return_value.save.assert_not_called()
            self.assertEqual(self.view.get_object.call_count,2)
            job.get_object.assert_called_once()

    def test_scope_selection_matches_existing_metadata_and_data_permissions(self):
        for cls,method,existing,expected in [
            (TaskPermission,'GET','metadata',TaskPermission.Scopes.VIEW_METADATA),
            (TaskPermission,'PUT','metadata',TaskPermission.Scopes.UPDATE_METADATA),
            (JobPermission,'GET','data',JobPermission.Scopes.VIEW_DATA),
        ]:
            request=NS(method=method, query_params={})
            self.assertEqual(cls._get_scopes(request,NS(action='height_diagnostic_metadata'),None),[expected])
        for resource in ('tasks','jobs'):
            match=resolve('/api/'+resource+'/1/height-diagnostic')
            self.assertEqual(match.func.actions['get'],'height_diagnostic_metadata')
            self.assertEqual('put' in match.func.actions,resource=='tasks')

    def test_job_without_covered_frames_stays_missing_until_its_bag_is_uploaded(self):
        payload = copy.deepcopy(self.payload)
        payload['bag']['frames'] = payload['bag']['frames'][:2]
        views.height_diagnostic.write_bag(self.tmp.name, self.catalog, payload)
        path = Path(self.tmp.name) / views.height_diagnostic.FILENAME
        before = path.read_bytes()
        job = views.JobViewSet()
        job.get_object = Mock(return_value=NS(segment=NS(task=self.task, frame_set={14,16,18})))
        with patch.object(views.height_diagnostic, 'catalogue', side_effect=lambda _: copy.deepcopy(self.catalog)):
            result = job.height_diagnostic_metadata(NS(method='GET'), 2)
            self.assertEqual(result.data['status'], 'missing')
            self.assertEqual(result.data['bags'], [])
            self.assertIn('synchronization', result.data['reason'])
            self.assertEqual(result['Cache-Control'], 'no-store')
            self.assertEqual(path.read_bytes(), before)
            payload['bag'] = dict(self.bag, bag_id=2, frames=self.bag['frames'][2:])
            views.height_diagnostic.write_bag(self.tmp.name, self.catalog, payload)
            result = job.height_diagnostic_metadata(NS(method='GET'), 2)
            self.assertEqual(result.data['status'], 'available')
            self.assertEqual([f['frame'] for f in result.data['bags'][0]['frames']], [2,3,4])
            self.assertNotIn('reason', result.data)
        self.task.save.assert_not_called()


if __name__ == '__main__':
    unittest.main()
