// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import { SerializedImageFilter } from 'cvat-core-wrapper';
import { ImageFilterAlias } from 'utils/image-processing';
import FabricFilter from './fabric-wrapper';

export interface GammaFilterOptions {
    gamma: number[];
}

// Custom gamma filter that also corrects the alpha channel. For standard
// opaque images alpha is 255 and the correction is a no-op; for 4-channel
// (RGBA) imagery used by the "Swap G ↔ 4th channel" feature the alpha
// channel carries real pixel data and must be gamma-corrected too.
function buildGammaFilter(gamma: number[]): { applyTo2d: (opts: { imageData: ImageData }) => void } {
    const lut = (g: number): Uint8ClampedArray => {
        const table = new Uint8ClampedArray(256);
        const inv = 1 / g;
        for (let i = 0; i < 256; i += 1) {
            table[i] = Math.round(255 * (i / 255) ** inv);
        }
        return table;
    };
    const [rg, gg, bg] = gamma;
    // Use red's gamma for alpha (slider provides a single value applied to all channels).
    const rLut = lut(rg);
    const gLut = lut(gg);
    const bLut = lut(bg);
    const aLut = lut(rg);
    return {
        applyTo2d({ imageData }) {
            const { data } = imageData;
            for (let i = 0; i < data.length; i += 4) {
                data[i] = rLut[data[i]];
                data[i + 1] = gLut[data[i + 1]];
                data[i + 2] = bLut[data[i + 2]];
                data[i + 3] = aLut[data[i + 3]];
            }
        },
    };
}

export default class GammaCorrection extends FabricFilter {
    #gamma: number[];

    constructor(options: GammaFilterOptions) {
        super();

        const { gamma } = options;
        if (!Array.isArray(gamma) || gamma.length !== 3) {
            throw Error(`Incorrect option for gamma filter, expected array: [R, G, B] got ${gamma}`);
        }

        this.filter = buildGammaFilter(gamma) as any;
        this.#gamma = gamma;
    }

    public configure(options: object): void {
        const { gamma: newGamma } = options as GammaFilterOptions;
        this.filter = buildGammaFilter(newGamma) as any;
        this.#gamma = newGamma;
    }

    public toJSON(): SerializedImageFilter {
        return {
            alias: ImageFilterAlias.GAMMA_CORRECTION,
            params: {
                gamma: this.#gamma,
            },
        };
    }

    get gamma(): number {
        return this.#gamma[0];
    }
}
