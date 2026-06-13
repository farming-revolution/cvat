#!/usr/bin/env bash
# Batch-convert image tasks to static cache (storage=share, file_system) without
# duplicating source data. Annotation-safe: aborts a task if shape/track/tag
# counts change across the conversion. Deletes the raw image copy after success.
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

TASKS="$*"
echo "Tasks to process: $TASKS"
ok=0; skip=0; fail=0
for tid in $TASKS; do
  echo "=================== task $tid ==================="
  did=$(data_id_of "$tid")
  if [ -z "$did" ]; then echo "  [skip] no data_id"; skip=$((skip+1)); continue; fi
  pre=$(storage_of "$did")
  if [ "$pre" = "share|file_system" ]; then echo "  [skip] already static/share"; skip=$((skip+1)); continue; fi

  before=$(ann_counts "$tid")
  echo "  data_id=$did storage($pre) annotations(shapes|tracks|tags)=$before"

  if ! docker exec -e DJANGO_SETTINGS_MODULE=$SETTINGS cvat_server python $SCRIPT "$tid" >/tmp/conv_$tid.log 2>&1; then
    echo "  [FAIL] converter error:"; tail -5 /tmp/conv_$tid.log | sed 's/^/    /'; fail=$((fail+1)); continue
  fi
  tail -1 /tmp/conv_$tid.log | sed 's/^/    /'

  after=$(ann_counts "$tid")
  post=$(storage_of "$did")
  if [ "$before" != "$after" ]; then
    echo "  [FAIL] annotation count changed: $before -> $after (NOT deleting raw)"; fail=$((fail+1)); continue
  fi
  if [ "$post" != "share|file_system" ]; then
    echo "  [FAIL] storage not switched: $post (NOT deleting raw)"; fail=$((fail+1)); continue
  fi
  echo "  annotations preserved ($after), storage=$post"

  if [ -d "$DATA_ROOT/$did/raw/stems" ]; then
    rm -rf "$DATA_ROOT/$did/raw/stems" && echo "  raw image copy removed"
  fi
  ok=$((ok+1))
done
echo "=================================================="
echo "DONE  ok=$ok skip=$skip fail=$fail"
df -h / | tail -1
