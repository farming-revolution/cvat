// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
import { getCore } from 'cvat-core-wrapper';
import { HeightMetadata } from './estimate';

type Listener = () => void;
export interface MetadataEntry {
    jobID: number;
    value: HeightMetadata | null;
    reason: string;
    listeners: Set<Listener>;
    request: Promise<void> | null;
    checked: number;
}
let current: MetadataEntry | null = null;

export function jobMetadata(jobID: number): MetadataEntry {
    if (!current || current.jobID !== jobID) {
        current = {
            jobID,
            value: null,
            reason: 'Loading projection information…',
            listeners: new Set(),
            request: null,
            checked: 0,
        };
    }
    return current;
}

export async function refreshMetadata(entry: MetadataEntry, force = false): Promise<void> {
    if (entry.request) return entry.request;
    if (!force && entry.checked) return Promise.resolve();
    entry.request = (async () => {
        let value: HeightMetadata | null = null;
        let reason = 'Projection information unavailable. Synchronize the task and reload CVAT.';
        try {
            const response = await getCore().server.request(`/api/jobs/${entry.jobID}/height-diagnostic`,
                { method: 'get', timeout: 5000 }) as { data: HeightMetadata };
            const candidate = response.data;
            if (candidate?.version === 1 && candidate.status === 'available' &&
                Array.isArray(candidate.bags) && Array.isArray(candidate.frames) &&
                Array.isArray(candidate.deleted_frames) && typeof candidate.frame_fingerprint === 'string') {
                value = candidate;
                reason = '';
            } else if (candidate?.version === 1 && typeof candidate.reason === 'string') {
                reason = candidate.reason;
            }
        } catch (_) {
            // Missing endpoints and metadata must never affect labeling or saving.
        }
        entry.checked = Date.now();
        if (JSON.stringify(entry.value) !== JSON.stringify(value) || entry.reason !== reason) {
            entry.value = value;
            entry.reason = reason;
            entry.listeners.forEach((listener) => listener());
        }
    })().finally(() => { entry.request = null; });
    return entry.request;
}

window.addEventListener('focus', () => {
    if (current && current.listeners.size && Date.now() - current.checked > 30000) {
        refreshMetadata(current, true);
    }
});
