// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
// Run from the repository root: node --test tests/unit/track-label-attributes.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
require('@babel/register')({
    extensions: ['.ts'],
    presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-typescript'],
    plugins: ['babel-plugin-transform-import-meta'],
    ignore: [/node_modules/], babelrc: false, configFile: false,
});
const { PointsTrack } = require('../../cvat-core/src/annotations-objects.ts');
const { Label } = require('../../cvat-core/src/labels.ts');
const AnnotationHistory = require('../../cvat-core/src/annotations-history.ts').default;
const AnnotationCollection = require('../../cvat-core/src/annotations-collection.ts').default;

const origin = '00000000-0000-4000-8000-000000000001:auto-ignore';
function label(id, sizeValues = ['small', 'large'], mutableOrigin = false) {
    return new Label({ id, name: id === 1 ? 'Ignore' : 'Crop', type: 'any', attributes: [
        { id: id * 10, name: 'fr_origin', input_type: 'text', mutable: mutableOrigin, default_value: '', values: [] },
        { id: id * 10 + 1, name: 'size', input_type: 'select', mutable: true, default_value: sizeValues[0], values: sizeValues },
    ] });
}
function fixture(destination = label(2)) {
    const original = label(1);
    const history = new AnnotationHistory();
    const injection = {
        labels: { 1: original, 2: destination }, history, groupColors: {}, groups: { max: 0 },
        framesInfo: { 0: { width: 100, height: 100 }, 1: { width: 100, height: 100 }, 2: { width: 100, height: 100 }, isFrameDeleted: () => false },
        dimension: '2d', jobType: 'annotation', nextClientID: () => 5,
    };
    const track = new PointsTrack({
        id: 7, label_id: 1, frame: 0, group: 0, source: 'manual', attributes: [{ spec_id: 10, value: origin }],
        shapes: [0, 2].map((frame) => ({ id: frame + 1, frame, type: 'points', points: [20, 30], outside: false, occluded: false, z_order: 0, rotation: 0, attributes: [{ spec_id: 11, value: frame ? 'large' : 'small' }] })),
    }, 1, '#ffffff', injection);
    return { track, history, injection, destination };
}

test('relabel retains origin and per-frame sizes through undo and redo', async () => {
    const { track, history, destination } = fixture();
    const before = track.toJSON();
    track.saveLabel(destination, 0);
    assert.deepEqual(track.toJSON().attributes, [{ spec_id: 20, value: origin }]);
    assert.deepEqual(track.toJSON().shapes.map((shape) => shape.attributes), [[{ spec_id: 21, value: 'small' }], [{ spec_id: 21, value: 'large' }]]);
    const after = track.toJSON();
    await history.undo(1);
    assert.deepEqual(track.toJSON(), before);
    await history.redo(1);
    assert.deepEqual(track.toJSON(), after);
});

test('incompatible values and changed mutability use destination defaults', () => {
    const { track, destination } = fixture(label(2, ['tiny'], true));
    track.saveLabel(destination, 0);
    assert.equal(track.getAttributes(2)[20], '');
    assert.equal(track.getAttributes(2)[21], 'tiny');
});

test('split followed by relabel retains the same origin in both fragments', () => {
    const { track, injection, destination } = fixture();
    const state = { shapeType: 'points', points: [20, 30], rotation: 0, occluded: false, outside: false, zOrder: 0, attributes: { 10: origin, 11: 'small' } };
    const fragments = AnnotationCollection.prototype._splitInternal.call({ injection }, state, track, 1);
    assert.equal(fragments.length, 2);
    for (const fragment of fragments) {
        const split = new PointsTrack(fragment, 2, '#ffffff', injection);
        split.saveLabel(destination, 1);
        assert.deepEqual(split.toJSON().attributes, [{ spec_id: 20, value: origin }]);
    }
});

test('invalid explicit mutable keyframes reset the default through undo/redo', async () => {
    const { track, destination, history } = fixture(label(2, ['tiny', 'small']));
    const before = track.toJSON();
    track.saveLabel(destination, 0);
    assert.equal(track.getAttributes(0)[21], 'small');
    assert.equal(track.getAttributes(1)[21], 'small'); // No explicit value: inherit.
    assert.equal(track.getAttributes(2)[21], 'tiny'); // Explicit invalid large: reset.
    assert.deepEqual(track.toJSON().shapes[1].attributes, [{ spec_id: 21, value: 'tiny' }]);
    const after = track.toJSON();
    await history.undo(1);
    assert.deepEqual(track.toJSON(), before);
    await history.redo(1);
    assert.deepEqual(track.toJSON(), after);
});

const ObjectState = require('../../cvat-core/src/object-state.ts').default;
globalThis.crypto ??= require('node:crypto').webcrypto;
for (const objectType of ['shape', 'track']) {
    for (const shapeType of ['points', 'rectangle']) {
        test(`new ${objectType} ${shapeType} gets a stable identity through undo/redo`, async () => {
            const { injection, history } = fixture();
            const collection = new AnnotationCollection({ ...injection, labels: Object.values(injection.labels), stopFrame: 2 });
            const state = () => new ObjectState({ objectType, shapeType, label: injection.labels[1], frame: 0,
                points: shapeType === 'points' ? [20, 30] : [10, 20, 40, 50], attributes: { 10: '' } });
            collection.put([state(), state()]);
            const before = collection.export();
            const items = before[objectType === 'track' ? 'tracks' : 'shapes'];
            const identities = items.map((item) => item.attributes.find((attr) => attr.spec_id === 10).value);
            const role = shapeType === 'points' ? 'plant' : 'row';
            identities.forEach((value) => assert.match(value, new RegExp(`^[0-9a-f-]{36}:${role}$`)));
            assert.notEqual(identities[0], identities[1]);
            await history.undo(1);
            assert.equal(collection.export()[objectType === 'track' ? 'tracks' : 'shapes'].length, 0);
            await history.redo(1);
            assert.deepEqual(JSON.parse(JSON.stringify(collection.export())), JSON.parse(JSON.stringify(before)));
        });
    }
}
test('loading unidentified tracks does not silently assign a new identity', () => {
    const { track, injection, history } = fixture();
    const collection = new AnnotationCollection({ ...injection, labels: Object.values(injection.labels), stopFrame: 2 });
    const old = track.toJSON();
    old.attributes = [{ spec_id: 10, value: '' }];
    collection.import({ tracks: [old], shapes: [], tags: [] });
    assert.equal(collection.export().tracks[0].attributes.find((attr) => attr.spec_id === 10).value, '');
});
