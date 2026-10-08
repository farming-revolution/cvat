// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT

import { reportBrowserStorageFailure, writeBrowserPreference } from './browser-storage';

export type TagShortcutPreferences = Record<string, string | null>;
type ShortcutLabel = { id?: number | null; name: string };
const remembered = new Map<string, TagShortcutPreferences | null>();
export const tagShortcutNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];

export function readTagShortcuts(key: string | null): TagShortcutPreferences | null {
    if (!key) return null;
    if (remembered.has(key)) return remembered.get(key)!;
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
            Object.entries(parsed).some(([slot, value]) => !/^[0-9]$/.test(slot) ||
                (value !== null && typeof value !== 'string'))) {
            throw new SyntaxError('Invalid tag shortcut preferences');
        }
        remembered.set(key, parsed);
        return parsed;
    } catch (error) {
        reportBrowserStorageFailure(key, 'read', error);
        return null;
    }
}

export function writeTagShortcuts(key: string | null, choices: TagShortcutPreferences): void {
    if (!key) return;
    // Retain choices through workspace switches even when browser storage is unavailable.
    remembered.set(key, choices);
    writeBrowserPreference(key, JSON.stringify(choices));
}

export function resolveTagShortcuts(
    labels: ShortcutLabel[], preferences: TagShortcutPreferences | null,
): Record<number, number | ''> {
    return Object.fromEntries(tagShortcutNumbers.map((slot, index) => {
        const label = preferences === null ? labels[index] :
            labels.find((candidate) => candidate.name === preferences[slot]);
        return [slot, label?.id ?? ''];
    }));
}
