# Copyright (C) 2026 Farming Revolution
# SPDX-License-Identifier: MIT
"""Image-compatible, native-track-preserving Farming Revolution archive."""
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
import json
import re
from pathlib import Path
import uuid
from xml.etree import ElementTree as XML
import zipfile

from defusedxml.ElementTree import fromstring

from cvat.apps.dataset_manager.bindings import ProjectData
from cvat.apps.dataset_manager.annotation import AnnotationIR, TrackManager
from cvat.apps.engine.serializers import LabelSerializer
from .registry import exporter, importer

NS = 'https://farming-revolution.com/cvat/annotations'
FR = '{' + NS + '}'
XML.register_namespace('fr', NS)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def flat_digest(root):
    def value(node):
        return [node.tag, sorted(node.attrib.items()), (node.text or '').strip(), [value(n) for n in node]]
    return sha256(canonical([value(n) for n in root if n.tag != 'meta']).encode()).hexdigest()


def origin(value):
    try:
        identity, role = value.rsplit(':', 1)
        if role in ('plant', 'auto-ignore', 'row'):
            return str(uuid.UUID(identity)), role
    except (ValueError, AttributeError):
        pass
    return None


def tracking_ids(raw, labels, host, task_id):
    specs = {a['id']: a['name'] for label in labels for a in label['attributes']}
    attrs = {t['id']: {specs.get(a['spec_id']): a['value'] for a in t.get('attributes', [])}
             for t in raw['tracks']}
    origins = {key: origin(value.get('fr_origin')) for key, value in attrs.items()}
    counts = Counter(value for value in origins.values() if value)
    result, warnings = {}, []
    for track in raw['tracks']:
        key = track['id']
        preserved = attrs[key].get('fr_tracking_id')
        if preserved:
            try:
                result[str(key)] = str(uuid.UUID(preserved))
            except ValueError:
                warnings.append('Invalid preserved tracking identity on track {}'.format(key))
            continue
        source = origins[key]
        if source and counts[source] > 1:
            warnings.append('Ambiguous duplicate fr_origin on track {}'.format(key))
            continue
        # Only the recognized, unique plant/automatic-Ignore pair may share a key.
        if source:
            pair = (source[0], 'plant')
            ignore = (source[0], 'auto-ignore')
            if source[1] == 'auto-ignore' and counts[pair] != 1:
                warnings.append('Automatic Ignore track {} has no unique plant'.format(key))
                continue
            identity = 'origin:' + source[0] if source[1] != 'row' else 'row:' + source[0]
            if counts[ignore] > 1 or counts[pair] > 1:
                warnings.append('Ambiguous plant/Ignore relationship on track {}'.format(key))
                continue
        else:
            identity = 'track:' + str(key)
        result[str(key)] = str(uuid.uuid5(uuid.NAMESPACE_URL, '{}/tasks/{}/{}'.format(host.rstrip('/'), task_id, identity)))
    return result, warnings


