// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
// node --test tests/unit/frames-local-cache.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync('cvat-core/src/frames-local-cache.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const MiB = 1024 * 1024;
const reserve = 512 * MiB;
const name = 'cvat-job-chunks-v1';
const origin = 'https://test.invalid';
const key = (chunk, job = 1, quality = 'compressed') => `${origin}/__cvat_local_chunk_cache__/jobs/${job}/${quality}/${chunk}`;

function fixture(options = {}) {
    const entries = new Map();
    let exists = true;
    let tail = Promise.resolve();
    let writes = 0;
    const size = () => [...entries.values()].reduce((n, entry) => n + entry.size, 0);
    const cache = {
        keys: async () => [...entries.keys()].map((url) => new Request(url)),
        match: async (request) => {
            const entry = entries.get(typeof request === 'string' ? request : request.url);
            if (!entry) return undefined;
            // Each real Cache.match has an independent body, unlike Response.clone's tee.
            return {
                headers: entry.response.headers, body: { cancel: async () => {} },
                blob: () => entry.response.clone().blob(),
                arrayBuffer: () => entry.response.clone().arrayBuffer(),
            };
        },
        delete: async (request) => {
            if (options.failDelete) throw new DOMException('No device space', 'NS_ERROR_FILE_NO_DEVICE_SPACE');
            return entries.delete(typeof request === 'string' ? request : request.url);
        },
        put: async (url, response) => {
            writes++;
            if (options.failPut) throw new DOMException('Quota exceeded', 'QuotaExceededError');
            await new Promise((resolve) => setTimeout(resolve, 2));
            entries.set(url, { size: Number(response.headers.get('Content-Length')), response });
        },
    };
    const caches = {
        open: async (cacheName) => {
            assert.equal(cacheName, name);
            if (options.failOpen) throw new Error('Cache disabled');
            exists = true;
            return cache;
        },
        has: async () => exists,
        delete: async (cacheName) => {
            assert.equal(cacheName, name);
            if (options.failDelete) throw new DOMException('No device space', 'NS_ERROR_FILE_NO_DEVICE_SPACE');
            if (options.silentDelete) return true;
            entries.clear();
            exists = false;
            return true;
        },
    };
    const navigator = {
        locks: { request: (_name, action) => {
            const result = tail.then(action);
            tail = result.catch(() => {});
            return result;
        } },
        storage: { estimate: async () => {
            if (options.failEstimate) throw new Error('Estimate unavailable');
            return { quota: options.quota ?? 10 * 1024 * MiB, usage: (options.otherUsage ?? 0) + size() };
        } },
    };
    if (options.noLocks) delete navigator.locks;
    const load = () => {
        const exports = {};
        vm.runInNewContext(source, { exports, navigator, window: { caches, location: { origin } }, Response });
        return exports;
    };
    return {
        api: load(), load, entries, size, writes: () => writes,
        seed: (chunk, bytes, { legacy = false, job = 1, quality = 'compressed' } = {}) => entries.set(key(chunk, job, quality), {
            size: bytes,
            response: new Response(legacy ? new Uint8Array(bytes) : 'body', {
                headers: legacy ? {} : { 'Content-Length': String(bytes) },
            }),
        }),
    };
}

test('uses available quota without a fixed 2 GiB cache cap', async () => {
    const f = fixture();
    f.seed(0, 3 * 1024 * MiB);
    assert.equal(await f.api.putLocalChunk(1, 1, 'compressed', new ArrayBuffer(10)), true);
    assert.equal(f.entries.size, 2);
    assert.ok(f.size() > 2 * 1024 * MiB);
});

test('evicts oldest chunks before writing and leaves 512 MiB plus overhead free', async () => {
    const f = fixture({ quota: reserve + 200000 });
    f.seed(0, 100000);
    f.seed(1, 90000);
    assert.equal(await f.api.putLocalChunk(1, 2, 'compressed', new ArrayBuffer(20000)), true);
    assert.deepEqual([...f.entries.keys()], [key(1), key(2)]);
    assert.ok(f.size() + reserve <= reserve + 200000);
});

