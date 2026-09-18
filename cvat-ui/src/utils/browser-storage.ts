// Copyright (C) 2026 Farming Revolution
//
// SPDX-License-Identifier: MIT

import notification from 'antd/lib/notification';

const reportedFailures = new Set<string>();

export function reportBrowserStorageFailure(
    key: string, operation: 'read' | 'write', error: unknown,
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

    notification.warning({
        key: `cvat-browser-storage-${failureID}`,
        message: operation === 'write' ? 'Could not remember your preferences' : 'Could not restore your preferences',
        description: `${reason} ${operation === 'write' ?
            'Your changes remain active in this tab, but may not survive a reload.' :
            'CVAT will continue with the available settings.'}`,
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
        reportBrowserStorageFailure(key, 'write', error);
        return false;
    }
}
