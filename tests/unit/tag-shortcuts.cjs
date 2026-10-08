// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
// node --test tests/unit/tag-shortcuts.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function fixture(storage = new Map()) {
    let fail = false;
    const errors = [];
    const module = { exports: {} };
    const { outputText } = ts.transpileModule(fs.readFileSync(path.resolve(
        __dirname, '../../cvat-ui/src/utils/tag-shortcuts.ts',
    ), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
    const context = vm.createContext({ module, exports: module.exports, window: {
        localStorage: { getItem: (key) => { if (fail) throw Error('blocked'); return storage.get(key) ?? null; } },
    }, require: () => ({
        reportBrowserStorageFailure: (...args) => errors.push(args),
        writeBrowserPreference: (key, value) => { if (fail) return false; storage.set(key, value); return true; },
    }) });
    vm.runInContext(outputText, context);
    return { ...module.exports, storage, errors, fail: () => { fail = true; } };
}
const labels = [{ id: 1, name: 'Absent: Giftpflanze' }, { id: 2, name: 'Absent: Kreuzkraut' }];

test('assignments survive workspace remount and full module reload, including None', () => {
    const first = fixture();
    first.writeTagShortcuts('user:1:project:5', { 1: labels[1].name, 2: null });
    for (const f of [first, fixture(first.storage)]) {
        const choices = f.resolveTagShortcuts(labels, f.readTagShortcuts('user:1:project:5'));
        assert.equal(choices[1], 2);
        assert.equal(choices[2], '');
    }
});
test('choices remain independent for users and projects', () => {
    const f = fixture();
    f.writeTagShortcuts('user:1:project:5', { 1: labels[1].name });
    assert.equal(f.resolveTagShortcuts(labels, f.readTagShortcuts('user:2:project:5'))[1], 1);
    assert.equal(f.resolveTagShortcuts(labels, f.readTagShortcuts('user:1:project:6'))[1], 1);
});
test('names restore current IDs and unavailable labels do not trigger another label', () => {
    const f = fixture();
    f.writeTagShortcuts('test', { 1: labels[1].name });
    assert.equal(f.resolveTagShortcuts([{ id: 90, name: labels[1].name }], f.readTagShortcuts('test'))[1], 90);
    assert.equal(f.resolveTagShortcuts([labels[0]], f.readTagShortcuts('test'))[1], '');
});
test('storage failure preserves choices in this tab across workspace remounts', () => {
    const f = fixture(); f.fail();
    f.writeTagShortcuts('test', { 1: labels[1].name });
    assert.equal(f.resolveTagShortcuts(labels, f.readTagShortcuts('test'))[1], 2);
});
test('malformed stored preferences fall back safely', () => {
    for (const bad of ['{', '[]', '{"1":42}', '{"x":"weed"}']) {
        const f = fixture(new Map([['test', bad]]));
        assert.equal(f.readTagShortcuts('test'), null);
        assert.equal(f.errors.length, 1);
    }
});
