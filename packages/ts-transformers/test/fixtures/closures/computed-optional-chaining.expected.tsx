import * as __ctHelpers from "commontools";
import { cell, computed } from "commontools";
export default function TestComputeOptionalChaining() {
    const config = cell<{
        multiplier?: number;
    } | null>({ multiplier: 2 }, {
        anyOf: [{
                type: "object",
                properties: {
                    multiplier: {
                        type: "number"
                    }
                }
            }, {
                type: "null"
            }]
    } as const satisfies __ctHelpers.JSONSchema);
    const value = cell(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            config: {
                anyOf: [{
                        type: "object",
                        properties: {
                            multiplier: {
                                type: "number"
                            }
                        }
                    }, {
                        type: "null"
                    }],
                asCell: true
            }
        },
        required: ["value", "config"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value: value,
        config: config
    }, ({ value, config }) => value.get() * (config.get()?.multiplier ?? 1));
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
