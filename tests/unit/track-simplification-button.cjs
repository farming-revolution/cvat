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
    if (request === 'cvat-core-wrapper') return enums;
    if (request === 'components/common/cvat-tooltip') return ({ children }) => children;
    if (request === 'icons') return {};
    return originalLoad.call(this, request, parent, isMain);
};
const { default: Buttons } = require('../../cvat-ui/src/components/annotation-page/standard-workspace/objects-side-bar/object-item-buttons.tsx');
Module._load = originalLoad;
function findButton(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.props?.['aria-label'] === 'Simplify track') return node;
    return [].concat(node.props?.children || []).flat().map(findButton).find(Boolean) || null;
}
const props = { parentID: null, objectType: enums.ObjectType.TRACK, shapeType: enums.ShapeType.POINTS,
    locked: false, simplifyDisabled: false, simplifyTrack: () => {} };
test('button next to keyframe controls invokes only the selected track callback', () => {
    let called = 0;
    const button = findButton(Buttons.type({ ...props, simplifyTrack: () => { called += 1; } }));
    assert.ok(button);
    button.props.onClick();
    assert.equal(called, 1);
});
test('locked/read-only controls cannot simplify and non-track/child/non-point objects have no button', () => {
    for (const override of [{ locked: true }, { simplifyDisabled: true }]) {
        assert.equal(findButton(Buttons.type({ ...props, ...override })).props.onClick, undefined);
    }
    for (const override of [{ objectType: enums.ObjectType.SHAPE }, { parentID: 7 },
        { shapeType: enums.ShapeType.RECTANGLE }]) {
        assert.equal(findButton(Buttons.type({ ...props, ...override })), null);
    }
});
