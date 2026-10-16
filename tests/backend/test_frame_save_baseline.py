# Copyright (C) 2026 Farming Revolution
# SPDX-License-Identifier: MIT
"""Normal saves must not acknowledge changes the caller has never loaded."""
from copy import deepcopy
from types import SimpleNamespace

from django.test import TestCase
from cvat.apps.engine.frame_deletion import (
    annotation_write_with_baseline, checkpoint, save_with_frames, StaleFrameSave,
)
from cvat.apps.engine.track_frame_boundaries import repair_track
from cvat.apps.dataset_manager.task import get_job_data, put_job_data, patch_job_data, PatchAction
from tests.backend.test_frame_save import FrameSaveTests


class BaselineTests(TestCase):
    setUp = FrameSaveTests.setUp
    track = FrameSaveTests.track

    def normal(self, payload, baseline, action=PatchAction.UPDATE):
        return annotation_write_with_baseline(self.job, baseline, lambda: patch_job_data(self.job.id, payload, action))

    def full_request(self, local, baseline):
        desired = deepcopy(local)
        desired['tracks'] = [repair_track(t, list(range(12)), {3}) for t in desired['tracks']]
        return dict(annotations=desired, deleted_frames=[3], baseline_revision=baseline)

    def test_unseen_update_addition_and_deletion_cannot_be_acknowledged_by_unrelated_save(self):
        for remote_action in (PatchAction.UPDATE, PatchAction.CREATE, PatchAction.DELETE):
            with self.subTest(remote_action=remote_action):
                put_job_data(self.job.id, dict(tags=[], shapes=[], tracks=[self.track(), self.track()]))
                initial = checkpoint(self.job.id, get_job_data(self.job.id))
                baseline = initial['frame_save_revision']
                local = {k: deepcopy(initial[k]) for k in ('tags', 'shapes', 'tracks')}
                other = deepcopy(local['tracks'][1])
                other['shapes'][0]['points'] = [999., 999.]
                if remote_action == PatchAction.CREATE:
                    other = self.track()
                patch_job_data(self.job.id, dict(tags=[], shapes=[], tracks=[other]), remote_action)
                local['tracks'][0]['shapes'][0]['points'] = [50., 50.]
                response, headers = self.normal(dict(tags=[], shapes=[], tracks=[local['tracks'][0]]), baseline)
                self.assertEqual(headers, {})
                self.assertEqual(len(response['tracks']), 1)
                before = get_job_data(self.job.id)
                with self.assertRaises(StaleFrameSave):
                    save_with_frames(self.job.id, self.full_request(local, baseline), lambda job: None)
                self.assertEqual(get_job_data(self.job.id), before)
                self.data.refresh_from_db()
                self.assertEqual(self.data.deleted_frames, [])

    def test_sequential_own_writes_advance_baseline_and_allow_frame_save(self):
        baseline = self.baseline['frame_save_revision']
        local = {k: deepcopy(self.baseline[k]) for k in ('tags', 'shapes', 'tracks')}
        local['tracks'][0]['shapes'][0]['points'] = [50., 50.]
        for action, tracks in ((PatchAction.UPDATE, local['tracks']), (PatchAction.CREATE, [self.track()])):
            _, headers = self.normal(dict(tags=[], shapes=[], tracks=tracks), baseline, action)
            self.assertEqual(headers['X-CVAT-Frame-Save-Parent-Revision'], baseline)
            baseline = headers['X-CVAT-Frame-Save-Revision']
        local = get_job_data(self.job.id)
        _, headers = self.normal(dict(tags=[], shapes=[], tracks=[local['tracks'].pop()]), baseline, PatchAction.DELETE)
        self.assertEqual(headers['X-CVAT-Frame-Save-Parent-Revision'], baseline)
        saved = save_with_frames(self.job.id, self.full_request(local, headers['X-CVAT-Frame-Save-Revision']), lambda job: None)
        self.assertEqual(saved['frame_save_deleted_frames'], [3])
        self.assertEqual(saved['tracks'][0]['shapes'][0]['points'], [50., 50.])

    def test_lost_normal_response_retry_does_not_certify_a_stale_snapshot(self):
        baseline = self.baseline['frame_save_revision']
        changed = deepcopy(self.baseline['tracks'][0])
        changed['shapes'][0]['points'] = [50., 50.]
        payload = dict(tags=[], shapes=[], tracks=[changed])
        self.normal(payload, baseline)  # committed; response lost
        _, headers = self.normal(payload, baseline)
        self.assertEqual(headers, {})
        with self.assertRaises(StaleFrameSave):
            save_with_frames(self.job.id, self.full_request(payload, baseline), lambda job: None)
        self.assertEqual(len(get_job_data(self.job.id)['tracks']), 1)

    def test_missing_and_malformed_baselines_preserve_legacy_patch_body(self):
        payload = dict(tags=[], shapes=[], tracks=[deepcopy(self.baseline['tracks'][0])])
        for baseline in (None, '', 'bad', 'bad:bad', 'a:b:c'):
            response, headers = self.normal(payload, baseline)
            self.assertEqual(headers, {})
            self.assertEqual(set(response), {'version', 'tags', 'shapes', 'tracks'})

    def test_endpoint_requires_verified_parent_before_returning_revision_headers(self):
        from cvat.apps.engine.views import JobViewSet
        view = JobViewSet()
        view.get_object = lambda: self.job
        request = SimpleNamespace(method='PATCH', query_params={'action': 'update'},
            data=dict(tags=[], shapes=[], tracks=deepcopy(self.baseline['tracks'])),
            headers={'X-CVAT-Frame-Save-Baseline': self.baseline['frame_save_revision']})
        view.request = request
        response = view.annotations(request, self.job.id)
        self.assertEqual(response['X-CVAT-Frame-Save-Parent-Revision'], self.baseline['frame_save_revision'])
        self.assertEqual(set(response.data), {'version', 'tags', 'shapes', 'tracks'})
        request.headers = {}
        response = view.annotations(request, self.job.id)
        self.assertNotIn('X-CVAT-Frame-Save-Revision', response)
        self.assertNotIn('X-CVAT-Frame-Save-Parent-Revision', response)

    def test_verified_full_replacement_allows_subsequent_frame_save(self):
        response, headers = annotation_write_with_baseline(self.job, self.baseline['frame_save_revision'],
            lambda: put_job_data(self.job.id, dict(tags=[], shapes=[], tracks=[self.track()])))
        self.assertEqual(headers['X-CVAT-Frame-Save-Parent-Revision'], self.baseline['frame_save_revision'])
        saved = save_with_frames(self.job.id, self.full_request(response, headers['X-CVAT-Frame-Save-Revision']), lambda job: None)
        self.assertEqual(saved['frame_save_deleted_frames'], [3])

    def test_failed_verified_write_rolls_back_without_advancing_anything(self):
        original = get_job_data(self.job.id)
        def failing_write():
            patch_job_data(self.job.id, dict(tags=[], shapes=[], tracks=[self.track()]), PatchAction.CREATE)
            raise ValueError('simulated failure')
        with self.assertRaisesMessage(ValueError, 'simulated failure'):
            annotation_write_with_baseline(self.job, self.baseline['frame_save_revision'], failing_write)
        self.assertEqual(get_job_data(self.job.id), original)

    def test_combined_retry_after_external_edit_rejects_without_duplicates(self):
        body = self.full_request(self.baseline, self.baseline['frame_save_revision'])
        body['annotations']['tracks'].append(repair_track(self.track(), list(range(12)), {3}))
        saved = save_with_frames(self.job.id, body, lambda job: None)
        track = deepcopy(saved['tracks'][0])
        track['shapes'][0]['points'] = [999., 999.]
        patch_job_data(self.job.id, dict(tags=[], shapes=[], tracks=[track]), PatchAction.UPDATE)
        before = get_job_data(self.job.id)
        with self.assertRaises(StaleFrameSave):
            save_with_frames(self.job.id, body, lambda job: None)
        self.assertEqual(get_job_data(self.job.id), before)
        self.assertEqual(len(before['tracks']), 2)

    def test_pre_fix_tokens_cannot_authorize_full_save_even_if_server_digest_matches(self):
        from cvat.apps.engine.frame_deletion import annotation_digest
        # The old browser could receive this exact current digest without loading
        # its objects. Merely checking its hash again would retain the old bug.
        old = annotation_digest(get_job_data(self.job.id)) + ':' + self.baseline['frame_save_revision'].split(':')[1]
        payload = dict(tags=[], shapes=[], tracks=deepcopy(self.baseline['tracks']))
        _, headers = self.normal(payload, old)
        self.assertEqual(headers, {})
        with self.assertRaises(StaleFrameSave):
            save_with_frames(self.job.id, self.full_request(payload, old), lambda job: None)
        self.data.refresh_from_db()
        self.assertEqual(self.data.deleted_frames, [])


