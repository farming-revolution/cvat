// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
export interface ProjectionFrame {
    frame: number;
    name: string;
    width: number;
    height: number;
    projection: number[];
    target_to_camera: number[];
}
export interface ProjectionBag {
    bag_id: number;
    horizontal_height_m: number;
    frames: ProjectionFrame[];
}
export interface HeightMetadata {
    version: number;
    status: string;
    reason?: string;
    task_id: number;
    data_id: number;
    frame_fingerprint: string;
    frames: { frame: number; name: string; width: number; height: number }[];
    deleted_frames: number[];
    bags: ProjectionBag[];
}
export interface TrackSnapshot {
    shapes: { frame: number; points: number[]; outside: boolean; occluded: boolean; type: string }[];
}
export interface Estimate {
    reason?: string;
    height?: number;
    rms?: number;
    count: number;
    first?: number;
    last?: number;
    warnings: string[];
}

// Same affine ground-plane reconstruction as cvat_projection.project_ground_points.
export function affine(frame: ProjectionFrame, height: number): [number, number, number, number, number, number] {
    const m = frame.target_to_camera;
    const p = frame.projection;
    if (m.length !== 16 || p.length !== 12 || ![...m, ...p, height].every(Number.isFinite) ||
        height <= 0 || p[0] <= 0 || p[5] <= 0 || Math.abs(m[10]) < 1e-9) {
        throw new Error('Invalid camera geometry.');
    }
    return [
        (p[0] / height) * (m[0] - (m[2] * m[8]) / m[10]),
        (p[0] / height) * (m[1] - (m[2] * m[9]) / m[10]),
        (p[0] / height) * (m[3] + (m[2] * (height - m[11])) / m[10]) + p[2],
        (p[5] / height) * (m[4] - (m[6] * m[8]) / m[10]),
        (p[5] / height) * (m[5] - (m[6] * m[9]) / m[10]),
        (p[5] / height) * (m[7] + (m[6] * (height - m[11])) / m[10]) + p[6],
    ];
}

