#!/usr/bin/env bash
# Re-chunk an already static-cache image task to a new chunk_size (default 5).
# Annotation-safe: aborts if shape/track/tag counts change. Designed to be run
# concurrently (e.g. via `xargs -P N -n1`).
set -uo pipefail

SETTINGS=cvat.settings.production
SCRIPT=/home/django/switch_image_task_to_static_cache.py
TARGET_CHUNK_SIZE="${TARGET_CHUNK_SIZE:-5}"

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

chunk_size_of() {
  docker exec cvat_db psql -U root -d cvat -t -A -c "SELECT chunk_size FROM engine_data WHERE id=$1;" 2>/dev/null | tr -d ' '
}

mode_of() {
  docker exec cvat_db psql -U root -d cvat -t -A -c "SELECT mode FROM engine_task WHERE id=$1;" 2>/dev/null | tr -d ' '
}

tid="$1"
log() { echo "[task $tid] $*"; }

if [ "$(mode_of "$tid")" != "annotation" ]; then log "[skip] not an image task"; exit 0; fi
did=$(data_id_of "$tid")
if [ -z "$did" ]; then log "[skip] no data_id"; exit 0; fi
cur=$(chunk_size_of "$did")
if [ "$cur" = "$TARGET_CHUNK_SIZE" ]; then log "[skip] already chunk_size=$TARGET_CHUNK_SIZE"; exit 0; fi

before=$(ann_counts "$tid")
log "start data_id=$did chunk_size=$cur->$TARGET_CHUNK_SIZE annotations=$before"

if ! docker exec -e DJANGO_SETTINGS_MODULE=$SETTINGS cvat_server python $SCRIPT "$tid" --chunk-size "$TARGET_CHUNK_SIZE" >/tmp/rechunk_$tid.log 2>&1; then
  log "[FAIL] converter error: $(tail -1 /tmp/rechunk_$tid.log)"; exit 1
fi

after=$(ann_counts "$tid")
newcs=$(chunk_size_of "$did")
if [ "$before" != "$after" ]; then
  log "[FAIL] annotation count changed: $before -> $after"; exit 1
fi
if [ "$newcs" != "$TARGET_CHUNK_SIZE" ]; then
  log "[FAIL] chunk_size not applied: $newcs"; exit 1
fi
log "[OK] annotations preserved ($after), chunk_size=$newcs"