from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest import skipUnless
from django.test import TransactionTestCase
from django.db import connection, close_old_connections


class BaselineConcurrencyTests(TransactionTestCase):
    setUp = FrameSaveTests.setUp
    track = FrameSaveTests.track
    full_request = BaselineTests.full_request

    @skipUnless(connection.vendor == 'postgresql', 'Requires real PostgreSQL row locks')
    def test_normal_save_proof_and_external_writer_are_serialized(self):
        inside_write, external_started = Event(), Event()
        local = {k: deepcopy(self.baseline[k]) for k in ('tracks', 'shapes', 'tags')}
        local['tracks'][0]['shapes'][0]['points'] = [50., 50.]
        external = deepcopy(local)
        external['tracks'][0]['shapes'][0]['points'] = [999., 999.]
        def own_writer():
            close_old_connections()
            try:
                def write():
                    inside_write.set()
                    self.assertTrue(external_started.wait(10))
                    return patch_job_data(self.job.id, local, PatchAction.UPDATE)
                return annotation_write_with_baseline(self.job, self.baseline['frame_save_revision'], write)
            finally:
                close_old_connections()
        def other_writer():
            close_old_connections()
            try:
                self.assertTrue(inside_write.wait(10))
                external_started.set()
                patch_job_data(self.job.id, external, PatchAction.UPDATE)
            finally:
                close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:
            own = pool.submit(own_writer)
            other = pool.submit(other_writer)
            response, headers = own.result(timeout=20)
            other.result(timeout=20)
        self.assertEqual(headers['X-CVAT-Frame-Save-Parent-Revision'], self.baseline['frame_save_revision'])
        with self.assertRaises(StaleFrameSave):
            save_with_frames(self.job.id, self.full_request(response, headers['X-CVAT-Frame-Save-Revision']), lambda job: None)
        self.assertEqual(get_job_data(self.job.id)['tracks'][0]['shapes'][0]['points'], [999., 999.])


