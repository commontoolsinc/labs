import * as __ctHelpers from "commontools";
import { cell, computed, pattern } from "commontools";
export default pattern((config: {
    base: number;
    multiplier: number;
}) => {
    const value = cell(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const offset = 5; // non-cell local
    const threshold = cell(15, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema); // cell local
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            config: {
                type: "object",
                properties: {
                    base: {
                        type: "number"
                    },
                    multiplier: {
                        type: "number"
                    }
                },
                required: ["base", "multiplier"]
            },
            offset: {
                type: "number"
            },
            threshold: {
                type: "number",
                asCell: true
            }
        },
        required: ["value", "config", "offset", "threshold"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value: value,
        config: {
            base: config.base,
            multiplier: config.multiplier
        },
        offset: offset,
        threshold: threshold
    }, ({ value, config, offset, threshold }) => (value.get() + config.base + offset) * config.multiplier + threshold.get());
    return result;
}, {
    type: "object",
    properties: {
        base: {
            type: "number"
        },
        multiplier: {
            type: "number"
        }
    },
    required: ["base", "multiplier"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number",
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
