// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT

import React from 'react';
import Select from 'antd/lib/select';
import Text from 'antd/lib/typography/Text';
import { Label, ObjectState } from 'cvat-core-wrapper';
import { supervisionFields } from 'utils/farming-frame-tags';

interface Props {
    label: Label;
    tags: ObjectState[];
    disabled: boolean;
    onChange(name: string, value: string): void;
}

export default function FrameSupervision(props: Props): JSX.Element {
    const {
        label, tags, disabled, onChange,
    } = props;
    const choices = { inherit: 'Inherit', complete: 'Complete', incomplete: 'Incomplete' };
    const tag = tags.length === 1 ? tags[0] : null;
    const ambiguous = tags.length > 1;
    return (
        <div className='cvat-frame-supervision'>
            <Text strong>Frame supervision</Text>
            <Text type='secondary' className='cvat-frame-supervision-description'>
                Completeness for this image only. Inherit leaves this frame without an override.
            </Text>
            {ambiguous && (
                <Text type='danger'>Multiple Supervision entries on this frame. Resolve them in Standard workspace.</Text>
            )}
            {supervisionFields.map((field) => {
                const attribute = label.attributes.find((item) => item.name === field.name);
                if (!attribute) return null;
                const value = tag?.attributes[attribute.id as number] ?? field.defaultValue;
                return (
                    <div key={field.name} className='cvat-frame-supervision-field'>
                        <span>{field.label}</span>
                        <Select
                            aria-label={field.label}
                            value={value}
                            disabled={disabled || ambiguous || !!tag?.lock || !!tag?.isGroundTruth}
                            onChange={(selection: string) => onChange(field.name, selection)}
                        >
                            {field.values.map((choice) => (
                                <Select.Option key={choice} value={choice}>
                                    {choices[choice]}
                                </Select.Option>
                            ))}
                        </Select>
                    </div>
                );
            })}
        </div>
    );
}