def prepare_export(instance):
    project = isinstance(instance, ProjectData)
    datas = list(instance.all_task_data) if project else [instance]
    if project:
        instance._annotation_irs = dict(instance._annotation_irs)
    records = []
    for data in datas:
        task = data.db_instance.segment.task if hasattr(data.db_instance, 'segment') else data.db_instance
        # Materialize streams once; flattening gets a separate copy.
        raw = {'version': data.data.version, **{key: deepcopy(list(data.data[key])) for key in ('tags', 'shapes', 'tracks')}}
        labels = list(LabelSerializer(list(data._label_mapping.values()), many=True).data)
        ids, warnings = tracking_ids(raw, labels, data._host, task.id)
        data._annotation_ir = AnnotationIR(data.data.dimension, deepcopy(raw))
        data._use_server_track_ids = True
        if project:
            instance._annotation_irs[task.id] = data._annotation_ir
        frames = []
        for index, info in sorted(data.frame_info.items()):
            match = re.search(r'([^/]+)_frame[0-9]+(?:_[^/]*)?\.[^/.]+$', info['path'])
            frames.append({'index': index, 'frame': data.abs_frame_id(index), 'name': info['path'],
                           'width': info['width'], 'height': info['height'],
                           'bag': match.group(1) if match else None,
                           'deleted': index in data.deleted_frames})
        # A native track crossing unrelated recordings is not a reliable plant ID.
        for track in raw['tracks']:
            states = sorted(track['shapes'], key=lambda shape: shape['frame'])
            bags = set()
            for frame in frames:
                before = [shape for shape in states if shape['frame'] <= frame['index']]
                if before and not before[-1].get('outside') and frame['bag'] and not frame['deleted']:
                    bags.add(frame['bag'])
            if len(bags) > 1:
                ids.pop(str(track['id']), None)
                warnings.append('Track {} crosses source recordings; no logical identity assigned'.format(track['id']))
        for logical_id in set(ids.values()):
            members = [track for track in raw['tracks'] if ids.get(str(track['id'])) == logical_id]
            bags = set()
            for track in members:
                states = sorted(track['shapes'], key=lambda shape: shape['frame'])
                for frame in frames:
                    before = [shape for shape in states if shape['frame'] <= frame['index']]
                    if before and not before[-1].get('outside') and frame['bag']:
                        bags.add(frame['bag'])
            if len(bags) > 1:
                for track in members:
                    ids.pop(str(track['id']), None)
                warnings.append('Logical plant {} spans different recordings; identity omitted'.format(logical_id))
            if len(members) > 1:
                spec_names = {a['id']: a['name'] for label in labels for a in label['attributes']}
                member_origins = [origin(next((a['value'] for a in track.get('attributes', []) if spec_names.get(a['spec_id']) == 'fr_origin'), None)) for track in members]
                verified_pair = (len(members) == 2 and all(member_origins)
                                 and member_origins[0][0] == member_origins[1][0]
                                 and {value[1] for value in member_origins} == {'plant', 'auto-ignore'})
                visible_frames = []
                for track in members:
                    states = sorted(track['shapes'], key=lambda shape: shape['frame'])
                    visible_frames.append({frame['index'] for frame in frames if not frame['deleted']
                        and any(shape['frame'] <= frame['index'] for shape in states)
                        and not max((shape for shape in states if shape['frame'] <= frame['index']), key=lambda shape: shape['frame']).get('outside')})
                overlap = any(left & right for index, left in enumerate(visible_frames) for right in visible_frames[index + 1:])
                if overlap and not verified_pair:
                    for track in members:
                        ids.pop(str(track['id']), None)
                    warnings.append('Overlapping tracks share logical identity {}; identity omitted'.format(logical_id))
        records.append({'task_id': task.id, 'job_id': data.db_instance.id if hasattr(data.db_instance, 'segment') else None,
                        'server': data._host.rstrip('/'), 'name': task.name, 'subset': task.subset,
                        'annotations': raw, 'labels': labels, 'frames': frames,
                        'deleted_frames': list(data.deleted_frames), 'tracking_ids': ids,
                        'warnings': warnings, 'meta': data.meta})
    archive = {'version': 1, 'exported_at': datetime.now(timezone.utc).isoformat(), 'tasks': records,
               'registry': json.loads(Path(__file__).with_name('annotation_attributes.json').read_text())}
    instance._fr_export = archive
    if project:
        instance._use_server_track_ids = True
    return archive


def shape_identity_attributes(instance, frame, shape):
    archive = instance._fr_export
    task_id = frame.task_id
    records = archive['tasks']
    record = next((t for t in records if t['task_id'] == task_id), None) if len(records) > 1 else records[0]
    if record is None:
        raise ValueError('Missing exact task/frame identity')
    result = {'xmlns:fr': NS}
    if hasattr(shape, 'track_id'):
        result.update({'fr:kind': 'track', 'fr:track_id': str(shape.track_id)})
        tracking = record['tracking_ids'].get(str(shape.track_id))
        if tracking:
            result['fr:tracking_id'] = tracking
    else:
        result.update({'fr:kind': 'shape', 'fr:shape_id': str(shape.id)})
    return result


