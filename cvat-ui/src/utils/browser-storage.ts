// Copyright (C) 2026 Farming Revolution
//
// SPDX-License-Identifier: MIT

import notification from 'antd/lib/notification';

const reportedFailures = new Set<string>();

// These are UTF-16 size estimates, not the browser's quota accounting.
function estimatedBytes(key: string, value: string): number {
    return (key.length + value.length) * 2;
}

export function reportBrowserStorageFailure(
    key: string, operation: 'read' | 'write', error: unknown, value?: string,
): void {
    const failureID = `${operation}:${key}`;
    if (reportedFailures.has(failureID)) return;
    reportedFailures.add(failureID);

    const errorName = error instanceof Error || error instanceof DOMException ? error.name : 'UnknownError';
    let reason = 'The browser could not access local preferences.';
    if (errorName === 'QuotaExceededError' || errorName === 'NS_ERROR_DOM_QUOTA_REACHED') {
        reason = 'The browser storage quota was exceeded, or browser restrictions prevent storing data.';
    } else if (errorName === 'SecurityError') {
        reason = 'Browser security or privacy settings blocked access to local preferences.';
    } else if (errorName === 'SyntaxError') {
        reason = 'The saved preferences contain invalid JSON.';
    }

    const diagnostics: Record<string, unknown> = {
        operation,
        key,
        errorName,
        // Other errors (e.g. JSON parse errors) can include saved values in their messages.
        browserMessage: error instanceof DOMException ? error.message : undefined,
        reason,
        attemptedEntryEstimatedBytes: value === undefined ? undefined : estimatedBytes(key, value),
        sizeAccounting: 'Approximate UTF-16 bytes including keys; actual browser accounting may differ.',
        quota: 'The browser does not expose the localStorage quota or remaining space.',
    };

    try {
        const storage = window.localStorage;
        const entries: { key: string; estimatedBytes: number }[] = [];
        for (let index = 0; index < storage.length; index++) {
            const entryKey = storage.key(index);
            if (entryKey !== null) {
                entries.push({ key: entryKey, estimatedBytes: estimatedBytes(entryKey, storage.getItem(entryKey) || '') });
            }
        }
        const previousValue = storage.getItem(key);
        const previousBytes = previousValue === null ? 0 : estimatedBytes(key, previousValue);
        Object.assign(diagnostics, {
            entryCount: entries.length,
            totalEstimatedBytes: entries.reduce((total, entry) => total + entry.estimatedBytes, 0),
            previousEntryEstimatedBytes: previousBytes,
            estimatedGrowthBytes: value === undefined ? undefined : estimatedBytes(key, value) - previousBytes,
            largestEntries: entries.sort((left, right) => right.estimatedBytes - left.estimatedBytes).slice(0, 10),
        });
    } catch {
        diagnostics.storageInspection = 'Unavailable: the browser also rejected reading localStorage.';
    }

    console.warn('[CVAT] Browser preference storage failed', diagnostics);
    notification.warning({
        key: `cvat-browser-storage-${failureID}`,
        message: operation === 'write' ? 'Could not remember your preferences' : 'Could not restore your preferences',
        description: `${reason} ${operation === 'write' ?
            'Your changes remain active in this tab, but may not survive a reload.' :
            'CVAT will continue with the available settings.'} Details are in the browser console (${key}).`,
        duration: 0,
        className: 'cvat-notification-browser-storage-failed',
    });
}

// Preferences are optional persistence. Never delete existing data to make room.
export function writeBrowserPreference(key: string, value: string): boolean {
    try {
        window.localStorage.setItem(key, value);
        return true;
    } catch (error: unknown) {
        reportBrowserStorageFailure(key, 'write', error, value);
        return false;
    }
}