class BaselineCorsTests(TestCase):
    def test_allowed_ui_can_send_baseline_and_read_proof_headers(self):
        from django.test import RequestFactory, override_settings
        from django.http import HttpResponse
        from corsheaders.middleware import CorsMiddleware
        factory = RequestFactory()
        origin = 'https://allowed-ui.example'
        middleware = CorsMiddleware(lambda request: HttpResponse())
        with override_settings(CORS_ALLOWED_ORIGINS=[origin], CORS_ALLOW_ALL_ORIGINS=False):
            response = middleware(factory.options('/api/jobs/1/annotations',
                HTTP_ORIGIN=origin, HTTP_ACCESS_CONTROL_REQUEST_METHOD='PATCH',
                HTTP_ACCESS_CONTROL_REQUEST_HEADERS='content-type,x-cvat-frame-save-baseline'))
            self.assertEqual(response['Access-Control-Allow-Origin'], origin)
            self.assertIn('x-cvat-frame-save-baseline', response['Access-Control-Allow-Headers'].lower())
            response = middleware(factory.patch('/api/jobs/1/annotations', HTTP_ORIGIN=origin))
            self.assertIn('x-cvat-frame-save-parent-revision', response['Access-Control-Expose-Headers'].lower())
            self.assertIn('x-cvat-frame-save-revision', response['Access-Control-Expose-Headers'].lower())
            denied = middleware(factory.options('/api/jobs/1/annotations', HTTP_ORIGIN='https://untrusted.example',
                HTTP_ACCESS_CONTROL_REQUEST_METHOD='PATCH', HTTP_ACCESS_CONTROL_REQUEST_HEADERS='x-cvat-frame-save-baseline'))
            self.assertNotIn('Access-Control-Allow-Origin', denied)