test('accounts for other origins and does not write when they occupy the reserve', async () => {
    const f = fixture({ quota: reserve + MiB, otherUsage: 2 * MiB });
    f.seed(0, 1000);
    assert.equal(await f.api.putLocalChunk(1, 1, 'compressed', new ArrayBuffer(20)), false);
    assert.equal(f.writes(), 0);
    assert.equal(f.entries.size, 0);
});

test('reclaims legacy responses without size headers under storage pressure', async () => {
    const f = fixture({ quota: reserve + 100000 });
    f.seed(0, 50000, { legacy: true });
    assert.equal(await f.api.putLocalChunk(1, 1, 'compressed', new ArrayBuffer(10000)), true);
    assert.deepEqual([...f.entries.keys()], [key(1)]);
});

test('browsing trims existing cache even when no new chunks are written', async () => {
    const f = fixture({ quota: reserve + 100000 });
    f.seed(0, 150000);
    f.seed(1, 10000);
    assert.ok(await f.api.getLocalChunk(1, 1, 'compressed'));
    assert.deepEqual([...f.entries.keys()], [key(1)]);
});

test('concurrent writes from separate tabs share the quota lock', async () => {
    const f = fixture({ quota: reserve + 100000 });
    const otherTab = f.load();
    assert.deepEqual(await Promise.all([
        f.api.putLocalChunk(1, 0, 'compressed', new ArrayBuffer(32000)),
        otherTab.putLocalChunk(1, 1, 'compressed', new ArrayBuffer(32000)),
    ]), [true, true]);
    assert.deepEqual([...f.entries.keys()], [key(1)]);
});

for (const option of ['failEstimate', 'failOpen', 'failPut', 'noLocks']) {
    test(`${option} does not prevent network frame loading or claim cache success`, async () => {
        const f = fixture({ [option]: true });
        assert.equal(await f.api.putLocalChunk(1, 0, 'compressed', new ArrayBuffer(1)), false);
        assert.equal(await f.api.getLocalChunk(1, 0, 'compressed'), null);
        assert.equal(f.entries.size, 0);
    });
}

test('preload counts only retained compressed chunks for the requested job and range', async () => {
    const f = fixture();
    f.seed(0, 10);
    f.seed(2, 10);
    f.seed(7, 10);
    f.seed(1, 10, { quality: 'original' });
    f.seed(1, 10, { job: 2 });
    assert.equal(await f.api.countLocalJobChunks(1, 'compressed', 3), 2);
});

for (const option of ['failDelete', 'silentDelete']) {
    test(`clear reports ${option} instead of pretending it succeeded`, async () => {
        const f = fixture({ [option]: true });
        f.seed(0, 10);
        await assert.rejects(f.api.clearLocalChunkCache());
        assert.equal(f.entries.size, 1);
    });
}

test('clear removes only the image cache and permits subsequent caching', async () => {
    const f = fixture();
    f.seed(0, 10);
    await f.api.clearLocalChunkCache();
    assert.equal(f.entries.size, 0);
    assert.equal(await f.api.putLocalChunk(1, 1, 'compressed', new ArrayBuffer(1)), true);
});


test('a single oversized chunk does not clear otherwise useful cached frames', async () => {
    const f = fixture({ quota: reserve + 100000 });
    f.seed(0, 1000);
    assert.equal(await f.api.putLocalChunk(1, 1, 'compressed', new ArrayBuffer(100001)), false);
    assert.equal(f.entries.size, 1);
    assert.equal(f.writes(), 0);
});

test('failed eviction does not write into an already full cache', async () => {
    const f = fixture({ quota: reserve + 100000, failDelete: true });
    f.seed(0, 90000);
    assert.equal(await f.api.putLocalChunk(1, 1, 'compressed', new ArrayBuffer(20000)), false);
    assert.equal(f.entries.size, 1);
    assert.equal(f.writes(), 0);
});