@exporter(name='Farming Revolution', ext='ZIP', version='1.0')
def export_farming_revolution(dst_file, temp_dir, instance_data, save_images=False):
    from .cvat import dump_task_or_job_anno, dump_project_anno, dump_as_cvat_annotation, dump_media_files
    from cvat.apps.dataset_manager.util import make_zip_archive
    archive = prepare_export(instance_data)
    if save_images:
        project = isinstance(instance_data, ProjectData)
        datas = list(instance_data.all_task_data) if project else [instance_data]
        by_task = {record['task_id']: record for record in archive['tasks']}
        for data in datas:
            task = data.db_instance.segment.task if hasattr(data.db_instance, 'segment') else data.db_instance
            prefix = Path('images') / (task.subset or 'default') if project else Path('images')
            names = dump_media_files(data, str(Path(temp_dir) / prefix), instance_data if project else None,
                                     include_all_frames=True)
            for frame in by_task[task.id]['frames']:
                if frame['index'] not in names:
                    raise ValueError('Dataset export is missing archived frame ' + frame['name'])
                # Keep original names for native identity and the exact ZIP member for media.
                frame['media_path'] = (prefix / names[frame['index']]).as_posix()
    xml_path = Path(temp_dir) / 'annotations.xml'
    with xml_path.open('wb') as stream:
        (dump_project_anno if isinstance(instance_data, ProjectData) else dump_task_or_job_anno)(stream, instance_data, dump_as_cvat_annotation)
    root = fromstring(xml_path.read_bytes())
    archive['native_sha256'] = sha256(canonical(archive).encode()).hexdigest()
    archive['flat_sha256'] = flat_digest(root)
    node = XML.SubElement(root.find('meta'), FR + 'archive', {'version': '1'})
    node.text = json.dumps(archive, indent=2, ensure_ascii=False, allow_nan=False)
    XML.ElementTree(root).write(str(xml_path), encoding='utf-8', xml_declaration=True)
    make_zip_archive(temp_dir, dst_file)


def read_archive(stream):
    if zipfile.is_zipfile(stream):
        stream.seek(0)
        with zipfile.ZipFile(stream) as archive:
            # No extraction of untrusted paths.
            names = [n for n in archive.namelist() if n == 'annotations.xml']
            if len(names) != 1:
                raise ValueError('Expected one annotations.xml')
            xml = archive.read(names[0])
    else:
        stream.seek(0)
        xml = stream.read()
    root = fromstring(xml)
    node = root.find('meta/' + FR + 'archive')
    if node is None or node.get('version') != '1':
        raise ValueError('Unsupported Farming Revolution archive')
    archive = json.loads(node.text or '')
    if archive.get('version') != 1 or archive.get('flat_sha256') != flat_digest(root):
        raise ValueError('Image annotations and native archive disagree')
    native = {k: v for k, v in archive.items() if k not in ('native_sha256', 'flat_sha256')}
    if archive.get('native_sha256') != sha256(canonical(native).encode()).hexdigest():
        raise ValueError('Native archive checksum mismatch')
    registry = archive.get('registry', {})
    if registry.get('version') != 1 or registry.get('hash') != 'sha256:' + sha256(canonical({k: v for k, v in registry.items() if k != 'hash'}).encode()).hexdigest():
        raise ValueError('Unsupported or corrupt attribute registry')
    return archive


