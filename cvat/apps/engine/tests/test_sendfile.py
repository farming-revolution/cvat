# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

import asyncio
import tempfile
import unittest
from pathlib import Path

from django.conf import settings
from django.core.handlers.asgi import ASGIHandler
from django.http import Http404
from django.middleware.common import CommonMiddleware
from django.middleware.gzip import GZipMiddleware
from django.test import RequestFactory, override_settings
from django_sendfile.utils import _get_sendfile

from cvat.utils.sendfile import sendfile


class TestSendfile(unittest.TestCase):
    def setUp(self):
        _get_sendfile.cache_clear()
        self.addCleanup(_get_sendfile.cache_clear)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.file = self.root / "annotations.zip"
        self.payload = b"annotation archive content" * 100
        self.file.write_bytes(self.payload)
        self.config = override_settings(
            SENDFILE_BACKEND="django_sendfile.backends.nginx",
            SENDFILE_ROOT=str(self.root),
            SENDFILE_URL="/data",
        )
        self.config.enable()
        self.addCleanup(self.config.disable)
        self.request = RequestFactory().get("/download", HTTP_ACCEPT_ENCODING="gzip")

    def response(self):
        return sendfile(self.request, self.file, attachment=True, mimetype="application/zip")

    def test_nginx_redirect_has_empty_upstream_body_and_matching_length(self):
        response = self.response()
        self.assertEqual(response["X-Accel-Redirect"], "/data/annotations.zip")
        self.assertEqual(response.content, b"")
        self.assertEqual(response["Content-Length"], "0")
        self.assertEqual(response["Content-Type"], "application/zip")
        self.assertIn('filename="annotations.zip"', response["Content-Disposition"])

    def test_asgi_response_length_matches_body_after_middleware(self):
        response = self.response()
        for middleware in (CommonMiddleware, GZipMiddleware):
            response = middleware(lambda request: response).process_response(self.request, response)
        messages = []

        async def send(message):
            messages.append(message)

        asyncio.run(ASGIHandler().send_response(response, send))
        headers = {key.lower(): value for key, value in messages[0]["headers"]}
        body = b"".join(message.get("body", b"") for message in messages[1:])
        self.assertEqual(int(headers[b"content-length"]), len(body))
        self.assertNotIn(b"content-encoding", headers)

    @override_settings(SENDFILE_BACKEND="django_sendfile.backends.simple")
    def test_direct_file_response_keeps_real_length_and_content(self):
        response = self.response()
        self.addCleanup(response.close)
        self.assertFalse(response.has_header("X-Accel-Redirect"))
        self.assertEqual(int(response["Content-Length"]), len(self.payload))
        content = b"".join(response.streaming_content) if response.streaming else response.content
        self.assertEqual(content, self.payload)

    def test_missing_file_still_returns_not_found(self):
        with self.assertRaises(Http404):
            sendfile(self.request, self.root / "missing.zip")


if __name__ == "__main__":
    # Standalone regression checks need neither CVAT services nor a database.
    settings.configure(DEFAULT_CHARSET="utf-8", MIDDLEWARE=[], ALLOWED_HOSTS=["testserver"])
    unittest.main()
