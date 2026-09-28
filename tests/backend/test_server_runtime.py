# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

"""Isolated nginx/Uvicorn checks; no CVAT services or database are used.

Run with the server image's dependencies and PYTHONPATH pointing at the checkout:
    python tests/backend/test_server_runtime.py
"""

import asyncio
import concurrent.futures
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.request import Request, urlopen

from django.conf import settings
from django.core.handlers.asgi import ASGIHandler
from django.http import HttpResponse
from django.test import RequestFactory

from cvat.utils.sendfile import sendfile


async def app(scope, receive, send):
    if not settings.configured:
        settings.configure(
            DEFAULT_CHARSET="utf-8", MIDDLEWARE=[],
            SENDFILE_BACKEND="django_sendfile.backends.nginx",
            SENDFILE_ROOT=os.environ["TEST_DATA_ROOT"], SENDFILE_URL="/data",
        )
    if scope["path"] == "/download":
        response = sendfile(
            RequestFactory().generic(scope["method"], "/download"),
            Path(os.environ["TEST_DATA_ROOT"]) / "annotations.zip",
            attachment=True, mimetype="application/zip",
        )
    else:
        if scope["path"] == "/slow":
            (Path(os.environ["TEST_DATA_ROOT"]) / "slow-started").touch()
            await asyncio.sleep(1)
        response = HttpResponse(b"finished")
    await ASGIHandler().send_response(response, send)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class TestServerRuntime(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.payload = b"archive-data-0123456789" * 1000
        (self.root / "annotations.zip").write_bytes(self.payload)
        self.processes = []
        self.addCleanup(self.stop_processes)

    def stop_processes(self):
        for process in reversed(self.processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()

    def start(self, command, **kwargs):
        process = subprocess.Popen(command, **kwargs)
        self.processes.append(process)
        return process

    def uvicorn(self, limit=1000):
        port = free_port()
        log = self.root / "uvicorn.log"
        with log.open("wb") as output:
            process = self.start(
                [sys.executable, "-m", "uvicorn", "test_server_runtime:app",
                 "--app-dir", str(Path(__file__).parent), "--host", "127.0.0.1",
                 "--port", str(port), "--lifespan", "off",
                 "--limit-max-requests", str(limit), "--limit-max-requests-jitter", "0"],
                env={**os.environ, "TEST_DATA_ROOT": str(self.root)},
                stdout=output, stderr=subprocess.STDOUT,
            )
        self.wait_for_port(port, process)
        return port, process, log

    def wait_for_port(self, port, process):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            self.assertIsNone(process.poll(), "server exited during startup")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                    return
            except OSError:
                time.sleep(0.05)
        self.fail("server did not start")

    def test_nginx_serves_full_head_and_range_downloads_without_asgi_errors(self):
        upstream, _, log = self.uvicorn()
        port = free_port()
        config = self.root / "nginx.conf"
        config.write_text(f"""
worker_processes 1;
pid {self.root}/nginx.pid;
error_log {self.root}/nginx-error.log;
events {{ worker_connections 64; }}
http {{
    access_log off;
    client_body_temp_path {self.root}/client;
    proxy_temp_path {self.root}/proxy;
    fastcgi_temp_path {self.root}/fastcgi;
    uwsgi_temp_path {self.root}/uwsgi;
    scgi_temp_path {self.root}/scgi;
    server {{
        listen 127.0.0.1:{port};
        location /data/ {{ internal; alias {self.root}/; }}
        location / {{ proxy_pass http://127.0.0.1:{upstream}; }}
    }}
}}
""")
        nginx = self.start(["/usr/sbin/nginx", "-c", str(config), "-g", "daemon off;"])
        self.wait_for_port(port, nginx)
        url = f"http://127.0.0.1:{port}/download"
        with urlopen(url, timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(int(response.headers["Content-Length"]), len(self.payload))
            self.assertEqual(response.read(), self.payload)
            self.assertIn('filename="annotations.zip"', response.headers["Content-Disposition"])
        with urlopen(Request(url, method="HEAD"), timeout=5) as response:
            self.assertEqual(int(response.headers["Content-Length"]), len(self.payload))
            self.assertEqual(response.read(), b"")
        with urlopen(Request(url, headers={"Range": "bytes=10-29"}), timeout=5) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.read(), self.payload[10:30])
        self.stop_processes()
        self.assertNotIn("ERROR", log.read_text())

    def test_request_limit_drains_inflight_request_before_exit(self):
        port, process, log = self.uvicorn(limit=2)
        url = f"http://127.0.0.1:{port}"

        def get(path):
            with urlopen(url + path, timeout=5) as response:
                return response.read()

        with concurrent.futures.ThreadPoolExecutor() as executor:
            slow = executor.submit(get, "/slow")
            deadline = time.monotonic() + 5
            while not (self.root / "slow-started").exists():
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.01)
            self.assertEqual(get("/health"), b"finished")
            self.assertEqual(get("/health"), b"finished")
            self.assertEqual(slow.result(timeout=5), b"finished")
        self.assertEqual(process.wait(timeout=10), 0)
        self.assertNotIn("ERROR", log.read_text())


if __name__ == "__main__":
    settings.configure(DEFAULT_CHARSET="utf-8")
    unittest.main()
