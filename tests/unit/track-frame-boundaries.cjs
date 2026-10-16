// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
require('@babel/register')({ extensions: ['.ts'], presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-typescript',
], ignore: [/node_modules/], babelrc: false, configFile: false });
const { PointsTrack, RectangleTrack, EllipseTrack } = require('../../cvat-core/src/annotations-objects.ts');
const { Label } = require('../../cvat-core/src/labels.ts');
const { default: History } = require('../../cvat-core/src/annotations-history.ts');
const { DimensionType, JobType } = require('../../cvat-core/src/enums.ts');

function fixture({ type = 'points', shapes, frames = Array.from({ length: 12 }, (_, f) => f), deleted = [] } = {}) {
    const history = new History(); const excluded = new Set(deleted);
    const label = new Label({ id: 1, name: 'Plant', type, attributes: [
        { id: 10, name: 'fr_origin', input_type: 'text', mutable: false, default_value: 'identity', values: [] },
        { id: 11, name: 'size', input_type: 'select', mutable: true, default_value: 'tiny', values: ['tiny', 'small'] },
    ] });
    const data = { id: 100, frame: shapes?.[0].frame ?? 0, label_id: 1, group: 2, source: 'manual',
        attributes: [{ spec_id: 10, value: 'plant:identity' }], shapes: (shapes || [0, 3, 7, 11].map((frame) => ({ frame }))).map((s) => ({
            type, points: type === 'points' ? [10 + s.frame, 10 + s.frame ** 2] : [10 + s.frame, 20, 40 + s.frame, 70],
            rotation: type === 'rectangle' ? (350 + s.frame * 7) % 360 : 0,
            outside: false, occluded: false, z_order: 0, attributes: [], ...s,
        })) };
    const framesInfo = Object.fromEntries(frames.map((f) => [f, { width: 500, height: 500 }]));
    framesInfo.isFrameDeleted = (f) => excluded.has(f); framesInfo.getFrameNumbers = () => frames;
    const Class = { points: PointsTrack, rectangle: RectangleTrack, ellipse: EllipseTrack }[type];
    const track = new Class(data, 1, '#ffffff', { labels: { 1: label }, history, framesInfo,
        groups: { max: 2 }, groupColors: {}, dimension: DimensionType.DIMENSION_2D, jobType: JobType.ANNOTATION,
        nextClientID: () => 99, getMasksOnFrame: () => [], });
    return { track, history, excluded, frames };
}
function state(track, f) {
    const s = track.get(f); return { points: s.points, rotation: s.rotation, outside: s.outside,
        occluded: s.occluded, attributes: s.attributes, zOrder: s.zOrder };
}
function sameState(actual, expected) {
    assert.equal(actual.outside, expected.outside); assert.equal(actual.occluded, expected.occluded);
    assert.equal(actual.zOrder, expected.zOrder); assert.deepEqual(actual.attributes, expected.attributes);
    assert.ok(Math.abs(actual.rotation - expected.rotation) < 1e-9);
    actual.points.forEach((v, i) => assert.ok(Math.abs(v - expected.points[i]) < 1e-9));
}
for (const type of ['points', 'rectangle']) {
    for (const deleted of [[0], [11], [3], [5], [2, 3, 4, 5, 6, 7], [0, 1, 2, 3], [8, 9, 10, 11], [0, 3, 7, 11]]) {
        test(`${type}: preserve retained observations deleting ${deleted}`, () => {
            const { track, excluded, frames } = fixture({ type });
            const original = track.toJSON();
            const before = frames.map((f) => state(track, f));
            const target = new Set(deleted); const operation = track.prepareFrameDeletion(target);
            operation?.apply(); deleted.forEach((f) => excluded.add(f));
            for (const f of frames.filter((f) => !excluded.has(f))) sameState(state(track, f), before[f]);
            assert.equal(track.serverID, 100); assert.deepEqual(track.toJSON().attributes, original.attributes);
            assert.ok(Object.keys(track.shapes).every((f) => !excluded.has(+f)));
            operation?.undo(); excluded.clear(); assert.deepEqual(track.toJSON(), original);
            operation?.apply(); deleted.forEach((f) => excluded.add(f));
            for (const f of frames.filter((f) => !excluded.has(f))) sameState(state(track, f), before[f]);
        });
    }
}
test('visibility, occlusion and sparse attributes survive disappearing inside a gap', () => {
    const { track, excluded, frames } = fixture({ shapes: [
        { frame: 0 }, { frame: 3, attributes: [{ spec_id: 11, value: 'small' }], occluded: true },
        { frame: 4, outside: true }, { frame: 8 }, { frame: 11, outside: true },
    ] });
    const before = frames.map((f) => state(track, f)); const deleted = new Set([2, 3, 4, 5, 6]);
    track.prepareFrameDeletion(deleted).apply(); deleted.forEach((f) => excluded.add(f));
    for (const f of frames.filter((f) => !excluded.has(f))) sameState(state(track, f), before[f]);
    assert.equal(track.get(7).outside, true); assert.equal(track.get(8).outside, false);
});
test('deleting every visible observation removes the track; undo restores it', () => {
    const { track } = fixture({ shapes: [{ frame: 3 }, { frame: 4, outside: true }] });
    const operation = track.prepareFrameDeletion(new Set([3])); operation.apply();
    assert.equal(track.removed, true); operation.undo(); assert.equal(track.removed, false);
});
test('frame steps/job boundaries and consecutive deletions preserve retained positions', () => {
    const { track, excluded, frames } = fixture({ frames: [2, 4, 6, 8, 10], shapes: [{ frame: 2 }, { frame: 6 }, { frame: 10 }] });
    const before = new Map(frames.map((f) => [f, state(track, f)]));
    for (const deleted of [[6], [4, 6], [4, 6, 10]]) {
        track.prepareFrameDeletion(new Set(deleted)).apply(); deleted.forEach((f) => excluded.add(f));
        for (const f of frames.filter((f) => !excluded.has(f))) sameState(state(track, f), before.get(f));
    }
    assert.deepEqual(Object.keys(track.shapes).map(Number), [2, 8]);
});
test('locked/unsupported affected tracks reject without mutation; unaffected ones allow deletion', () => {
    const { track } = fixture(); const before = track.toJSON(); track.lock = true;
    assert.throws(() => track.prepareFrameDeletion(new Set([3])), /Unlock track/);
    assert.equal(track.prepareFrameDeletion(new Set([5])), null); assert.deepEqual(track.toJSON(), before);
    const other = fixture({ type: 'ellipse' }).track;
    assert.throws(() => other.prepareFrameDeletion(new Set([3])), /single-point and rectangle/);
});
test('Simplify normalizes legacy endpoints with only two keyframes in a single undo action', async () => {
    const { track, history } = fixture({ shapes: [{ frame: 0 }, { frame: 11 }], deleted: [10, 11] });
    const before = track.toJSON(); track.simplify(0);
    assert.deepEqual(Object.keys(track.shapes).map(Number), [0, 9]);
    assert.equal(track.get(9).points[1], 109);
    const after = track.toJSON(); await history.undo(1); assert.deepEqual(track.toJSON(), before);
    await history.redo(1); assert.deepEqual(track.toJSON(), after);
    assert.equal(track.simplify(0), 0);
});
test('Simplify protects both sides of gaps while removing intermediate keys independently', () => {
    const { track } = fixture({ shapes: Array.from({ length: 12 }, (_, frame) => ({ frame })), deleted: [4, 5, 6] });
    const before3 = track.shapes[3].points; const before7 = track.shapes[7].points;
    track.simplify(0); assert.deepEqual(Object.keys(track.shapes).map(Number), [0, 3, 7, 11]);
    assert.deepEqual(track.shapes[3].points, before3); assert.deepEqual(track.shapes[7].points, before7);
    assert.equal(track.simplify(0), 0);
});