export function estimateHeight(track: TrackSnapshot, metadata: HeightMetadata): Estimate {
    const unavailable = (reason: string): Estimate => ({ reason, count: 0, warnings: [] });
    try {
        if (metadata.version !== 1 || metadata.status !== 'available') {
            return unavailable(metadata.reason || 'Projection information is unavailable.');
        }
        const deleted = new Set(metadata.deleted_frames);
        const catalog = new Map(metadata.frames.map((frame) => [frame.frame, frame]));
        const mapped = new Map<number, { bag: ProjectionBag; frame: ProjectionFrame }>();
        for (const bag of metadata.bags) {
            if (!Number.isFinite(bag.horizontal_height_m) || bag.horizontal_height_m <= 0) {
                return unavailable('Invalid horizontal projection reference.');
            }
            for (const frame of bag.frames) {
                const expected = catalog.get(frame.frame);
                if (mapped.has(frame.frame) || !expected || expected.name !== frame.name ||
                    expected.width !== frame.width || expected.height !== frame.height) {
                    return unavailable('Projection frame mapping is invalid.');
                }
                mapped.set(frame.frame, { bag, frame });
            }
        }
        const shapes = [...track.shapes].sort((a, b) => a.frame - b.frame);
        if (!shapes.length || new Set(shapes.map((s) => s.frame)).size !== shapes.length) {
            return unavailable('This track has no usable keyframes or has duplicate frame indices.');
        }
        // Verify the entire visible span, not just endpoints: interpolation must
        // never silently cross an unknown or foreign recording.
        const bags = new Set<number>();
        let position = -1;
        for (const frame of [...catalog.keys()].sort((a, b) => a - b)) {
            while (position + 1 < shapes.length && shapes[position + 1].frame <= frame) position++;
            if (position < 0 || shapes[position].outside || deleted.has(frame)) continue;
            const info = mapped.get(frame);
            if (!info) return unavailable('Projection information is missing for part of this track. Synchronize again.');
            bags.add(info.bag.bag_id);
        }
        if (bags.size !== 1) return unavailable('This track crosses recordings or has no visible frames.');
        const observations = shapes.filter((s) => !s.outside && !s.occluded && !deleted.has(s.frame));
        const data = observations.map((shape) => {
            const info = mapped.get(shape.frame);
            if (!info || shape.type !== 'points' || shape.points.length !== 2 ||
                !shape.points.every(Number.isFinite)) throw new Error('Missing metadata or unsupported point keyframe.');
            return { shape, frame: info.frame, horizontal: affine(info.frame, info.bag.horizontal_height_m) };
        }).filter(({ shape, frame }) => shape.points[0] >= 0 && shape.points[1] >= 0 &&
            shape.points[0] <= frame.width && shape.points[1] <= frame.height);
        if (data.length < 2) return unavailable('At least two visible, non-occluded point keyframes are needed.');

        const fit = (logHeight: number): number => {
            const height = Math.exp(logHeight);
            const rows = data.flatMap(({ shape, frame, horizontal }) => {
                const vertical = affine(frame, height);
                return [[horizontal[0], horizontal[1], shape.points[0] - horizontal[2]],
                    [vertical[3], vertical[4], shape.points[1] - vertical[5]]];
            });
            let xx = 0; let xy = 0; let yy = 0; let bx = 0; let by = 0;
            for (const [a, b, target] of rows) {
                xx += a * a; xy += a * b; yy += b * b; bx += a * target; by += b * target;
            }
            const determinant = xx * yy - xy * xy;
            if (!(determinant > 1e-12 * xx * yy)) throw new Error('The camera geometry cannot determine a plant position.');
            const x = (bx * yy - by * xy) / determinant;
            const y = (by * xx - bx * xy) / determinant;
            return rows.reduce((sum, [a, b, target]) => sum + (a * x + b * y - target) ** 2, 0) / data.length;
        };
        const lower = Math.log(0.05); const upper = Math.log(10);
        const grid = Array.from({ length: 65 }, (_, index) => lower + ((upper - lower) * index) / 64);
        const errors = grid.map(fit);
        const best = errors.indexOf(Math.min(...errors));
        let left = grid[Math.max(0, best - 1)];
        let right = grid[Math.min(grid.length - 1, best + 1)];
        const ratio = (Math.sqrt(5) - 1) / 2;
        for (let iteration = 0; iteration < 48; iteration++) {
            const a = right - ratio * (right - left); const b = left + ratio * (right - left);
            if (fit(a) < fit(b)) right = b; else left = a;
        }
        const logHeight = (left + right) / 2;
        if (logHeight - lower < 1e-6 || upper - logHeight < 1e-6) {
            return unavailable('No stable physical height could be determined within the diagnostic range.');
        }
        const error = fit(logHeight);
        // A +/-1% height perturbation must change the best-position fit. This
        // detects stationary/degenerate cameras without mistaking a perfect fit
        // for a confidently determined height.
        const sensitivity = Math.min(fit(logHeight - 0.01), fit(logHeight + 0.01)) - error;
        if (!Number.isFinite(error) || sensitivity < 1e-8) {
            return unavailable('Camera movement is insufficient to determine a height.');
        }
        const warnings = [];
        if (data.length < 3) warnings.push('Only two keyframes: there is little independent evidence to assess fit quality.');
        const verticalPositions = data.map(({ shape }) => shape.points[1]);
        if (Math.max(...verticalPositions) - Math.min(...verticalPositions) < 20) {
            warnings.push('Less than 20 pixels of vertical movement: the estimate is sensitive to small position errors.');
        }
        if (Math.sqrt(error) > 5) warnings.push('The track fits poorly (more than 5 pixels RMS error).');
        return {
            height: Math.exp(logHeight),
            rms: Math.sqrt(error),
            count: data.length,
            first: data[0].shape.frame,
            last: data[data.length - 1].shape.frame,
            warnings,
        };
    } catch (error) {
        return unavailable(error instanceof Error ? error.message : 'Invalid diagnostic information.');
    }
}
