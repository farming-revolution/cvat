"""Isolated archive acceptance test. Run with PYTHONPATH=/home/django in a network-disabled CVAT image; always uses SQLite :memory:."""
import os
os.environ['DJANGO_SETTINGS_MODULE']='cvat.settings.production'
from django.conf import settings
settings.DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}}
import django
django.setup()
from django.db import connection
from django.apps import apps
# All storage is an ephemeral in-memory database. Network is disabled on the container.
with connection.schema_editor() as schema:
    for model in apps.get_models():
        if not model._meta.proxy and model._meta.managed:
            schema.create_model(model)
from cvat.apps.engine.models import Data,Task,Label,AttributeSpec,Image,Segment,Job
from cvat.apps.dataset_manager.annotation import AnnotationIR
from cvat.apps.dataset_manager.bindings import TaskData
from cvat.apps.dataset_manager.formats.farming_revolution import export_farming_revolution,import_farming_revolution,read_archive,FR
from copy import deepcopy
from pathlib import Path
from io import BytesIO
from tempfile import TemporaryDirectory
from xml.etree import ElementTree as ET
import zipfile

def fixture(name):
    data=Data.objects.bulk_create([Data(size=4,stop_frame=3,deleted_frames=[])])[0]
    task=Task.objects.bulk_create([Task(data=data,name=name,mode='annotation',overlap=0)])[0]
    segment=Segment.objects.bulk_create([Segment(task=task,start_frame=0,stop_frame=3)])[0]
    Job.objects.bulk_create([Job(segment=segment)])
    label=Label.objects.bulk_create([Label(task=task,name='Sellerie',type='points',color='#abcdef')])[0]
    tag=Label.objects.bulk_create([Label(task=task,name='Supervision',type='tag',color='#aaaaaa')])[0]
    attrs=AttributeSpec.objects.bulk_create([
      AttributeSpec(label=label,name='disease_level',mutable=False,input_type='select',default_value='-1',values='-1\n0\n1\n2\n3'),
      AttributeSpec(label=label,name='size',mutable=True,input_type='select',default_value='tiny',values='tiny\nsmall\nmedium\nlarge'),
      AttributeSpec(label=tag,name='weed_stems_complete',mutable=False,input_type='select',default_value='inherit',values='inherit\ncomplete\nincomplete')])
    Image.objects.bulk_create([Image(data=data,frame=i,path=f'bag_frame{i}.png',width=100,height=100) for i in range(4)])
    shape=lambda f,p,out=False:{'id':100+f,'frame':f,'type':'points','points':p,'outside':out,'occluded':False,'rotation':0,'z_order':0,'attributes':[{'spec_id':attrs[1].id,'value':'medium'}]}
    raw={'version':0,'tags':[{'id':90,'frame':1,'label_id':tag.id,'group':0,'source':'manual','attributes':[{'spec_id':attrs[2].id,'value':'incomplete'}]}],
      'shapes':[dict(shape(2,[5,7]),label_id=label.id,group=0,source='manual')],
      'tracks':[{'id':5,'frame':0,'label_id':label.id,'group':0,'source':'manual','attributes':[{'spec_id':attrs[0].id,'value':'0'}], 'shapes':[shape(0,[10,20]),shape(2,[30,40],True),shape(3,[40,50])]}]}
    return task,raw
source,raw=fixture('source')
original=deepcopy(raw)
with TemporaryDirectory() as temp:
    path=Path(temp)/'export.zip'; staging=Path(temp)/'stage';staging.mkdir()
    with path.open('wb') as f:export_farming_revolution()(f,str(staging),TaskData(AnnotationIR('2d',raw),source,host='https://test.example'))
    assert raw==original,'Interpolation mutated native annotations'
    with path.open('rb') as f:archive=read_archive(f)
    print('EXPORTED',[(len(r['annotations']['tracks']),len(r['annotations']['tags'])) for r in archive['tasks']])
    with zipfile.ZipFile(path) as z:root=ET.fromstring(z.read('annotations.xml'))
    points=root.findall('image/points')
    assert any(p.get(FR+'kind')=='track' and p.get(FR+'tracking_id') for p in points)
    assert any(p.get(FR+'kind')=='shape' and p.get(FR+'tracking_id') is None for p in points)
    target,_=fixture('target');target_data=TaskData(AnnotationIR('2d'),target)
    with path.open('rb') as f:import_farming_revolution()(f,temp,target_data)
    restored=target_data.data.serialize()
    assert len(restored['tracks'])==1 and len(restored['tracks'][0]['shapes'])==3
    assert restored['tracks'][0]['shapes'][1]['outside']
    assert restored['tags'][0]['attributes'][0]['value']=='incomplete'
    assert any(a['value']=='0' for a in restored['tracks'][0]['attributes'])
    print('CVAT native export/import integration passed')

