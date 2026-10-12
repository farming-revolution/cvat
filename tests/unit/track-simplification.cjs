// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
// BABEL_DISABLE_CACHE=1 node --test tests/unit/track-simplification.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
require('@babel/register')({
    extensions: ['.ts'],
    presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-typescript'],
    ignore: [/node_modules/], babelrc: false, configFile: false,
});
const { PointsTrack } = require('../../cvat-core/src/annotations-objects.ts');
const { Label } = require('../../cvat-core/src/labels.ts');
const { default: History } = require('../../cvat-core/src/annotations-history.ts');
const { Source, DimensionType, JobType } = require('../../cvat-core/src/enums.ts');

function fixture(overrides = {}, injectionOverrides = {}) {
    const history = new History();
    const label = new Label({ id: 1, name: 'Salbei', type: 'points', attributes: [
        { id: 10, name: 'fr_origin', input_type: 'text', mutable: false, default_value: '', values: [] },
        { id: 11, name: 'disease_level', input_type: 'select', mutable: true, default_value: '-1', values: ['-1', '0', '1', '2', '3'] },
        { id: 12, name: 'fr_tracking_id', input_type: 'text', mutable: false, default_value: '', values: [] },
    ] });
    const data = { id: 100, frame: 0, label_id: 1, group: 5, source: 'manual', attributes: [
        { spec_id: 10, value: 'plant:stem' }, { spec_id: 12, value: 'plant-identity' },
    ], shapes: Array.from({ length: 11 }, (_, frame) => ({
        frame, type: 'points', points: [10 + frame * 2, 50 + frame], outside: false,
        occluded: false, z_order: 0, rotation: 0, attributes: [], ...overrides[frame],
    })) };
    const framesInfo = Object.fromEntries(data.shapes.map((s) => [s.frame, { width: 100, height: 100 }]));
    framesInfo.isFrameDeleted = () => false;
    const track = new PointsTrack(data, 1, '#ffffff', {
        labels: { 1: label }, history, framesInfo, groups: { max: 5 }, groupColors: {},
        dimension: DimensionType.DIMENSION_2D, jobType: JobType.ANNOTATION,
        nextClientID: () => 99, getMasksOnFrame: () => [], ...injectionOverrides,
    });
    return { track, history };
}
const frames = (track) => Object.keys(track.shapes).map(Number);

test('one undoable operation preserves identity and linear interpolation; redo survives later edits', async () => {
    const { track, history } = fixture();
    const before = track.toJSON();
    const positions = Array.from({ length: 11 }, (_, f) => track.get(f).points);
    assert.equal(track.simplify(4), 9);
    assert.deepEqual(frames(track), [0, 10]);
    assert.equal(track.serverID, 100);
    assert.deepEqual(track.toJSON().attributes, before.attributes);
    assert.equal(track.group, 5);
    assert.deepEqual(Array.from({ length: 11 }, (_, f) => track.get(f).points), positions);
    assert.equal(history.get().undo.length, 1);
    await history.undo(1);
    assert.deepEqual(track.toJSON(), before);
    await history.redo(1);
    assert.deepEqual(frames(track), [0, 10]);
    assert.equal(track.simplify(4), 0);
    assert.equal(history.get().undo.length, 1);
    const { default: ObjectState } = require('../../cvat-core/src/object-state.ts');
    const edited = new ObjectState(track.get(5));
    edited.points = [77, 44];
    track.save(5, edited);
    assert.deepEqual(track.get(5).points, [77, 44]);
    await history.undo(1);
    await history.undo(1);
    assert.deepEqual(track.toJSON(), before);
    await history.redo(1);
    await history.redo(1);
    assert.deepEqual(track.get(5).points, [77, 44]);
});

test('preserves disappearance/reappearance and both visible endpoints', () => {
    const { track } = fixture({ 4: { outside: true }, 5: { outside: true }, 8: { outside: true }, 9: { outside: true }, 10: { outside: true } });
    const visibility = Array.from({ length: 11 }, (_, f) => track.get(f).outside);
    track.simplify(2);
    assert.deepEqual(frames(track), [0, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(Array.from({ length: 11 }, (_, f) => track.get(f).outside), visibility);
});

test('preserves sparse attribute changes and occlusion/z-order states on every frame', () => {
    const { track } = fixture({ 3: { attributes: [{ spec_id: 11, value: '2' }] },
        6: { attributes: [{ spec_id: 11, value: '0' }] }, 8: { occluded: true, z_order: 1 },
        9: { occluded: true, z_order: 1 }, 10: { occluded: true, z_order: 1 } });
    const states = () => Array.from({ length: 11 }, (_, f) => {
        const s = track.get(f); return [s.attributes, s.outside, s.occluded, s.zOrder];
    });
    const before = states();
    track.simplify(0);
    assert.deepEqual(states(), before);
    assert.deepEqual(frames(track), [0, 2, 3, 5, 6, 7, 8, 10]);
});

test('redundant explicit attribute values do not prevent simplification', () => {
    const { track } = fixture(Object.fromEntries(Array.from({ length: 11 }, (_, f) => [f, {
        attributes: [{ spec_id: 11, value: '1' }],
    }])));
    assert.equal(track.simplify(0), 9);
    assert.equal(track.get(5).attributes[11], '1');
});

test('another track (including an Ignore partner) remains untouched', () => {
    const { track } = fixture(); const { track: partner } = fixture();
    const before = partner.toJSON(); track.simplify(0);
    assert.deepEqual(partner.toJSON(), before);
});

test('locked, removed, read-only, child and multi-point tracks are rejected without history', () => {
    for (const options of [{ lock: true }, { removed: true }]) {
        const { track, history } = fixture(); Object.assign(track, options);
        assert.throws(() => track.simplify(0)); assert.equal(history.get().undo.length, 0);
    }
    for (const injection of [{ readOnlyFields: ['keyframe'] }, { readOnlyFields: ['points'] }, { parentID: 7 }]) {
        const { track } = fixture({}, injection); assert.throws(() => track.simplify(0));
    }
    const { track } = fixture({ 4: { points: [1, 2, 3, 4] } });
    assert.throws(() => track.simplify(0), /one point/);
});

test('zero, one or two keyframes are no-ops without a history entry', () => {
    for (const count of [0, 1, 2]) {
        const { track, history } = fixture();
        track.shapes = Object.fromEntries(Object.entries(track.shapes).slice(0, count));
        assert.equal(track.simplify(0), 0);
        assert.equal(history.get().undo.length, 0);
    }
});
