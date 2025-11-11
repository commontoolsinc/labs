import * as __ctHelpers from "commontools";
import { cell, compute, recipe } from "commontools";
export default recipe({
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
} as const satisfies __ctHelpers.JSONSchema, (config: {
    base: number;
    multiplier: number;
}) => {
    const value = cell(10);
    const offset = 5; // non-cell local
    const threshold = cell(15); // cell local
    const result = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            value: {
                type: "number",
                asOpaque: true
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
                type: "number",
                enum: [5]
            },
            threshold: {
                type: "number",
                asOpaque: true
            }
        },
        required: ["value", "config", "offset", "threshold"]
    } as const satisfies __ctHelpers.JSONSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
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
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
