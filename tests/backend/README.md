# Backend file-serving and process-lifetime regressions

The nginx sendfile backend in django-sendfile2 0.7.0 returns an empty
`X-Accel-Redirect` response but attaches the complete file's Content-Length.
Uvicorn rejects that response with `Response content shorter than Content-Length`.
The adapter sets the upstream length to zero only for nginx redirects. nginx
computes the final file length when serving the internal redirect; direct file
responses are unchanged.

Run with the server image's dependencies, no production environment or volumes,
and no network (loopback remains available inside Docker):

```
PYTHONPATH=. python cvat/apps/engine/tests/test_sendfile.py
PYTHONPATH=. python tests/backend/test_server_runtime.py
```

Tests cover the ASGI body/header mismatch after middleware, attachment headers,
direct file responses, missing files, real nginx downloads including HEAD and
byte ranges, and completion of an in-flight request during Uvicorn recycling.
The two redirect regression tests fail against unpatched django-sendfile2.

## Memory mitigation and diagnosis

Supervisor now gracefully recycles each API process after 10,000 requests plus
0–1,000 requests of random jitter. Supervisor retains the listening socket and
restarts each exited process. Uvicorn drains active requests before exiting;
there is no request-duration limit and CVAT's queue workers are unaffected.
Jitter reduces the chance of simultaneous recycling, but is not a guarantee.
This limits process lifetime; it is not a hard memory limit or a proven repair
of a particular memory leak. The September 28 task-3692 504s could not be
reproduced, so their precise cause remains unconfirmed.

nginx access logs now include request ID, total time, upstream time and upstream
status to make subsequent timeout investigations more precise.

## Existing-installation rollout

`Dockerfile.server-hotfix` layers only these runtime files onto an explicitly
selected existing server image. Normal full Dockerfile builds also include the
source changes. Keep the previous image and compose override for rollback.

For an already initialized installation on the same schema, replace only
`cvat_server`, preserving its environment, mounts and networks, with command
`run server` rather than `init run server`. This avoids migration, Redis
initialization and periodic-job synchronization writes; the normal startup
migration checks still run. Do not use this command for a fresh installation
or a schema upgrade. Leave database, queue-worker and UI containers running.

Use `docker compose up -d --no-deps cvat_server` with the existing compose files
and an override selecting the new server image and command. Verify API health,
annotation GETs and an existing archive download before considering the rollout
complete. Avoid submitting production sync jobs for validation.
