// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT

// Reuse the archive's generated AI registry; saved CVAT values stay unchanged.
import registry from '../../cvat/apps/dataset_manager/formats/annotation_attributes.json';

const definitions = registry.attributes as Record<string, {
    label: string;
    values?: (string | number | boolean)[];
    value_labels?: string[];
}>;

export function isInternalAttribute(name: string): boolean {
    return name === 'fr_origin' || name === 'fr_tracking_id';
}

export function attributeDisplayName(name: string): string {
    return definitions[name]?.label ?? name;
}

export function attributeDisplayValue(name: string, value: string): string {
    const spec = definitions[name];
    const index = spec?.values?.findIndex((candidate) => String(candidate) === value) ?? -1;
    return spec?.value_labels?.[index] ?? value;
}
