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
    if (request === './height-diagnostic') return () => null;
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

test('frame changes keep memoized button props stable and click uses the latest track state', () => {
    Module._load = function loadContainer(request, parent, isMain) {
        if (request === 'react-redux') return { connect: () => (component) => component };
        if (request === 'cvat-core-wrapper') return enums;
        if (request === 'utils/is-able-to-change-frame') return () => true;
        if (request === 'actions/annotation-actions') return {};
        if (request === 'components/annotation-page/standard-workspace/objects-side-bar/object-item-buttons') return Buttons;
        return originalLoad.call(this, request, parent, isMain);
    };
    let Wrapper;
    try {
        Wrapper = require('../../cvat-ui/src/containers/annotation-page/standard-workspace/objects-side-bar/object-buttons.tsx').default;
    } finally {
        Module._load = originalLoad;
    }
    const state = { ...props, clientID: 1, keyframes: { first: 0, prev: 0, next: 20, last: 20 },
        points: [10, 10], lock: false, keyframe: false, isGroundTruth: false };
    let selected;
    const containerProps = { objectState: state, frameNumber: 5, normalizedKeyMap: {},
        keyframeDisabled: false, simplifyTrack: (objectState) => { selected = objectState; } };
    const wrapper = new Wrapper(containerProps);
    const before = wrapper.render().props;
    const currentState = { ...state, points: [11, 11] };
    wrapper.props = { ...containerProps, frameNumber: 6, objectState: currentState };
    const after = wrapper.render().props;
    const changedProps = Object.keys(before).filter((key) => !Object.is(before[key], after[key]));
    assert.deepEqual(changedProps, [], 'A new callback forces every track button/tooltip to rerender');
    after.simplifyTrack();
    assert.equal(selected, currentState, 'Callback must use current props, not a stale frame');
});
