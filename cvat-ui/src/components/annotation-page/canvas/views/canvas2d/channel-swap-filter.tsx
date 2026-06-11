// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';

// Inline SVG filter that swaps the displayed Green channel with the source's
// 4th channel (alpha slot). Intended for 4-band imagery (e.g. B-NIR-R-G PNGs)
// uploaded as RGBA: with the filter on, the canvas shows (R, A, B) instead of
// (R, G, B), revealing the 4th band as green. Alpha is forced to 1 so the
// canvas remains opaque regardless of the source alpha values.
//
// feColorMatrix rows (R, G, B, A) read input channels (R, G, B, A, 1).
//   out.R = inR
//   out.G = inA   <-- swap: green is sourced from channel 4
//   out.B = inB
//   out.A = 1
export const CHANNEL_SWAP_24_FILTER_ID = 'cvat-channel-swap-24';
export const CHANNEL_OPAQUE_FILTER_ID = 'cvat-channel-opaque';
export const CHANNEL_SWAP_24_URL = `url(#${CHANNEL_SWAP_24_FILTER_ID})`;
export const CHANNEL_OPAQUE_URL = `url(#${CHANNEL_OPAQUE_FILTER_ID})`;

export default function ChannelSwapDefs(): JSX.Element {
    return (
        <svg
            aria-hidden
            focusable={false}
            width={0}
            height={0}
            style={{ position: 'absolute' }}
        >
            <defs>
                {/* Identity color, alpha forced to 1 — prevents the canvas from
                    interpreting a 4th source channel as transparency. */}
                <filter id={CHANNEL_OPAQUE_FILTER_ID} colorInterpolationFilters='sRGB'>
                    <feColorMatrix
                        type='matrix'
                        values={[
                            '1 0 0 0 0',
                            '0 1 0 0 0',
                            '0 0 1 0 0',
                            '0 0 0 0 1',
                        ].join(' ')}
                    />
                </filter>
                <filter id={CHANNEL_SWAP_24_FILTER_ID} colorInterpolationFilters='sRGB'>
                    <feColorMatrix
                        type='matrix'
                        values={[
                            '1 0 0 0 0',
                            '0 0 0 1 0',
                            '0 0 1 0 0',
                            '0 0 0 0 1',
                        ].join(' ')}
                    />
                </filter>
            </defs>
        </svg>
    );
}
