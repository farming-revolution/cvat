// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useState, useEffect, useMemo } from 'react';
import { Row, Col } from 'antd/lib/grid';
import Text from 'antd/lib/typography/Text';
import Select from 'antd/lib/select';
import { Label } from 'cvat-core-wrapper';
import GlobalHotKeys, { KeyMap, KeyMapItem } from 'utils/mousetrap-react';
import { shift } from 'utils/math';
import { registerComponentShortcuts } from 'actions/shortcuts-actions';
import { ShortcutScope } from 'utils/enums';
import { subKeyMap } from 'utils/component-subkeymap';
import { useSelector } from 'react-redux';
import { CombinedState } from 'reducers';
import { useResetShortcutsOnUnmount } from 'utils/hooks';
import { readTagShortcuts, resolveTagShortcuts, writeTagShortcuts } from 'utils/tag-shortcuts';

type Props = {
    onShortcutPress(labelID: number): void;
    labels: Label[];
};

const componentShortcuts: Record<string, KeyMapItem> = {};

for (const idx of [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]) {
    componentShortcuts[`SETUP_${idx}_TAG`] = {
        name: 'Create a new tag',
        description: 'Create a new tag with corresponding class. The class may be setup in tag annotation sidebar',
        sequences: [`${idx}`],
        nonActive: true,
        scope: ShortcutScope.TAG_ANNOTATION_WORKSPACE,
    };
}

registerComponentShortcuts(componentShortcuts);

function ShortcutControls(props: Props & { storageKey: string | null }): JSX.Element {
    const { labels, onShortcutPress, storageKey } = props;
    const [preferences, setPreferences] = useState(() => readTagShortcuts(storageKey));
    const shortcutLabelMap = useMemo(() => resolveTagShortcuts(labels, preferences), [labels, preferences]);

    const keyMap: KeyMap = useSelector((state: CombinedState) => state.shortcuts.keyMap);
    const handlers: {
        [key: string]: (keyEvent?: KeyboardEvent) => void;
    } = {};

    useResetShortcutsOnUnmount(componentShortcuts);

    useEffect(() => {
        const updatedComponentShortcuts = Object.keys(componentShortcuts).reduce((acc: KeyMap, key: string) => {
            acc[key] = {
                ...componentShortcuts[key],
                sequences: keyMap[key].sequences,
            };
            return acc;
        }, {});

        for (const [id, labelID] of Object.entries(shortcutLabelMap)) {
            if (labelID && labels.some((label) => label.id === labelID)) {
                const [label] = labels.filter((_label) => _label.id === labelID);
                const key = `SETUP_${id}_TAG`;
                updatedComponentShortcuts[key] = {
                    ...updatedComponentShortcuts[key],
                    nonActive: false,
                    name: `Create a new tag "${label.name}"`,
                    description: `Create a new tag having class "${label.name}"`,
                };
            }
        }

        registerComponentShortcuts(updatedComponentShortcuts);
    }, [shortcutLabelMap, labels]);

    Object.keys(shortcutLabelMap)
        .map((idx: string) => Number.parseInt(idx, 10))
        .filter((idx: number) => shortcutLabelMap[idx])
        .forEach((idx: number): void => {
            const [label] = labels.filter((_label) => _label.id === shortcutLabelMap[idx]);
            const key = `SETUP_${idx}_TAG`;
            handlers[key] = (event: KeyboardEvent | undefined) => {
                if (event) {
                    event.preventDefault();
                }
                onShortcutPress(label.id!);
            };
        });

    const onChangeShortcutLabel = (value: string, id: number): void => {
        const defaults = Object.fromEntries(Object.entries(shortcutLabelMap).map(([slot, labelID]) => [
            slot, labels.find((label) => label.id === labelID)?.name ?? null,
        ]));
        const choices = {
            ...(preferences ?? defaults),
            [id]: labels.find((label) => label.id === Number(value))?.name ?? null,
        };
        setPreferences(choices);
        writeTagShortcuts(storageKey, choices);
    };

    return (
        <div className='cvat-tag-annotation-label-selects'>
            <GlobalHotKeys keyMap={subKeyMap(componentShortcuts, keyMap)} handlers={handlers} />
            <Row>
                <Col>
                    <Text strong>Shortcuts for labels:</Text>
                </Col>
            </Row>
            {shift(Object.keys(shortcutLabelMap), 1)
                .slice(0, Math.min(labels.length, 10))
                .map((id) => (
                    <Row key={id}>
                        <Col span={24}>
                            <Text code>
                                {`Shortcut: ${keyMap[`SETUP_${id}_TAG`].sequences.join(', ')}`}
                            </Text>
                        </Col>
                        <Col>
                            <Select
                                value={`${shortcutLabelMap[Number.parseInt(id, 10)]}`}
                                onChange={(value: string) => {
                                    onChangeShortcutLabel(value, Number.parseInt(id, 10));
                                }}
                                style={{ width: 200 }}
                                className='cvat-tag-annotation-label-select'
                            >
                                <Select.Option value=''>
                                    <Text type='secondary'>None</Text>
                                </Select.Option>
                                {(labels as any[]).map((label: any) => (
                                    <Select.Option key={label.id} value={`${label.id}`}>
                                        {label.name}
                                    </Select.Option>
                                ))}
                            </Select>
                        </Col>
                    </Row>
                ))}
        </div>
    );
}

function ShortcutsSelect(props: Props): JSX.Element {
    const storageKey = useSelector((state: CombinedState) => {
        const userID = state.auth.user?.id;
        const job = state.annotation.job.instance;
        if (!userID || !job) return null;
        const scope = job.projectId ? `project:${job.projectId}` : `task:${job.taskId}`;
        return `cvat-tag-shortcuts:user:${userID}:${scope}`;
    });
    return <ShortcutControls key={storageKey || 'unscoped'} {...props} storageKey={storageKey} />;
}

export default ShortcutsSelect;