from unittest.mock import patch
from django.db import transaction
from cvat.apps.dataset_manager.task import TaskAnnotation
with TemporaryDirectory() as directory:
    stage=Path(directory)/'stage';stage.mkdir()
    archive_path=Path(directory)/'task.zip'
    with archive_path.open('wb') as f:export_farming_revolution()(f,str(stage),TaskData(AnnotationIR('2d',deepcopy(original)),source,host='https://test.example'))
    with patch('cvat.apps.dataset_manager.task.handle_annotations_change'), transaction.atomic():
        destination,_=fixture('import-with-database')
        with archive_path.open('rb') as f:TaskAnnotation(destination.id).import_annotations(f, import_farming_revolution())
        readback=TaskAnnotation(destination.id);readback.init_from_db()
        assert len(readback.data['tracks'])==1 and len(readback.data['tags'])==1
print('Transactional task import and server readback passed')
from cvat.apps.dataset_manager.formats.registry import make_exporter
from cvat.apps.dataset_manager.formats.farming_revolution import source_revision, tracking_ids
from cvat.apps.engine.models import Project
from cvat.apps.dataset_manager.bindings import ProjectData
# Failed import must restore pre-existing data, including dynamically added definitions.
with TemporaryDirectory() as directory, patch('cvat.apps.dataset_manager.task.handle_annotations_change'):
    stage=Path(directory)/'stage';stage.mkdir();bundle=Path(directory)/'annotations.zip'
    with bundle.open('wb') as f:export_farming_revolution()(f,str(stage),TaskData(AnnotationIR('2d',deepcopy(original)),source,host='https://test.example'))
    with bundle.open('rb') as f:logical=next(iter(read_archive(f)['tasks'][0]['tracking_ids'].values()))
    before=deepcopy(readback.data)
    Image.objects.filter(data=destination.data).update(width=99)
    try:
        with transaction.atomic(), bundle.open('rb') as f:
            TaskAnnotation(destination.id).import_annotations(f,import_farming_revolution())
    except ValueError as error:
        assert 'dimensions' in str(error)
    else:raise AssertionError('invalid mapping accepted')
    after=TaskAnnotation(destination.id);after.init_from_db()
    assert after.data==before,'Failed import removed original annotations'
    Image.objects.filter(data=destination.data).update(width=100)
    second=Path(directory)/'second';second.mkdir();reexport=Path(directory)/'reexport.zip'
    with reexport.open('wb') as f:export_farming_revolution()(f,str(second),TaskData(after.ir_data,destination,host='https://different.example'))
    with reexport.open('rb') as f:assert next(iter(read_archive(f)['tasks'][0]['tracking_ids'].values()))==logical
    default_stage=Path(directory)/'default';default_stage.mkdir();default_path=Path(directory)/'default.zip'
    with default_path.open('wb') as f:make_exporter('CVAT for images 1.1')(f,str(default_stage),TaskData(AnnotationIR('2d',deepcopy(original)),source,host='https://test.example'))
    with zipfile.ZipFile(default_path) as z:assert ET.fromstring(z.read('annotations.xml')).find('meta/'+FR+'archive') is None
    fingerprint=source_revision(source)
    Image.objects.filter(data=source.data,frame=0).update(width=101)
    assert source_revision(source)!=fingerprint
    Image.objects.filter(data=source.data,frame=0).update(width=100)
print('Rollback, stable re-export identity, legacy format and cache invalidation passed')

# A project export preserves both native task boundaries and independent identities.
project=Project.objects.bulk_create([Project(name='multi-bag')])[0]
second,second_raw=fixture('second-bag')
for image in second.data.images.all():
    Image.objects.filter(pk=image.pk).update(path=image.path.replace('bag_frame','other_frame'))
