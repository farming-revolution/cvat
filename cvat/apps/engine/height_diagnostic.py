# Copyright (C) 2026 Farming Revolution
# SPDX-License-Identifier: MIT
"""Optional task-local projection data. Never saves a model or annotation."""
import fcntl
import hashlib
import json
import math
import os
import tempfile
from pathlib import Path

VERSION = 1
FILENAME = 'height-diagnostic.json'
MAX_BYTES = 16 * 1024 * 1024


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def catalogue(task):
    data = task.data
    if data is None or hasattr(data, 'video'):
        raise ValueError('Only image tasks support height diagnostics')
    frames = [dict(frame=index, name=image.path, width=image.width, height=image.height)
              for index, image in enumerate(data.images.order_by('frame'))]
    if len(frames) != data.size:
        raise ValueError('Incomplete task frame catalogue')
    identity = dict(task_id=task.id, data_id=data.id, frames=frames,
                    start_frame=data.start_frame, stop_frame=data.stop_frame,
                    frame_step=data.get_frame_step(), deleted_frames=sorted(data.deleted_frames))
    return dict(version=VERSION, **identity,
                frame_fingerprint=hashlib.sha256(canonical(identity).encode()).hexdigest())


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_bag(bag, catalog):
    if not isinstance(bag, dict) or type(bag.get('bag_id')) is not int or bag['bag_id'] <= 0:
        raise ValueError('Invalid bag identity')
    height = bag.get('horizontal_height_m')
    if not finite(height) or height <= 0:
        raise ValueError('Invalid horizontal projection height')
    if not isinstance(bag.get('target_frame'), str) or not bag['target_frame']:
        raise ValueError('Missing projection coordinate system')
    frames = bag.get('frames')
    if not isinstance(frames, list) or not frames or len(frames) > len(catalog['frames']):
        raise ValueError('Invalid projection frame count')
    seen, result = set(), []
    for item in frames:
        index = item.get('frame') if isinstance(item, dict) else None
        if type(index) is not int or index in seen or not 0 <= index < len(catalog['frames']):
            raise ValueError('Invalid or duplicate frame index')
        seen.add(index)
        expected = catalog['frames'][index]
        if any(item.get(key) != expected[key] for key in ('name', 'width', 'height')):
            raise ValueError('Projection frame does not match the task catalogue')
        p, m = item.get('projection'), item.get('target_to_camera')
        if not isinstance(p, list) or len(p) != 12 or not all(map(finite, p)):
            raise ValueError('Invalid camera projection')
        if not isinstance(m, list) or len(m) != 16 or not all(map(finite, m)):
            raise ValueError('Invalid camera transform')
        if p[0] <= 0 or p[5] <= 0 or abs(m[10]) < 1e-9 or m[12:] != [0, 0, 0, 1]:
            raise ValueError('Unsupported camera geometry')
        # Singular XY mapping cannot identify a ground position.
        a = m[0] - m[2] * m[8] / m[10]
        b = m[1] - m[2] * m[9] / m[10]
        c = m[4] - m[6] * m[8] / m[10]
        d = m[5] - m[6] * m[9] / m[10]
        if abs(a * d - b * c) < 1e-9:
            raise ValueError('Singular camera geometry')
        result.append(dict(expected, projection=p, target_to_camera=m))
    return dict(bag_id=bag['bag_id'], target_frame=bag['target_frame'],
                horizontal_height_m=height, frames=sorted(result, key=lambda f: f['frame']))


def read_document(directory, catalog):
    path = Path(directory) / FILENAME
    try:
        if path.stat().st_size > MAX_BYTES:
            raise ValueError('Projection metadata is too large')
        document = json.loads(path.read_text())
        if document.get('version') != VERSION or any(document.get(k) != catalog[k] for k in
                ('task_id', 'data_id', 'frame_fingerprint')):
            return dict(status='stale', reason='Projection information is stale; synchronize this task again.')
        bags, occupied = [], set()
        for bag in document['bags'].values():
            clean = validate_bag(bag, catalog)
            indices = {f['frame'] for f in clean['frames']}
            if occupied & indices or any(b['bag_id'] == clean['bag_id'] for b in bags):
                raise ValueError('Overlapping or duplicate bag projections')
            occupied.update(indices)
            bags.append(clean)
        return dict(status='available', bags=bags)
    except FileNotFoundError:
        return dict(status='missing', reason='Available after the next App–CVAT synchronization.')
    except (ValueError, TypeError, KeyError, AttributeError, OSError):
        return dict(status='invalid', reason='Projection information is invalid or unavailable; synchronize again.')


def write_bag(directory, catalog, payload):
    if not isinstance(payload, dict) or payload.get('version') != VERSION:
        raise ValueError('Unsupported diagnostic metadata version')
    if any(payload.get(k) != catalog[k] for k in ('task_id', 'data_id', 'frame_fingerprint')):
        raise ValueError('Task frame catalogue changed; retry on the next synchronization')
    if len(canonical(payload).encode()) > MAX_BYTES:
        raise ValueError('Projection metadata is too large')
    bag = validate_bag(payload.get('bag'), catalog)
    directory = Path(directory)
    # The task directory already exists; never recreate a deleted task directory.
    with (directory / (FILENAME + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = read_document(directory, catalog)
        if current['status'] == 'invalid':
            raise ValueError('Existing diagnostic metadata is invalid; administrator inspection is required')
        bags = {str(b['bag_id']): b for b in current.get('bags', [])}
        if current['status'] == 'stale':
            # Revalidate untouched bags against the new catalogue. A deletion or
            # a change within the current bag must not discard another bag.
            old = json.loads((directory / FILENAME).read_text())
            if old.get('version') != VERSION or any(old.get(k) != catalog[k] for k in ('task_id', 'data_id')):
                raise ValueError('Existing diagnostic metadata belongs to another task/data identity')
            try:
                for other in old['bags'].values():
                    if other['bag_id'] != bag['bag_id']:
                        clean = validate_bag(other, catalog)
                        bags[str(clean['bag_id'])] = clean
            except (KeyError, TypeError, AttributeError) as error:
                raise ValueError('Invalid existing bag metadata') from error
        incoming = {f['frame'] for f in bag['frames']}
        for key, other in bags.items():
            if key != str(bag['bag_id']) and incoming & {f['frame'] for f in other['frames']}:
                raise ValueError('A different bag already owns these frames')
        bags[str(bag['bag_id'])] = bag
        document = {k: catalog[k] for k in ('version', 'task_id', 'data_id', 'frame_fingerprint')}
        document['bags'] = bags
        encoded = canonical(document)
        if len(encoded.encode()) > MAX_BYTES:
            raise ValueError('Projection metadata is too large')
        path = directory / FILENAME
        if path.exists() and path.read_text() == encoded:
            return False
        fd, temporary = tempfile.mkstemp(prefix='.height-diagnostic-', dir=directory)
        try:
            with os.fdopen(fd, 'w') as output:
                output.write(encoded)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return True
