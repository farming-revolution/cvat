// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
// node --test tests/unit/farming-frame-tags.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
require('@babel/register')({
    extensions: ['.ts'],
    presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-typescript'],
    ignore: [/node_modules/], babelrc: false, configFile: false,
});
const { Label } = require('../../cvat-core/src/labels.ts');
const { LabelType } = require('../../cvat-core/src/enums.ts');
const originalLoad = Module._load;
Module._load = function stubWrapper(request, parent, isMain) {
    if (request === 'cvat-core-wrapper') return { Label, LabelType };
    return originalLoad.call(this, request, parent, isMain);
};
const { frameTagChoices, supervisionLabel, supervisionFields } =
    require('../../cvat-ui/src/utils/farming-frame-tags.ts');
Module._load = originalLoad;

const makeLabel = (name, type = 'any', attributes = []) => new Label({
    id: name.length + (type === 'tag' ? 100 : 0), name, type, attributes,
});
const supervision = makeLabel('Supervision', 'tag', supervisionFields.map((field, idx) => ({
    id: idx + 1, name: field.name, mutable: false, input_type: 'select',
    values: field.values, default_value: field.defaultValue,
})));
const plant = makeLabel('Arnika');
const absent = makeLabel('Absent: Giftpflanze', 'tag');

test('Farming Revolution frame tag selectors exclude plant labels and Supervision', () => {
    const labels = [plant, supervision, absent];
    assert.deepEqual(frameTagChoices(labels).map((label) => label.name), ['Absent: Giftpflanze']);
    assert.equal(supervisionLabel(labels), supervision);
    assert.deepEqual(supervisionFields.map((field) => field.defaultValue), ['inherit', 'inherit', 'inherit']);
});

test('CVAT projects without Farming Revolution supervision retain their generic tags', () => {
    assert.deepEqual(frameTagChoices([plant, absent]).map((label) => label.name),
        ['Arnika', 'Absent: Giftpflanze']);
});

test('dedicated controls require complete compatible supervision attributes', () => {
    const incomplete = makeLabel('Supervision', 'tag', supervision.attributes.slice(0, 2).map((attr) => ({
        id: attr.id, name: attr.name, mutable: false, input_type: 'select',
        values: attr.values, default_value: attr.defaultValue,
    })));
    assert.equal(supervisionLabel([plant, incomplete, absent]), undefined);
    assert.deepEqual(frameTagChoices([plant, incomplete, absent]).map((label) => label.name),
        ['Absent: Giftpflanze']);
});
