// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function fixture() {
    let request;
    const exports = {};
    const server = { annotations: { saveAnnotationsWithFrames: async (...args) => request(...args) } };
    const source = ts.transpileModule(fs.readFileSync('cvat-core/src/annotations-saver.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(source, { exports, console, setTimeout, require: (name) => {
        if (name === './server-proxy') return { __esModule: true, default: server };
        if (name === './session') return { Task: class Task {} };
        if (name === './exceptions') return { DataError: Error, ServerError: Error };
        throw new Error(name);
    } });
    let data = { tags: [], shapes: [], tracks: [{ clientID: 1, id: 100, frame: 0, label_id: 1, shapes: [] }] };
    const collection = { flush: false, export: () => structuredClone(data), objects: {
        1: { updateFromServerResponse: (saved) => { data.tracks[0] = { ...saved, clientID: 1 }; },
            get serverID() { return data.tracks[0].id; }, set serverID(id) { data.tracks[0].id = id; } },
    } };
    const saver = new exports.default(0, collection, { id: 42 }, 'initial');
    return { saver, collection, data, server, setRequest: (fn) => { request = fn; },
        saved: (body) => ({ ...structuredClone(body.annotations), version: 0, frame_save_revision: 'saved' }) };
}
test('combined save sends one full snapshot and retains IDs; no annotation request required afterward', async () => {
    const f = fixture(); f.data.tracks[0].shapes.push({ frame: 1, points: [10, 20] }); let calls = 0;
    f.setRequest(async (id, body) => {
        assert.equal(id, 42); assert.equal(body.baseline_revision, 'initial');
        assert.equal(body.annotations.tracks[0].id, 100);
        assert.equal(body.annotations.tracks[0].clientID, undefined);
        assert.deepEqual(body.deleted_frames, [3]); calls++;
        return f.saved(body);
    });
    await f.saver.saveWithFrames([3]); assert.equal(calls, 1); assert.equal(f.saver.hasUnsavedChanges(), false);
    const split = f.saver._split(f.collection.export());
    assert.equal(Object.values(split).flatMap(Object.values).flat().length, 0);
});
test('failed or stale save retains local edits and the original baseline for retry', async () => {
    const f = fixture(); f.data.tracks[0].shapes.push({ frame: 2, points: [30, 40] });
    const before = structuredClone(f.data); f.setRequest(async () => { throw new Error('409 stale'); });
    await assert.rejects(f.saver.saveWithFrames([3]), /409/);
    assert.deepEqual(f.data, before); assert.equal(f.saver.hasUnsavedChanges(), true);
    f.setRequest(async (_id, body) => { assert.equal(body.baseline_revision, 'initial'); return f.saved(body); });
    await f.saver.saveWithFrames([3]); assert.equal(f.saver.hasUnsavedChanges(), false);
});
test('new edits during the HTTP request survive response reconciliation', async () => {
    const f = fixture(); f.data.tracks[0].shapes.push({ frame: 2, points: [30, 40] });
    f.setRequest(async (_id, body) => {
        f.data.tracks[0].shapes[0].points = [90, 100]; return f.saved(body);
    });
    await f.saver.saveWithFrames([3]);
    assert.deepEqual(f.data.tracks[0].shapes[0].points, [90, 100]);
    assert.equal(f.saver.hasUnsavedChanges(), true);
    assert.equal(f.saver._split(f.collection.export()).updated.tracks.length, 1);
});

