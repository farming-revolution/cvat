// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
// Run: node --test tests/unit/browser-storage.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function fixture(initial = {}) {
    const entries = new Map(Object.entries(initial));
    const warnings = [];
    const notifications = [];
    let writeError;
    let accessError;
    const storage = {
        get length() { return entries.size; },
        key: (index) => [...entries.keys()][index] ?? null,
        getItem: (key) => entries.get(key) ?? null,
        setItem(key, value) {
            if (writeError) throw writeError;
            entries.set(key, value);
        },
    };
    const browser = {
        get localStorage() {
            if (accessError) throw accessError;
            return storage;
        },
    };
    const context = vm.createContext({
        window: browser,
        get localStorage() { return browser.localStorage; },
        Error,
        DOMException,
        console: { warn: (...args) => warnings.push(args) },
    });
    const modules = new Map();
    const mocks = {
        'antd/lib/notification': { warning: (args) => notifications.push(args) },
        config: { LOCAL_STORAGE_LAST_FRAME_MEMORY_LIMIT: 20 },
        lodash: {},
        'utils/image-processing': { ImageFilterAlias: { GAMMA_CORRECTION: 'gamma' } },
        'utils/fabric-wrapper/gamma-correction': {},
        'utils/conflict-detector': {},
        './shortcuts-actions': {},
    };
    function load(relative) {
        if (modules.has(relative)) return modules.get(relative).exports;
        const filename = path.resolve(__dirname, '../../cvat-ui/src', relative);
        const source = fs.readFileSync(filename, 'utf8');
        const { outputText } = ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
        });
        const module = { exports: {} };
        modules.set(relative, module);
        const requireSource = (name) => {
            if (name === 'utils/browser-storage' || name === './browser-storage') return load('utils/browser-storage.ts');
            if (Object.hasOwn(mocks, name)) return mocks[name];
            throw new Error(`Unexpected dependency: ${name}`);
        };
        vm.runInContext(`(function(require, module, exports) { ${outputText}\n})`, context, { filename })(
            requireSource, module, module.exports,
        );
        return module.exports;
    }
    return {
        load, entries, warnings, notifications, storage,
        failWrites(error = new DOMException('The quota has been exceeded.', 'QuotaExceededError')) {
            writeError = error;
        },
        denyAccess() { accessError = new DOMException('Access denied', 'SecurityError'); },
        recover() { writeError = undefined; accessError = undefined; },
    };
}

test('replaces preferences normally without accumulating copies or issuing a warning', () => {
    const f = fixture({ clientSettings: 'old' });
    const { writeBrowserPreference } = f.load('utils/browser-storage.ts');
    assert.equal(writeBrowserPreference('clientSettings', 'new'), true);
    assert.equal(f.entries.get('clientSettings'), 'new');
    assert.equal(f.entries.size, 1);
    assert.equal(f.warnings.length, 0);
    assert.equal(f.notifications.length, 0);
});

test('quota failure keeps old data and shows a concise warning without debug output', () => {
    const f = fixture({ clientSettings: 'old-secret', largeEntry: 'private-value'.repeat(100) });
    const before = [...f.entries];
    f.failWrites();
    const { writeBrowserPreference } = f.load('utils/browser-storage.ts');
    assert.equal(writeBrowserPreference('clientSettings', 'new-secret-longer'), false);
    assert.deepEqual([...f.entries], before);
    assert.equal(f.warnings.length, 0);
    assert.match(f.notifications[0].description, /remain active in this tab/);
    for (const secret of ['old-secret', 'new-secret-longer', 'private-value']) {
        assert.equal(JSON.stringify([f.warnings, f.notifications]).includes(secret), false);
    }
});

test('repeated failures warn once per preference while writes resume after space becomes available', () => {
    const f = fixture();
    const { writeBrowserPreference } = f.load('utils/browser-storage.ts');
    f.failWrites();
    for (let n = 0; n < 100; n++) writeBrowserPreference('clientSettings', String(n));
    assert.equal(f.warnings.length, 0);
    assert.equal(f.notifications.length, 1);
    writeBrowserPreference('latestFrameStorage', '[]');
    assert.equal(f.notifications.length, 2);
    f.recover();
    assert.equal(writeBrowserPreference('clientSettings', 'saved'), true);
    assert.equal(f.entries.get('clientSettings'), 'saved');
});

test('blocked localStorage access remains nonfatal', () => {
    const f = fixture();
    f.denyAccess();
    const { writeBrowserPreference } = f.load('utils/browser-storage.ts');
    assert.equal(writeBrowserPreference('clientSettings', '{}'), false);
    assert.equal(f.warnings.length, 0);
    assert.match(f.notifications[0].description, /security or privacy/);
});

test('empty storage quota failure does not falsely claim that existing data filled the quota', () => {
    const f = fixture();
    f.failWrites();
    f.load('utils/browser-storage.ts').writeBrowserPreference('clientSettings', '{}');
    assert.equal(f.warnings.length, 0);
    assert.match(f.notifications[0].description, /quota was exceeded/);
});

test('invalid saved JSON can be reported without exposing its contents', () => {
    const f = fixture();
    f.load('utils/browser-storage.ts').reportBrowserStorageFailure(
        'clientSettings', 'read', new SyntaxError('Unexpected token: private-setting'),
    );
    assert.equal(f.notifications[0].message, 'Could not restore your preferences');
    assert.match(f.notifications[0].description, /invalid JSON/);
    assert.equal(JSON.stringify(f.warnings).includes('private-setting'), false);
});

test('the actual settings save path survives quota failure and preserves in-memory settings', () => {
    const f = fixture();
    f.failWrites();
    const { updateCachedSettings } = f.load('actions/settings-actions.ts');
    const settings = { player: { frameStep: 10 }, workspace: { autoSave: false }, imageFilters: [] };
    const shortcuts = { keyMap: { SAVE: { sequences: ['ctrl+s'] } }, defaultState: { SAVE: {} } };
    const before = JSON.stringify({ settings, shortcuts });
    assert.doesNotThrow(() => updateCachedSettings(settings, shortcuts));
    assert.equal(JSON.stringify({ settings, shortcuts }), before);
    assert.equal(f.notifications[0].message, 'Could not remember your preferences');
    f.recover();
    updateCachedSettings(settings, shortcuts);
    assert.deepEqual(JSON.parse(f.entries.get('clientSettings')), {
        ...settings, shortcuts: { keyMap: shortcuts.keyMap },
    });
});

test('last-frame persistence does not interrupt navigation when quota is exhausted', () => {
    const f = fixture({ latestFrameStorage: '[[10,20]]' });
    f.failWrites();
    const { writeLatestFrame, readLatestFrame } = f.load('utils/remember-latest-frame.ts');
    assert.doesNotThrow(() => writeLatestFrame(10, 21));
    assert.equal(readLatestFrame(10), 20);
    assert.equal(f.notifications[0].message, 'Could not remember your preferences');
    f.recover();
    writeLatestFrame(10, 21);
    assert.equal(readLatestFrame(10), 21);
});
