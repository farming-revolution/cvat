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
    f.server.annotations.updateAnnotations = async () => ({tags:[],shapes:[],tracks:[],frame_save_revision:'new-annotations:new-shared'});
    await f.saver._request({tags:[],shapes:[],tracks:[]}, 'update');
    f.setRequest(async (_id, body) => {
        assert.equal(body.baseline_revision, 'new-annotations:old-shared');
        return f.saved(body);
    });
    await f.saver.saveWithFrames([3]);
});
