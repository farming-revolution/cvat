// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
// node --test tests/unit/attribute-display.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
require('@babel/register')({
    extensions: ['.ts'],
    presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-typescript'],
    ignore: [/node_modules/], babelrc: false, configFile: false,
});
const { Attribute, Label } = require('../../cvat-core/src/labels.ts');
const disease = { id: 10, name: 'disease_level', input_type: 'select', mutable: false,
    values: ['-1', '0', '1', '2', '3'], default_value: '-1' };

test('disease choices display registry names without changing saved numeric values', () => {
    const attribute = new Attribute(disease);
    assert.equal(attribute.displayName, 'Disease level');
    assert.deepEqual(attribute.values.map((value) => attribute.displayValue(value)),
        ['Not assessed', 'Healthy', 'Mild infection', 'Strong infection', 'Total infection']);
    assert.deepEqual(attribute.toJSON(), disease);
    assert.equal(attribute.displayValue('unexpected'), 'unexpected');
});

test('internal identities are hidden from annotation views but retained in serialization', () => {
    const raw = { id: 2, name: 'Plant', type: 'any', attributes: [
        ...['fr_origin', 'fr_tracking_id'].map((name, index) => ({ id: index + 1, name,
            input_type: 'text', mutable: false, values: [''], default_value: '' })),
        disease,
    ] };
    const label = new Label(raw);
    assert.deepEqual(label.visibleAttributes.map((attribute) => attribute.name), ['disease_level']);
    assert.deepEqual(label.toJSON().attributes, raw.attributes);
    assert.equal(new Label({ ...raw, attributes: raw.attributes.slice(0, 2) }).visibleAttributes.length, 0);
});

test('size and custom attribute values retain their existing text', () => {
    for (const [name, values] of [['size', ['tiny', 'small', 'medium', 'large']], ['custom', ['0', 'anything']]]) {
        const attribute = new Attribute({ ...disease, name, values });
        assert.equal(attribute.internal, false);
        assert.deepEqual(values.map((value) => attribute.displayValue(value)), values);
    }
});