# Use the same project label IDs in both tasks.
second_raw=deepcopy(original)
Label.objects.filter(task=second).delete()
Label.objects.filter(task=source).update(project=project,task=None)
Task.objects.filter(pk__in=[source.id,second.id]).update(project=project)
source.refresh_from_db();second.refresh_from_db()
with TemporaryDirectory() as directory:
    path=Path(directory)/'project.zip';stage=Path(directory)/'stage';stage.mkdir()
    project_data=ProjectData({source.id:AnnotationIR('2d',deepcopy(original)),second.id:AnnotationIR('2d',second_raw)},project,host='https://test.example')
    with path.open('wb') as f:export_farming_revolution()(f,str(stage),project_data)
    with path.open('rb') as f:records=read_archive(f)['tasks']
    assert len(records)==2
    assert records[0]['tracking_ids']['5']!=records[1]['tracking_ids']['5']
print('Project multi-bag identities passed')

# Exercise project import through its public writer (no pre-initialized annotation IRs).
from cvat.apps.dataset_manager.project import ProjectAnnotation
with TemporaryDirectory() as directory, patch('cvat.apps.dataset_manager.task.handle_annotations_change'):
    path=Path(directory)/'project.zip';stage=Path(directory)/'stage';stage.mkdir()
    project_data=ProjectData({source.id:AnnotationIR('2d',deepcopy(original)),second.id:AnnotationIR('2d',deepcopy(second_raw))},project,host='https://test.example')
    with path.open('wb') as f:export_farming_revolution()(f,str(stage),project_data)
    with transaction.atomic(), path.open('rb') as f:
        ProjectAnnotation(project.id).import_dataset(f,import_farming_revolution())
    for task in (source,second):
        writer=TaskAnnotation(task.id);writer.init_from_db()
        assert len(writer.data['tracks'])==1 and len(writer.data['tags'])==1
print('Existing project native import and readback passed')

from cvat.apps.dataset_manager.task import JobAnnotation
with TemporaryDirectory() as directory, patch('cvat.apps.dataset_manager.task.handle_annotations_change'):
    source_job=Job.objects.get(segment__task=source)
    writer=JobAnnotation(source_job.id);writer.init_from_db()
    path=Path(directory)/'job.zip';stage=Path(directory)/'stage';stage.mkdir()
    with path.open('wb') as f:writer.export(f,export_farming_revolution(),temp_dir=str(stage),host='https://test.example')
    target,_=fixture('job-target')
    with transaction.atomic(), path.open('rb') as f:
        JobAnnotation(Job.objects.get(segment__task=target).id).import_annotations(f,import_farming_revolution())
    readback=TaskAnnotation(target.id);readback.init_from_db()
    assert len(readback.data['tracks'])==1
print('Job export/import and readback passed')

# Duplicating a reserved identity onto overlapping unrelated tracks must not join plants.
from cvat.apps.dataset_manager.formats.farming_revolution import prepare_export
writer=TaskAnnotation(source.id);writer.init_from_db()
raw=deepcopy(writer.data)
raw['tracks'].append(deepcopy(raw['tracks'][0]));raw['tracks'][-1]['id']+=10000
archive=prepare_export(TaskData(AnnotationIR('2d',raw),source,host='https://test.example'))
assert not archive['tasks'][0]['tracking_ids']
assert any('Overlapping' in message for message in archive['tasks'][0]['warnings'])
print('Ambiguous reserved identities rejected')

# Complete project datasets preserve exact media paths (including collisions and deleted frames).
# Only media transport/task image ingestion is mocked; import and DB readback are real.
from types import SimpleNamespace
from cvat.apps.dataset_manager.formats.farming_revolution import project_media_members
project_media = Project.objects.bulk_create([Project(name='media-source')])[0]
first, first_raw = fixture('first-media')
second, _ = fixture('second-media')
Label.objects.filter(task=second).delete()
Label.objects.filter(task=first).update(project=project_media, task=None)
Task.objects.filter(pk__in=[first.id, second.id]).update(project=project_media)
first.refresh_from_db(); second.refresh_from_db()
first.data.deleted_frames = [1]; first.data.save(update_fields=['deleted_frames'])
contents = {first.id: b'FIRST', second.id: b'SECOND'}
def media_provider(task):
    return SimpleNamespace(iterate_frames=lambda **kwargs: iter([
        SimpleNamespace(data=BytesIO(contents[task.id] + str(index).encode())) for index in range(4)
    ]))
