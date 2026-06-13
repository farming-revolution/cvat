#!/usr/bin/env bash
# Convert ONE image task to static cache (storage=share, file_system) without
# duplicating source data. Annotation-safe: aborts if shape/track/tag counts
# change. Deletes the raw image copy only after a verified-successful switch.
# Designed to be run concurrently (e.g. via `xargs -P N -n1`).
set -uo pipefail

DATA_ROOT=/var/lib/docker/volumes/cvat_cvat_data/_data/data
SETTINGS=cvat.settings.production
SCRIPT=/home/django/switch_image_task_to_static_cache.py

ann_counts() {  # task_id -> "shapes|tracks|tags"
  docker exec cvat_db psql -U root -d cvat -t -A -F"|" -c "
    SELECT
      (SELECT count(*) FROM engine_labeledshape ls JOIN engine_job j ON ls.job_id=j.id JOIN engine_segment s ON j.segment_id=s.id WHERE s.task_id=$1),
      (SELECT count(*) FROM engine_labeledtrack lt JOIN engine_job j ON lt.job_id=j.id JOIN engine_segment s ON j.segment_id=s.id WHERE s.task_id=$1),
      (SELECT count(*) FROM engine_labeledimage li JOIN engine_job j ON li.job_id=j.id JOIN engine_segment s ON j.segment_id=s.id WHERE s.task_id=$1);" 2>/dev/null | tr -d ' '
}

data_id_of() {
  docker exec cvat_db psql -U root -d cvat -t -A -c "SELECT data_id FROM engine_task WHERE id=$1;" 2>/dev/null | tr -d ' '
}

storage_of() {
  docker exec cvat_db psql -U root -d cvat -t -A -F"|" -c "SELECT storage,storage_method FROM engine_data WHERE id=$1;" 2>/dev/null | tr -d ' '
}

tid="$1"
log() { echo "[task $tid] $*"; }

did=$(data_id_of "$tid")
if [ -z "$did" ]; then log "[skip] no data_id"; exit 0; fi
pre=$(storage_of "$did")
if [ "$pre" = "share|file_system" ]; then log "[skip] already static/share"; exit 0; fi

before=$(ann_counts "$tid")
log "start data_id=$did storage($pre) annotations=$before"

if ! docker exec -e DJANGO_SETTINGS_MODULE=$SETTINGS cvat_server python $SCRIPT "$tid" >/tmp/conv_$tid.log 2>&1; then
  log "[FAIL] converter error: $(tail -1 /tmp/conv_$tid.log)"; exit 1
fi

after=$(ann_counts "$tid")
post=$(storage_of "$did")
if [ "$before" != "$after" ]; then
  log "[FAIL] annotation count changed: $before -> $after (NOT deleting raw)"; exit 1
fi
if [ "$post" != "share|file_system" ]; then
  log "[FAIL] storage not switched: $post (NOT deleting raw)"; exit 1
fi
log "annotations preserved ($after), storage=$post"

if [ -d "$DATA_ROOT/$did/raw/stems" ]; then
  rm -rf "$DATA_ROOT/$did/raw/stems" && log "raw image copy removed"
fi
log "[OK] done"
