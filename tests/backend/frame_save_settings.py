# Isolated local database only; run in a container with --network none and no production mounts.
import tempfile
from pathlib import Path
from cvat.settings.production import *

DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}
CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
BASE_DIR = Path(tempfile.mkdtemp(prefix="cvat-frame-tests-"))
DATA_ROOT = BASE_DIR / "data"
for name in (
    "DATA_ROOT",
    "MEDIA_DATA_ROOT",
    "CACHE_ROOT",
    "EXPORT_CACHE_ROOT",
    "JOBS_ROOT",
    "TASKS_ROOT",
    "PROJECTS_ROOT",
    "SHARE_ROOT",
    "LOGS_ROOT",
    "MIGRATIONS_LOGS_ROOT",
    "CLOUD_STORAGE_ROOT",
    "TMP_FILES_ROOT",
):
    globals()[name] = BASE_DIR / name.lower()
    globals()[name].mkdir(parents=True, exist_ok=True)
MEDIA_ROOT = BASE_DIR
LOGGING = {"version": 1, "disable_existing_loggers": True}

# Optional PostgreSQL parity/concurrency run on an isolated Docker-internal network.
if os.environ.get("FRAME_TEST_POSTGRES_HOST"):
    assert os.environ["FRAME_TEST_POSTGRES_HOST"] == "fr-frame-tests-db"
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "HOST": "fr-frame-tests-db",
            "NAME": "frame_tests",
            "USER": "frame_tests",
            "PASSWORD": "isolated-test-only",
        }
    }