copied_media = {}
def create_media_task(owner, task_fields, files, project_data):
    data = Data.objects.bulk_create([Data(size=len(files['media']), stop_frame=len(files['media'])-1)])[0]
    task = Task.objects.bulk_create([Task(data=data, name=task_fields['name'], subset=task_fields['subset'],
                                         project=owner.db_project, mode='annotation', overlap=0)])[0]
    segment = Segment.objects.bulk_create([Segment(task=task, start_frame=0, stop_frame=data.size-1)])[0]
    Job.objects.bulk_create([Job(segment=segment)])
    copied_media[task.name] = [Path(path).read_bytes() for path in files['media']]
    Image.objects.bulk_create([Image(data=data, frame=i, path=str(Path(path).relative_to(files['data_root'])), width=100, height=100)
                               for i, path in enumerate(files['media'])])
    owner._init_task_from_db(task.id)
    project_data.new_tasks.add(task.id)
    project_data.init()
with TemporaryDirectory() as directory, patch('cvat.apps.dataset_manager.task.handle_annotations_change'):
    path = Path(directory)/'dataset.zip'; stage = Path(directory)/'stage'; stage.mkdir()
    dataset = ProjectData({first.id: AnnotationIR('2d', deepcopy(first_raw)), second.id: AnnotationIR('2d', deepcopy(first_raw))}, project_media)
    with patch('cvat.apps.dataset_manager.formats.cvat.make_frame_provider', media_provider), path.open('wb') as f:
        export_farming_revolution()(f, str(stage), dataset, save_images=True)
    with path.open('rb') as f: exported = read_archive(f)
    with zipfile.ZipFile(path) as bundle:
        members = project_media_members(exported, set(bundle.namelist()))
        assert bundle.read(members[0][1][1]) == b'FIRST1', 'Deleted frame image was dropped'
        assert bundle.read(members[1][0][1]) == b'SECOND0', 'Second task received first task media'
        legacy = deepcopy(exported)
        for record in legacy['tasks']:
            for frame in record['frames']: frame.pop('media_path')
        try: project_media_members(legacy, set(bundle.namelist()))
        except ValueError as error: assert 'Ambiguous' in str(error)
        else: raise AssertionError('Ambiguous legacy media mapping was guessed')
    target_project = Project.objects.bulk_create([Project(name='media-target')])[0]
    with patch.object(ProjectAnnotation, 'add_task', create_media_task), transaction.atomic(), path.open('rb') as f:
        ProjectAnnotation(target_project.id).import_dataset(f, import_farming_revolution())
    assert copied_media == {'first-media': [b'FIRST'+str(i).encode() for i in range(4)],
                            'second-media': [b'SECOND'+str(i).encode() for i in range(4)]}
    assert Task.objects.get(project=target_project, name='first-media').data.deleted_frames == [1]
    for task in target_project.tasks.all():
        readback = TaskAnnotation(task.id); readback.init_from_db()
        assert len(readback.data['tracks']) == 1 and len(readback.data['tags']) == 1
print('Project recreation preserves duplicate filenames, deleted frames, native grouping and distinct media')

# Whole-task writes used by mixed-bag synchronization must retain foreign native IDs.
from cvat.apps.engine.serializers import LabeledDataSerializer

def without_ids(value):
    if isinstance(value, dict): return {k: without_ids(v) for k, v in value.items() if k != 'id'}
    if isinstance(value, list): return [without_ids(v) for v in value]
    return value

with patch('cvat.apps.dataset_manager.task.handle_annotations_change'):
    for multi_job, continuous in ((False, False), (True, False), (True, True)):
        target, raw = fixture('retained-native-identities')
        if continuous:
            raw['tracks'][0]['shapes'] = [raw['tracks'][0]['shapes'][0], raw['tracks'][0]['shapes'][-1]]
        if multi_job:
            Segment.objects.filter(task=target).update(stop_frame=1)
            segment = Segment.objects.bulk_create([Segment(task=target, start_frame=2, stop_frame=3)])[0]
            Job.objects.bulk_create([Job(segment=segment)])
        with transaction.atomic(): TaskAnnotation(target.id).put(without_ids(raw))
        before = TaskAnnotation(target.id); before.init_from_db()
        serializer = LabeledDataSerializer(data=deepcopy(before.data)); serializer.is_valid(raise_exception=True)
        with transaction.atomic(): TaskAnnotation(target.id).put(serializer.validated_data)
        after = TaskAnnotation(target.id); after.init_from_db()
        assert after.data == before.data, 'Whole-task replacement changed retained native IDs or content'
print('Native IDs survive whole-task replacement for single and multiple jobs')
