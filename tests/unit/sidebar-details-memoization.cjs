// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
require('@babel/register')({
    extensions: ['.ts', '.tsx'],
    presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-typescript', '@babel/preset-react'],
    ignore: [/node_modules/], babelrc: false, configFile: false,
});
const enums = require('../../cvat-core/src/enums.ts');
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (request.startsWith('antd/lib/')) return () => null;
    if (request === 'cvat-core-wrapper') return enums;
    if (request === './object-item-attribute') return () => null;
    return originalLoad.call(this, request, parent, isMain);
};
let Details;
try {
    Details = require('../../cvat-ui/src/components/annotation-page/standard-workspace/objects-side-bar/object-item-details.tsx').default;
} finally { Module._load = originalLoad; }
const { Label } = require('../../cvat-core/src/labels.ts');
const label = new Label({ id: 1, name: 'Crop', type: 'points', attributes: [
    { id: 1, name: 'size', input_type: 'select', mutable: true, default_value: 'small', values: ['small', 'large'] },
] });
const attribute = label.attributes[0];
const base = { readonly: false, collapsed: false, attributes: [attribute], values: { 1: 'small' },
    changeAttribute() {}, collapse() {}, sizeParams: null, changeSize() {},
    source: enums.Source.MANUAL, score: 0, votes: 0, textContent: 'attributes' };
const equal = Details.compare;
test('new frame snapshots skip rendering unchanged open and closed details', () => {
    for (const collapsed of [false, true]) {
        const previous = { ...base, collapsed };
        assert.equal(equal(previous, { ...previous, attributes: label.attributes, values: { ...previous.values } }), true);
    }
});
test('attribute edits, clearing, new definitions, relabeling, undo and redo invalidate details', () => {
    for (const next of [
        { values: { 1: 'large' } }, { values: { 1: '' } }, { values: {} },
        { values: { 1: 'small', 2: '0' } },
        { attributes: [{ ...attribute, name: 'disease_level' }] },
        { attributes: [{ ...attribute, values: ['tiny', 'small'] }] },
        { attributes: [] }, { attributes: [attribute, { id: 2, name: 'disease_level' }] },
    ]) {
        assert.equal(equal(base, { ...base, ...next }), false, JSON.stringify(next));
        assert.equal(equal({ ...base, ...next }, base), false, 'Undo must restore the display');
    }
});
test('lock, expansion, consensus and display settings remain reactive', () => {
    for (const next of [{ readonly: true }, { collapsed: true }, { source: enums.Source.CONSENSUS },
        { score: 0.8 }, { votes: 3 }, { textContent: 'id,attributes' }]) {
        assert.equal(equal(base, { ...base, ...next }), false, JSON.stringify(next));
    }
});
test('changed callbacks are not retained by memoization', () => {
    for (const key of ['changeAttribute', 'collapse', 'changeSize']) {
        assert.equal(equal(base, { ...base, [key]: () => {} }), false, key);
    }
});
test('cuboid dimensions update across frames, edits and undo without needless renders', () => {
    const previous = { ...base, sizeParams: { width: 1, height: 2, length: 3 } };
    assert.equal(equal(previous, { ...previous, sizeParams: { ...previous.sizeParams } }), true);
    for (const key of ['width', 'height', 'length']) {
        const next = { ...previous, sizeParams: { ...previous.sizeParams, [key]: 4 } };
        assert.equal(equal(previous, next), false, key);
        assert.equal(equal(next, previous), false, `undo ${key}`);
    }
    assert.equal(equal(base, previous), false);
    assert.equal(equal(previous, base), false);
});
