// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import { ChunkQuality } from 'cvat-data';

const LOCAL_CHUNK_CACHE_NAME = 'cvat-job-chunks-v1';
// Quotas may be shared with other applications on the same site. Leave room for their
// small writes and for Cache Storage's own cleanup transactions, even in persistent mode.
const FREE_SPACE_RESERVE = 512 * 1024 * 1024;
const ENTRY_OVERHEAD = 64 * 1024;

export function isLocalChunkCacheSupported(): boolean {
    // A cross-tab lock keeps simultaneous downloads/clears from overspending the same budget.
    return typeof window !== 'undefined' && !!window.caches && !!navigator.locks;
}

function withCacheLock<T>(action: () => Promise<T>): Promise<T> {
    return navigator.locks.request(LOCAL_CHUNK_CACHE_NAME, action);
}

function makeChunkKey(jid: number, chunk: number, quality: ChunkQuality): string {
    return `${window.location.origin}/__cvat_local_chunk_cache__/jobs/${jid}/${quality}/${chunk}`;
}

// Best-effort: denying persistence must not prevent annotation or network downloads.
export async function requestPersistentStorage(): Promise<boolean> {
    try {
        if (navigator.storage?.persisted && await navigator.storage.persisted()) {
            return true;
        }
        if (navigator.storage?.persist) {
            return await navigator.storage.persist();
        }
    } catch (error) {
        // The bounded cache also works with best-effort storage.
    }
    return false;
}

export async function estimateLocalChunkStorage(): Promise<{ quota: number; usage: number } | null> {
    try {
        if (navigator.storage?.estimate) {
            const { quota, usage } = await navigator.storage.estimate();
            if (Number.isFinite(quota) && quota > 0 && Number.isFinite(usage) && usage >= 0) {
                return { quota, usage };
            }
        }
    } catch (error) {
        // Without a usable estimate, do not add to browser storage.
    }
    return null;
}

async function makeRoom(cache: Cache, incomingBytes: number): Promise<boolean> {
    const estimate = await estimateLocalChunkStorage();
    if (!estimate || incomingBytes + FREE_SPACE_RESERVE > estimate.quota) return false;
    const needed = estimate.usage + incomingBytes + FREE_SPACE_RESERVE - estimate.quota;
    if (needed <= 0) return true;

    // Cache.keys() preserves insertion order: evict the oldest downloaded chunks first.
    // Measure legacy responses lazily, only under pressure. New writes carry their byte size.
    let removed = 0;
    for (const key of await cache.keys()) {
        const response = await cache.match(key);
        if (!response) continue;
        const header = response.headers.get('Content-Length');
        let size = Number(header);
        if (header === null || !Number.isSafeInteger(size) || size < 0) {
            size = (await response.blob()).size;
        } else {
            // Release the response stream before deletion, so Firefox can reclaim the file.
            await response.body?.cancel();
        }
        if (await cache.delete(key)) removed += size;
        if (removed >= needed) return true;
    }
    // Other origins may own the remaining usage. Never clear their data or overfill the quota.
    return false;
}

export async function getLocalChunk(
    jid: number, chunk: number, quality: ChunkQuality,
): Promise<ArrayBuffer | null> {
    if (!isLocalChunkCacheSupported()) return null;
    try {
        return await withCacheLock(async () => {
            const cache = await window.caches.open(LOCAL_CHUNK_CACHE_NAME);
            // Also reduce an existing large cache while browsing, not only on new writes.
            await makeRoom(cache, 0);
            const response = await cache.match(makeChunkKey(jid, chunk, quality));
            return response ? response.arrayBuffer() : null;
        });
    } catch (error) {
        // A broken/full cache must not stop frames loading from the server.
        return null;
    }
}

export async function putLocalChunk(
    jid: number, chunk: number, quality: ChunkQuality, data: ArrayBuffer,
): Promise<boolean> {
    if (!isLocalChunkCacheSupported()) return false;
    try {
        return await withCacheLock(async () => {
            const cache = await window.caches.open(LOCAL_CHUNK_CACHE_NAME);
            const key = makeChunkKey(jid, chunk, quality);
            if (!await makeRoom(cache, data.byteLength + ENTRY_OVERHEAD)) return false;
            // Move a replacement to the end of the FIFO and avoid counting both copies.
            await cache.delete(key);
            await cache.put(key, new Response(data, {
                headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.byteLength) },
            }));
            return true;
        });
    } catch (error) {
        // Normal frame loading remains usable; preload verifies what was actually retained.
        return false;
    }
}

export async function countLocalJobChunks(jid: number, quality: ChunkQuality, total: number): Promise<number> {
    if (!isLocalChunkCacheSupported()) return 0;
    return withCacheLock(async () => {
        if (!await window.caches.has(LOCAL_CHUNK_CACHE_NAME)) return 0;
        const cache = await window.caches.open(LOCAL_CHUNK_CACHE_NAME);
        const urls = new Set((await cache.keys()).map((key) => key.url));
        let count = 0;
        for (let chunk = 0; chunk < total; chunk++) {
            if (urls.has(makeChunkKey(jid, chunk, quality))) count++;
        }
        return count;
    });
}

export async function clearLocalChunkCache(): Promise<void> {
    if (!isLocalChunkCacheSupported()) throw new Error('Local frame caching is unavailable in this browser.');
    // Let errors reach the UI. Previously this hid quota failures behind a success notification.
    await withCacheLock(async () => {
        await window.caches.delete(LOCAL_CHUNK_CACHE_NAME);
        if (await window.caches.has(LOCAL_CHUNK_CACHE_NAME)) {
            throw new Error('The browser did not remove the frame cache.');
        }
    });
}
