// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import { ChunkQuality } from 'cvat-data';

// Persistent on-disk cache for job data chunks, backed by the browser Cache Storage API.
// Once a chunk has been fetched (e.g. via the "Preload" button), it is stored on the user's
// disk so subsequent reads are served locally without re-downloading over a slow connection.
// Entries live until the cache is cleared or the browser evicts them under storage pressure.
const LOCAL_CHUNK_CACHE_NAME = 'cvat-job-chunks-v1';

function isSupported(): boolean {
    return typeof window !== 'undefined' && typeof window.caches !== 'undefined';
}

function makeChunkKey(jid: number, chunk: number, quality: ChunkQuality): string {
    // A synthetic, same-origin URL used purely as the Cache Storage key.
    return `${window.location.origin}/__cvat_local_chunk_cache__/jobs/${jid}/${quality}/${chunk}`;
}

export function isLocalChunkCacheSupported(): boolean {
    return isSupported();
}

// Ask the browser to mark the origin storage as persistent so it is not evicted automatically.
// Returns true if storage is persistent (already or after granting). Best-effort: never throws.
export async function requestPersistentStorage(): Promise<boolean> {
    try {
        if (navigator.storage?.persisted && await navigator.storage.persisted()) {
            return true;
        }
        if (navigator.storage?.persist) {
            return await navigator.storage.persist();
        }
    } catch (error) {
        // ignore
    }
    return false;
}

export async function estimateLocalChunkStorage(): Promise<{ quota: number; usage: number } | null> {
    try {
        if (navigator.storage?.estimate) {
            const { quota = 0, usage = 0 } = await navigator.storage.estimate();
            return { quota, usage };
        }
    } catch (error) {
        // ignore
    }
    return null;
}

export async function getLocalChunk(
    jid: number, chunk: number, quality: ChunkQuality,
): Promise<ArrayBuffer | null> {
    if (!isSupported()) {
        return null;
    }

    try {
        const cache = await window.caches.open(LOCAL_CHUNK_CACHE_NAME);
        const response = await cache.match(makeChunkKey(jid, chunk, quality));
        if (response) {
            return await response.arrayBuffer();
        }
    } catch (error) {
        // ignore and fall back to network
    }

    return null;
}

export async function putLocalChunk(
    jid: number, chunk: number, quality: ChunkQuality, data: ArrayBuffer,
): Promise<void> {
    if (!isSupported()) {
        return;
    }

    try {
        const cache = await window.caches.open(LOCAL_CHUNK_CACHE_NAME);
        await cache.put(
            makeChunkKey(jid, chunk, quality),
            new Response(data, { headers: { 'Content-Type': 'application/octet-stream' } }),
        );
    } catch (error) {
        // QuotaExceededError or any other failure: keep working, just without local persistence.
    }
}

export async function clearLocalChunkCache(): Promise<void> {
    if (!isSupported()) {
        return;
    }

    try {
        await window.caches.delete(LOCAL_CHUNK_CACHE_NAME);
    } catch (error) {
        // ignore
    }
}