test('metadata acknowledgement preserves deletions/restores made while saving', () => {
    const commonExports = {};
    const common = fs.readFileSync('cvat-core/src/common.ts', 'utf8');
    const fieldClass = common.slice(common.indexOf('export class FieldUpdateTrigger'), common.indexOf('export function camelToSnakeCase'));
    vm.runInNewContext(ts.transpileModule(fieldClass, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, { exports: commonExports });
    const frameExports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('cvat-core/src/frames.ts', 'utf8'), { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText, { exports: frameExports, require: (name) => {
        if (name === 'lodash') return require('lodash');
        if (name === './common') return commonExports;
        return {};
    } });
    const meta = new frameExports.FramesMetaData({ chunk_size: 36, deleted_frames: {}, frame_filter: '',
        start_frame: 0, stop_frame: 11, frames: [{ width: 100, height: 100 }], size: 12 });
    meta.deletedFrames[3] = true;
    const sent = [3];
    meta.deletedFrames[7] = true; delete meta.deletedFrames[3];
    meta.acknowledgeDeletedFrames(sent);
    assert.deepEqual(Object.keys(meta.deletedFrames), ['7']);
    assert.equal(meta.getUpdated().deletedFrames[3], 'restored');
    assert.equal(meta.getUpdated().deletedFrames[7], 'deleted');
    meta.acknowledgeDeletedFrames([7]);
    assert.equal(meta.getUpdated().deletedFrames, undefined);
    meta.deletedFrames[9] = true;
    meta.acceptDeletedFrames([2, 7]);
    assert.deepEqual(Object.keys(meta.deletedFrames), ['2', '7', '9']);
    assert.equal(meta.getUpdated().deletedFrames[9], 'deleted');
    assert.equal(Object.keys(meta.getUpdated().deletedFrames).length, 1);
});

test('normal saves keep the old shared-frame baseline when another job changes frames concurrently', async () => {
    const f = fixture(); f.saver.frameRevision = 'old-annotations:old-shared';
    f.server.annotations.updateAnnotations = async () => ({tags:[],shapes:[],tracks:[],frame_save_revision:'new-annotations:new-shared',frame_save_parent_revision:'old-annotations:old-shared'});
    await f.saver._request({tags:[],shapes:[],tracks:[]}, 'update');
    f.setRequest(async (_id, body) => {
        assert.equal(body.baseline_revision, 'new-annotations:old-shared');
        return f.saved(body);
    });
    await f.saver.saveWithFrames([3]);
});

for (const mode of ['wrong-proof', 'stale-baseline', 'old-server']) {
    test(`normal save cannot certify unseen annotations: ${mode}`, async () => {
        const f = fixture(); f.saver.frameRevision = 'known:shared';
        f.server.annotations.updateAnnotations = async (_type, _id, _data, _action, baseline) => {
            assert.equal(baseline, 'known:shared');
            return { tags: [], shapes: [], tracks: [],
                ...(mode === 'stale-baseline' ? {} : { frame_save_revision: 'unseen:shared' }),
                ...(mode === 'wrong-proof' ? { frame_save_parent_revision: 'other:shared' } : {}) };
        };
        await f.saver._request({ tags: [], shapes: [], tracks: [] }, 'update');
        f.setRequest(async (_id, body) => {
            assert.equal(body.baseline_revision, 'known:shared');
            throw new Error('409 stale');
        });
        await assert.rejects(f.saver.saveWithFrames([3]), /409 stale/);
    });
}
test('successive normal writes send the last verified baseline, retaining the original shared state', async () => {
    const f = fixture(); f.saver.frameRevision = 'a:shared'; let step = 0;
    f.server.annotations.updateAnnotations = async (_type, _id, _data, action, baseline) => {
        const expected = ['a', 'b', 'c'][step]; const next = ['b', 'c', 'd'][step++];
        assert.equal(baseline, `${expected}:shared`);
        assert.equal(action, ['update', 'delete', 'create'][step - 1]);
        return { tags: [], shapes: [], tracks: [], frame_save_revision: `${next}:new-shared`,
            frame_save_parent_revision: baseline };
    };
    for (const action of ['update', 'delete', 'create']) await f.saver._request({}, action);
    assert.equal(f.saver.frameRevision, 'd:shared');
});
test('a failed normal request retains the baseline for a conservative retry', async () => {
    const f = fixture(); f.saver.frameRevision = 'known:shared';
    f.server.annotations.updateAnnotations = async () => { throw new Error('response lost'); };
    await assert.rejects(f.saver._request({}, 'update'), /response lost/);
    assert.equal(f.saver.frameRevision, 'known:shared');
});

test('an out-of-order normal response cannot replace a newer baseline', async () => {
    const f = fixture(); f.saver.frameRevision = 'known:shared';
    f.server.annotations.updateAnnotations = async () => {
        f.saver.frameRevision = 'newer:shared';
        return { frame_save_revision: 'older:shared', frame_save_parent_revision: 'known:shared' };
    };
    await f.saver._request({}, 'update');
    assert.equal(f.saver.frameRevision, 'newer:shared');
});
test('HTTP transport sends job baseline and reads proof headers without changing annotation JSON', async () => {
    const proxy = fs.readFileSync('cvat-core/src/server-proxy.ts', 'utf8');
    const source = proxy.slice(proxy.indexOf('async function updateAnnotations('), proxy.indexOf('// Session is', proxy.indexOf('async function updateAnnotations(')));
    let last; const api = {};
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\napi.update = updateAnnotations;', {
        api, config: { backendAPI: '/api' }, generateError: e => e,
        Axios: async (url, options) => {
            last = { url, options };
            return { data: { tags: [], shapes: [], tracks: [] }, headers: {
                'x-cvat-frame-save-revision': 'after:shared', 'x-cvat-frame-save-parent-revision': 'before:shared',
            } };
        },
    });
    const body = { tags: [], shapes: [], tracks: [] };
    const response = await api.update('job', 42, body, 'update', 'before:shared');
    assert.equal(last.url, '/api/jobs/42/annotations');
    assert.equal(last.options.headers['X-CVAT-Frame-Save-Baseline'], 'before:shared');
    assert.equal(last.options.data, body);
    assert.equal(response.frame_save_parent_revision, 'before:shared');
    await api.update('task', 7, body, 'update', 'before:shared');
    assert.equal(last.options.headers['X-CVAT-Frame-Save-Baseline'], undefined);
});