def remap_native(record, target):
    """Validate all IDs and frame mappings before assigning the target IR."""
    from cvat.apps.engine.models import AttributeSpec, Label
    from cvat.apps.dataset_manager.bindings import InstanceLabelData
    source_labels = {label['id']: label for label in record['labels']}
    label_ids, attr_ids = {}, {}
    for old_id, source in source_labels.items():
        try:
            new_id = target._get_label_id(source['name'])
        except ValueError:
            task = target.db_instance.segment.task if hasattr(target.db_instance, 'segment') else target.db_instance
            owner = {'project_id': task.project_id} if task.project_id else {'task': task}
            if source.get('type') == 'skeleton' or source.get('sublabels'):
                raise ValueError('Create compatible skeleton label definitions before native import')
            label = Label.objects.create(**owner, name=source['name'], type=source.get('type', 'any'), color=source.get('color', '#808080'))
            InstanceLabelData.__init__(target, task)
            new_id = label.id
        label_ids[old_id] = new_id
        specs = {s.name: s for s in target._attribute_mapping[new_id]['spec'].values()}
        for attribute in source['attributes']:
            spec = specs.get(attribute['name'])
            if spec is None:
                spec = AttributeSpec.objects.create(label_id=new_id, **{k: attribute[k] for k in ('name', 'mutable', 'input_type', 'default_value')}, values='\n'.join(attribute['values']))
            elif spec.mutable != attribute['mutable'] or spec.input_type != attribute['input_type'] or spec.values.splitlines() != list(attribute['values']):
                raise ValueError('Incompatible attribute definition: ' + attribute['name'])
            attr_ids[attribute['id']] = spec.id
        if any(t['label_id'] == old_id for t in record['annotations']['tracks']) and 'fr_tracking_id' not in specs:
            AttributeSpec.objects.get_or_create(label_id=new_id, name='fr_tracking_id', defaults={
                'mutable': False, 'input_type': 'text', 'default_value': '', 'values': ''})
    source_frames = {f['index']: f for f in record['frames']}
    from types import SimpleNamespace
    target_frames = {v['path']: SimpleNamespace(idx=k, width=v['width'], height=v['height']) for k, v in target.frame_info.items()}
    if len(target_frames) != len(target.frame_info):
        raise ValueError('Ambiguous target frame names')
    source_basenames = Counter(Path(f['name']).name for f in source_frames.values())
    target_basenames = Counter(Path(name).name for name in target_frames)
    mapping = {}
    for index, frame in source_frames.items():
        dest = target_frames.get(frame['name'])
        name = Path(frame['name']).name
        if dest is None and source_basenames[name] == target_basenames[name] == 1:
            dest = next(v for k, v in target_frames.items() if Path(k).name == name)
        if dest:
            if (frame['width'], frame['height']) != (dest.width, dest.height):
                raise ValueError('Frame dimensions differ: ' + frame['name'])
            mapping[index] = dest.idx
    if not mapping or set(mapping.values()) != {f.idx for f in target_frames.values()}:
        raise ValueError('Archive does not map every target frame exactly')

    if [mapping[i] for i in sorted(mapping)] != sorted(mapping.values()):
        raise ValueError('Source frame order must be preserved during native recreation')

    def item(value, inherited_label=None):
        result = {k: deepcopy(v) for k, v in value.items() if k not in ('id', 'track_id', 'shapes', 'elements')}
        label = value.get('label_id', inherited_label)
        if 'label_id' in value:
            result['label_id'] = label_ids[label]
        if value['frame'] not in mapping:
            raise ValueError('Track crosses an unmapped/deleted frame; explicit remapping required')
        result['frame'] = mapping[value['frame']]
        result['attributes'] = [{'spec_id': attr_ids[a['spec_id']], 'value': a['value']} for a in value.get('attributes', [])]
        if 'shapes' in value:
            result['shapes'] = [item(v, label) for v in value['shapes']]
            tracking = record['tracking_ids'].get(str(value['id']))
            if tracking:
                spec = AttributeSpec.objects.get(label_id=label_ids[label], name='fr_tracking_id')
                result['attributes'] = [a for a in result['attributes'] if a['spec_id'] != spec.id]
                result['attributes'].append({'spec_id': spec.id, 'value': tracking})
        if 'elements' in value:
            result['elements'] = [item(v, label) for v in value['elements']]
        return result
    tracks = []
    for track in record['annotations']['tracks']:
        frames = {shape['frame'] for shape in track['shapes']}
        visible = any(any(shape['frame'] <= frame for shape in track['shapes']) and not max((shape for shape in track['shapes'] if shape['frame'] <= frame), key=lambda shape: shape['frame']).get('outside') for frame in mapping)
        if frames & mapping.keys() or visible:
            if not frames <= mapping.keys():
                track = deepcopy(track)
                track['shapes'] = list(TrackManager.get_interpolated_shapes(track, min(mapping), max(mapping) + 1, target.data.dimension, included_frames=sorted(mapping), include_outside=True))
                if not track['shapes']:
                    continue
                track['frame'] = track['shapes'][0]['frame']
            tracks.append(item(track))
    restored = {'version': 0, 'tracks': tracks, **{kind: [item(v) for v in record['annotations'][kind] if v['frame'] in mapping]
                              for kind in ('tags', 'shapes')}}
    deleted = (set(target.db_data.deleted_frames) - set(mapping.values())) | {mapping[index] for index in record['deleted_frames'] if index in mapping}
    target.db_data.deleted_frames = sorted(deleted)
    target.db_data.save(update_fields=['deleted_frames'])
    return restored


