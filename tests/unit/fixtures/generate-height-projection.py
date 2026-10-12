"""Regenerate the independent browser oracle with the worker's real projector.

python3 generate-height-projection.py /path/to/weeding-robot
Requires numpy only; no ROS/services or production access.
"""
import importlib.util
import json
from pathlib import Path
import sys
import numpy as np

spec = importlib.util.spec_from_file_location('projection', Path(sys.argv[1]) /
    'weeding_recording/src/weeding_recording/cvat_projection.py')
projection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(projection)
fixtures = []
for height, tilted, motion in [(0.83, False, .035), (0.83, True, .035),
                              (.051, False, .0005), (9.9, True, .035), (.83, False, .0005)]:
    frames, shapes = [], []
    for index in range(9):
        angle = .12 + index * .002 if tilted else 0
        a, b = np.cos(angle), np.sin(angle)
        c, d = np.cos(-.08 if tilted else 0), np.sin(-.08 if tilted else 0)
        rx = np.array([[1,0,0], [0,a,-b], [0,b,a]])
        ry = np.array([[c,0,d], [0,1,0], [-d,0,c]])
        transform = np.eye(4)
        transform[:3,:3] = rx @ ry
        transform[:3,3] = [index * .003, index * motion, .9]
        p = [500,0,640,0,0,510,512,0,0,0,1,0]
        pixels, _ = projection.project_ground_points(np.array([[.1,-.002]]), transform, p, height, 1.1)
        frames.append(dict(frame=index, name=f'frame_{index}.png', width=1280, height=1024,
                           projection=p, target_to_camera=transform.ravel().tolist()))
        shapes.append(dict(frame=index, type='points', points=pixels[0].tolist(), outside=False, occluded=False))
    fixtures.append(dict(height=height, track=dict(shapes=shapes), metadata=dict(version=1,
        status='available', task_id=1, data_id=1, frame_fingerprint='fixture', deleted_frames=[],
        frames=[{k:f[k] for k in ('frame','name','width','height')} for f in frames],
        bags=[dict(bag_id=1, horizontal_height_m=1.1, frames=frames)])))
# One compact JSON object per fixture keeps the numerical oracle reviewable.
Path(__file__).with_name('height-projection.json').write_text('[\n'+',\n'.join(json.dumps(f, sort_keys=True) for f in fixtures)+'\n]\n')
