// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('module');
require('@babel/register')({ extensions: ['.ts', '.tsx'], presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-typescript', '@babel/preset-react',
], ignore: [/node_modules/], babelrc: false, configFile: false });
const fixture = require('./fixtures/height-projection.json')[0];
const estimator = require('../../cvat-ui/src/utils/height-diagnostic/estimate.ts');
let result;
const deletedFrames = {};
const state = { annotation: { job: { instance: { id: 1 } }, annotations: { states: [] } } };
const entry = { value: fixture.metadata, reason: '', listeners: new Set() };
let reads = 0;
const React = {
    memo: (component) => component,
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useEffect: () => undefined,
    useState: (initial) => [initial, (value) => { if (value?.estimate) result = value; }],
};
const original = Module._load;
Module._load = function(name, ...args) {
    if (name === 'react') return React;
    if (name === 'react-redux') return { useSelector: (select) => select(state) };
    if (name === '@ant-design/icons') return { InfoCircleOutlined: 'icon' };
    if (name.startsWith('antd/') || name === 'components/common/cvat-tooltip') return () => null;
    if (name === 'cvat-store') return { getCVATStore: () => ({ getState: () => state }) };
    if (name === 'cvat-core-wrapper') return { getCore: () => ({ frames: { getMeta: async (kind, id) => {
        assert.equal(kind, 'job'); assert.equal(id, 1); reads++; return { deletedFrames };
    } } }) };
    if (name === 'utils/height-diagnostic/metadata') return { jobMetadata: () => entry, refreshMetadata: async () => {} };
    if (name === 'utils/height-diagnostic/estimate') return estimator;
    return original.call(this, name, ...args);
};
const Button = require('../../cvat-ui/src/components/annotation-page/standard-workspace/objects-side-bar/height-diagnostic.tsx').default;
Module._load = original;
function icon(node) {
    if (node?.type === 'icon') return node;
    return node?.props?.children?.flat().map(icon).find(Boolean);
}
test('button uses cached unsaved frame deletion/restoration without changing either snapshot', async () => {
    const before = JSON.stringify(fixture);
    const rendered = Button({ supported: true, snapshot: async () => fixture.track });
    await icon(rendered).props.onClick();
    assert.equal(result.estimate.count, 9);
    deletedFrames[2] = true;
    await icon(rendered).props.onClick();
    assert.equal(result.estimate.count, 8);
    assert.ok(Math.abs(result.estimate.height - fixture.height) < 1e-6);
    delete deletedFrames[2];
    await icon(rendered).props.onClick();
    assert.equal(result.estimate.count, 9);
    assert.equal(reads, 3);
    assert.equal(JSON.stringify(fixture), before);
});
