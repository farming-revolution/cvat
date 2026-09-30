// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT

import { Label, LabelType } from 'cvat-core-wrapper';
// eslint-disable-next-line import/no-relative-packages
import registry from '../../../cvat/apps/dataset_manager/formats/annotation_attributes.json';
import { filterApplicableForType } from './filter-applicable-labels';

const spec = registry.supervision;

export const supervisionFields = Object.entries(spec.fields).map(([name, field]) => ({
    name,
    label: field.label,
    values: field.values,
    defaultValue: field.default,
}));

export function supervisionLabel(labels: Label[]): Label | undefined {
    return labels.find((label) => label.type === LabelType.TAG && label.name === spec.tag_label &&
        supervisionFields.every((field) => label.attributes.some((attribute) => (
            attribute.name === field.name && field.values.every((value) => attribute.values.includes(value))
        ))));
}

export function frameTagChoices(labels: Label[]): Label[] {
    const applicable = filterApplicableForType(LabelType.TAG, labels);
    // Outside Farming Revolution tasks, CVAT's usual "any" labels may still be used as tags.
    if (!labels.some((label) => label.type === LabelType.TAG && label.name === spec.tag_label)) {
        return applicable;
    }
    // The Supervision tag is edited through the dedicated per-frame controls.
    return applicable.filter((label) => label.type === LabelType.TAG && label.name !== spec.tag_label);
}