def project_media_members(archive, members):
    """Validate every media reference before creating any tasks or writing images."""
    result, claimed = [], set()
    for record in archive['tasks']:
        mapped = []
        for frame in record['frames']:
            relative = Path(frame['name'])
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError('Unsafe archived frame path')
            explicit = frame.get('media_path')
            candidates = [explicit] if explicit else [
                'images/' + (record['subset'] or 'default') + '/' + frame['name'],
                'images/' + frame['name'],
            ]
            matches = [name for name in candidates if name in members]
            if not matches:
                raise ValueError('Dataset ZIP is missing source image ' + frame['name'])
            if len(matches) != 1 or matches[0] in claimed:
                raise ValueError('Ambiguous archived media mapping; re-export with explicit media paths')
            member = matches[0]
            if Path(member).is_absolute() or '..' in Path(member).parts:
                raise ValueError('Unsafe archived media path')
            claimed.add(member)
            mapped.append((frame, member))
        result.append(mapped)
    return result


def _create_project_tasks(stream, temp_dir, project_data, archive, callback):
    """Create each archived task through CVAT's normal dataset-media machinery."""
    from cvat.apps.engine.models import Label, AttributeSpec
    owner = callback.__self__
    project = project_data.db_project
    stream.seek(0)
    if not zipfile.is_zipfile(stream):
        raise ValueError('Project recreation requires a dataset ZIP containing images')
    with zipfile.ZipFile(stream) as bundle:
        members = bundle.namelist()
        if len(members) != len(set(members)):
            raise ValueError('Duplicate dataset ZIP members')
        media_members = project_media_members(archive, set(members))
        for record, mapped_frames in zip(archive['tasks'], media_members):
            media = []
            directory = Path(temp_dir) / ('task-' + str(int(record['task_id'])))
            directory.mkdir()
            for frame, member in mapped_frames:
                destination = directory / frame['name']
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(bundle.read(member))
                media.append(str(destination))
            for definition in record['labels']:
                label, _ = Label.objects.get_or_create(project=project, name=definition['name'], defaults={'type': definition.get('type', 'any'), 'color': definition.get('color', '#808080')})
                for attr in definition['attributes']:
                    AttributeSpec.objects.get_or_create(label=label, name=attr['name'], defaults={**{k: attr[k] for k in ('mutable', 'input_type', 'default_value')}, 'values': '\n'.join(attr['values'])})
            owner.add_task({'name': record['name'], 'subset': record['subset'], 'owner': project.owner,
                            'organization': project.organization},
                           {'media': media, 'data_root': str(directory) + '/', 'sorting_method': 'predefined'}, project_data)