test('existing frame controls delete a range as one action; undo/redo includes frames and annotations', async () => {
    const fs = require('node:fs'); const vm = require('node:vm'); const ts = require('typescript');
    const code = fs.readFileSync('cvat-core/src/session-implementation.ts', 'utf8');
    const wrappers = code.slice(code.indexOf('async function deleteFrameWrapper'), code.indexOf('export function implementJob'));
    const { track, history, excluded } = fixture(); const before = track.toJSON();
    const meta = { deletedFrames: {} }; const api = {};
    vm.runInNewContext(ts.transpileModule(wrappers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText +
        '\napi.remove = deleteFrameWrapper; api.restore = restoreFrameWrapper;', {
        api, TaskClass: class Task {}, JobClass: class Job {}, ArgumentError: Error,
        HistoryActions: require('../../cvat-core/src/enums.ts').HistoryActions,
        getAnnotations: async () => [], getFramesMeta: async () => meta,
        getCollection: () => ({ prepareFrameDeletion: (deleted) => {
            const op = track.prepareFrameDeletion(deleted);
            return { apply: () => op?.apply(), undo: () => op?.undo(), clientIDs: op ? [1] : [] };
        } }), getHistory: () => history,
        deleteFrame: async (_id, f) => { meta.deletedFrames[f] = true; excluded.add(f); },
        restoreFrame: async (_id, f) => { delete meta.deletedFrames[f]; excluded.delete(f); },
    });
    await api.remove.call({}, 1, [3, 4, 5, 6, 7]);
    const after = track.toJSON(); assert.deepEqual([...excluded], [3, 4, 5, 6, 7]);
    assert.equal(history.get().undo.length, 1);
    await history.undo(1); assert.deepEqual([...excluded], []); assert.deepEqual(track.toJSON(), before);
    await history.redo(1); assert.deepEqual([...excluded], [3, 4, 5, 6, 7]); assert.deepEqual(track.toJSON(), after);
    await api.restore.call({}, 1, 3); assert.equal(excluded.has(3), false);
    assert.deepEqual(track.toJSON(), after, 'Restore uses repaired interpolation, not an archived keyframe');
    await history.undo(1); assert.equal(excluded.has(3), true);
    track.lock = true;
    await assert.rejects(api.remove.call({}, 1, [0, 11]), /Unlock track/);
    assert.deepEqual([...excluded].sort((a,b) => a-b), [3, 4, 5, 6, 7]);
});

test('new deletion preserves the currently displayed positions even with legacy deleted keyframes', () => {
    const { track, frames, excluded } = fixture({ deleted: [3] });
    const before = frames.map((f) => state(track, f));
    const op = track.prepareFrameDeletion(new Set([3, 7])); op.apply(); excluded.add(7);
    for (const f of frames.filter((f) => !excluded.has(f))) sameState(state(track, f), before[f]);
    assert.ok(!track.shapes[3] && !track.shapes[7]);
});

for (const incident of require('./fixtures/frame-boundary-incidents.json')) {
    test(`incident ${incident.incident} track ${incident.track.id}: repaired browser geometry matches unchanged worker`, () => {
        const history = new History();
        const label = new Label(incident.label); const deleted = new Set();
        const framesInfo = Object.fromEntries(incident.frames.map((f) => [f, { width: 4096, height: 4096 }]));
        framesInfo.isFrameDeleted = (f) => deleted.has(f); framesInfo.getFrameNumbers = () => incident.frames;
        const track = new PointsTrack(incident.track, 1, '#ffffff', { labels: { [label.id]: label }, history, framesInfo,
            groups: { max: 0 }, groupColors: {}, dimension: DimensionType.DIMENSION_2D, jobType: JobType.ANNOTATION,
            nextClientID: () => 99, getMasksOnFrame: () => [], });
        const beforeIdentity = track.toJSON().attributes;
        track.prepareFrameDeletion(new Set(incident.deleted))?.apply();
        incident.deleted.forEach((f) => deleted.add(f));
        assert.equal(track.serverID, incident.track.id);
        assert.deepEqual(track.toJSON().attributes, beforeIdentity);
        for (const expected of incident.expected) {
            const actual = track.get(expected.frame);
            assert.equal(actual.outside, false); assert.equal(actual.occluded, expected.occluded);
            actual.points.forEach((v, i) => assert.ok(Math.abs(v - expected.points[i]) < 1e-8));
            for (const attr of expected.attributes) assert.equal(actual.attributes[attr.spec_id], attr.value);
        }
        assert.ok(Object.keys(track.shapes).every((f) => !deleted.has(+f)));
    });
}

test('Simplify normalizes a single legacy keyframe on a deleted frame', async () => {
    const { track, history } = fixture({ shapes: [{ frame: 3 }], deleted: [3, 4] });
    const before=track.toJSON(); track.simplify(5);
    assert.deepEqual(Object.keys(track.shapes).map(Number), [5]);
    assert.equal(track.get(2).outside, true); assert.equal(track.get(5).outside, false);
    assert.equal(track.simplify(5), 0); await history.undo(1); assert.deepEqual(track.toJSON(), before);
});

test('remove a track when the job loses every visible observation even if its keys lie outside the job', () => {
    const { track }=fixture({frames:[2,3,4],shapes:[{frame:0},{frame:11,outside:true}]});
    const operation=track.prepareFrameDeletion(new Set([2,3,4])); operation.apply();
    assert.equal(track.removed,true); operation.undo(); assert.equal(track.removed,false);
});

test('deleting unrelated frames does not add unnecessary keys beyond a track ending', () => {
    const {track}=fixture({frames:Array.from({length:30},(_,f)=>f),shapes:[{frame:0},{frame:3},{frame:11,outside:true}]});
    track.prepareFrameDeletion(new Set([3,20,21])).apply();
    assert.deepEqual(Object.keys(track.shapes).map(Number),[0,2,4,11]);
});
