// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT

import { ArgumentError } from './exceptions';
import { ShapeType } from './enums';
import { findAngleDiff } from './object-utils';

export interface BoundaryShape {
    serverID?: number;
    points?: number[];
    rotation: number;
    outside: boolean;
    occluded: boolean;
    zOrder: number;
    attributes: Record<number, string>;
}

// Evaluate the complete original track, including keyframes on excluded images.
// Only the resulting observations on retained frames are used in the repaired track.
export function boundaryState(
    shapes: Record<number, BoundaryShape>, frame: number, type: ShapeType,
): BoundaryShape {
    const keys = Object.keys(shapes).map(Number).sort((a, b) => a - b);
    const left = [...keys].reverse().find((key) => key <= frame);
    const right = keys.find((key) => key > frame);
    const source = shapes[left ?? right];
    const attributes = {};
    keys.filter((key) => key <= frame).forEach((key) => Object.assign(attributes, shapes[key].attributes));
    const result = {
        ...source, points: [...source.points], attributes, outside: left === undefined || source.outside,
    };
    delete result.serverID;
    if (left !== undefined && right !== undefined) {
        const ratio = (frame - left) / (right - left);
        result.points = source.points.map((value, index) => (
            value + (shapes[right].points[index] - value) * ratio
        ));
        if (type === ShapeType.RECTANGLE) {
            result.rotation = (source.rotation +
                findAngleDiff(shapes[right].rotation, source.rotation) * ratio + 360) % 360;
        }
    }
    return result;
}

export function retainedBoundaries(frames: number[], deleted: Set<number>): number[] {
    return frames.filter((frame, index) => !deleted.has(frame) && (
        (index > 0 && deleted.has(frames[index - 1])) ||
        (index + 1 < frames.length && deleted.has(frames[index + 1]))
    ));
}

function requiredBoundaries(frames: number[], deleted: Set<number>, keys: number[]): Set<number> {
    const required = new Set<number>();
    const keySet = new Set(keys);
    for (let start = 0; start < frames.length; start++) {
        if (!deleted.has(frames[start])) continue;
        let end = start;
        let affected = false;
        while (end < frames.length && deleted.has(frames[end])) {
            affected ||= keySet.has(frames[end]);
            end++;
        }
        if (affected) {
            if (start > 0) required.add(frames[start - 1]);
            if (end < frames.length) required.add(frames[end]);
        }
        start = end;
    }
    return required;
}

export function repairTrackBoundaries(
    original: Record<number, BoundaryShape>, type: ShapeType, frames: number[], deleted: Set<number>,
    protectBoundaries = false, previouslyDeleted: Set<number> = new Set(),
): { shapes: Record<number, BoundaryShape>; removed: boolean; changed: boolean; protectedFrames: number[] } {
    const keys = Object.keys(original).map(Number).sort((a, b) => a - b);
    const visibleFrames = new Set<number>();
    const activeKeys = keys.filter((frame) => !previouslyDeleted.has(frame));
    let left = -1;
    frames.forEach((frame) => {
        while (left + 1 < activeKeys.length && activeKeys[left + 1] <= frame) left++;
        if (left >= 0 && !original[activeKeys[left]].outside) visibleFrames.add(frame);
    });
    const visible = [...visibleFrames].some((frame) => !deleted.has(frame));
    const affected = keys.some((frame) => deleted.has(frame)) || (!visible && visibleFrames.size > 0);
    const required = requiredBoundaries(frames, deleted, keys);
    const last = keys[keys.length - 1];
    const boundaries = retainedBoundaries(frames, deleted).filter((frame) => frame >= keys[0] && (
        required.has(frame) || (protectBoundaries && (frame <= last || !original[last].outside))
    ));
    if (!affected && (!protectBoundaries || !boundaries.length)) {
        return {
            shapes: original, removed: false, changed: false, protectedFrames: boundaries,
        };
    }
    if (![ShapeType.POINTS, ShapeType.RECTANGLE].includes(type) || keys.some((frame) => (
        original[frame].points?.length !== (type === ShapeType.POINTS ? 2 : 4)
    ))) {
        throw new ArgumentError('Frame deletion preserves single-point and rectangle tracks only');
    }
    // During a new deletion, match the editor's pre-operation interpolation:
    // it already skips old deleted keyframes. Simplify may explicitly normalize
    // legacy raw tracks and therefore uses the default empty previous set.
    const geometry = Object.fromEntries(keys.filter((frame) => !previouslyDeleted.has(frame))
        .map((frame) => [frame, original[frame]]));
    if (!Object.keys(geometry).length) {
        return {
            shapes: {}, removed: true, changed: true, protectedFrames: boundaries,
        };
    }
    const shapes = Object.fromEntries(keys.filter((frame) => !deleted.has(frame))
        .map((frame) => [frame, original[frame]]));
    boundaries.forEach((frame) => {
        // Materialize inherited attributes, even when a boundary is already a keyframe.
        shapes[frame] = {
            ...boundaryState(geometry, frame, type),
            attributes: boundaryState(original, frame, type).attributes,
            ...(shapes[frame]?.serverID !== undefined ? {
                serverID: shapes[frame].serverID,
            } : {}),
        };
    });
    return {
        shapes,
        removed: !visible,
        changed: affected || JSON.stringify(shapes) !== JSON.stringify(original),
        protectedFrames: boundaries,
    };
}