@importer(name='Farming Revolution', ext='XML, ZIP', version='1.0')
def import_farming_revolution(src_file, temp_dir, instance_data, load_data_callback=None, **kwargs):
    archive = read_archive(src_file)
    if isinstance(instance_data, ProjectData):
        targets = list(instance_data.all_task_data)
        if load_data_callback is not None and not targets:
            _create_project_tasks(src_file, temp_dir, instance_data, archive, load_data_callback)
            targets = list(instance_data.all_task_data)
        for target in targets:
            candidates = [t for t in archive['tasks'] if t['name'] == target.db_instance.name and t['subset'] == target.db_instance.subset]
            if len(candidates) != 1:
                raise ValueError('Project tasks must map uniquely by name and subset')
            data = remap_native(candidates[0], target)
            target._annotation_ir = AnnotationIR(target.data.dimension, data)
            instance_data._annotation_irs[target.db_instance.id] = target._annotation_ir
            if target.db_instance.id not in instance_data.new_tasks:
                writer = instance_data._task_annotations[target.db_instance.id]
                writer.db_jobs = writer.db_jobs.all()
                writer.reset()
                writer.put(deepcopy(target.data.serialize()))
        return
    target_names = {Path(frame['path']).name for frame in instance_data.frame_info.values()}
    candidates = [t for t in archive['tasks'] if target_names <= {Path(f['name']).name for f in t['frames']}]
    if len(candidates) != 1:
        raise ValueError('Archive task/frame mapping is ambiguous')
    instance_data.data.data = remap_native(candidates[0], instance_data)


def source_revision(instance):
    """Include shared labels, frame metadata and registry in custom-export caching."""
    from cvat.apps.engine.models import Task, Project, Job, Video
    if isinstance(instance, Project):
        tasks = list(instance.tasks.select_related('data').order_by('id'))
    elif isinstance(instance, Job):
        tasks = [Task.objects.select_related('data').get(pk=instance.segment.task_id)]
    else:
        tasks = [Task.objects.select_related('data').get(pk=instance.id)]
    instance.refresh_from_db(fields=["updated_date"])
    records = []
    for task in tasks:
        if task.data is None:
            continue
        owner = task.project if task.project_id else task
        labels = list(LabelSerializer(list(owner.label_set.all().prefetch_related('attributespec_set', 'sublabels')), many=True).data)
        records.append({'id': task.id, 'updated': str(task.updated_date), 'labels': labels,
            'name': task.name, 'subset': task.subset,
            'data': {'size': task.data.size, 'start': task.data.start_frame, 'stop': task.data.stop_frame,
                     'filter': task.data.frame_filter, 'deleted': task.data.deleted_frames},
            'frames': list(task.data.images.order_by('frame').values('frame', 'path', 'width', 'height')),
            'video': list(Video.objects.filter(data=task.data).values('path', 'width', 'height'))})
    registry = json.loads(Path(__file__).with_name('annotation_attributes.json').read_text())
    return sha256(canonical({'tasks': records, 'registry': registry, 'instance_updated': str(instance.updated_date)}).encode()).hexdigest()


def verify_native_readback(expected, actual, labels):
    """Verify grouping, observations and non-default values after server ID assignment."""
    defaults = {spec.id: spec.default_value for label in labels for spec in label.attributespec_set.all()}
    def normalized(value):
        if isinstance(value, dict):
            omitted = {'id', 'version', 'track_id', 'keyframe', 'updated_date', 'created_date'}
            default_fields = {'rotation': 0, 'z_order': 0, 'outside': False, 'occluded': False, 'group': 0, 'source': 'manual', 'elements': []}
            return {key: normalized([a for a in item if a['value'] != defaults.get(a['spec_id'])]) if key == 'attributes' else normalized(item)
                    for key, item in value.items() if key not in omitted and not (key in default_fields and item == default_fields[key])}
        if isinstance(value, list):
            values = [normalized(item) for item in value]
            return sorted(values, key=canonical) if all(isinstance(item, dict) for item in values) else values
        return value
    if normalized(expected) != normalized(actual):
        raise ValueError('Native import readback differs; annotation replacement rolled back')
