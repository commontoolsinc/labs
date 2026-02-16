import * as __ctHelpers from "commontools";
import { pattern, computed, UI } from "commontools";
// Test mixing optional properties (with ?) and union with undefined
interface MixedOptionalData {
    // Property with | undefined union
    valueUnion: number | undefined;
    // Property with ? optional marker
    valueOptional?: string;
    // Both union and optional
    valueBoth?: boolean | undefined;
    // Required property for comparison
    valueRequired: number;
}
interface PatternInput {
    data: MixedOptionalData;
}
export default pattern(({ data }) => {
    // Unbox the properties from data
    const { valueUnion, valueOptional, valueBoth, valueRequired } = data;
    // Pass unboxed fields to computed
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            valueUnion: {
                type: "number",
                asOpaque: true
            },
            valueOptional: {
                type: "string",
                asOpaque: true
            },
            valueBoth: {
                type: "boolean",
                asOpaque: true
            },
            valueRequired: {
                type: "number",
                asOpaque: true
            }
        },
        required: ["valueUnion", "valueRequired"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, {
        valueUnion: valueUnion,
        valueOptional: valueOptional,
        valueBoth: valueBoth,
        valueRequired: valueRequired
    }, ({ valueUnion, valueOptional, valueBoth, valueRequired }) => {
        const union = valueUnion ?? 0;
        const optional = valueOptional ?? "default";
        const both = valueBoth ?? false;
        const required = valueRequired;
        return `union: ${union}, optional: ${optional}, both: ${both}, required: ${required}`;
    });
    return {
        [UI]: <div>{result}</div>,
    };
}, {
    type: "object",
    properties: {
        data: {
            $ref: "#/$defs/MixedOptionalData"
        }
    },
    required: ["data"],
    $defs: {
        MixedOptionalData: {
            type: "object",
            properties: {
                valueUnion: {
                    type: "number"
                },
                valueOptional: {
                    type: "string"
                },
                valueBoth: {
                    type: "boolean"
                },
                valueRequired: {
                    type: "number"
                }
            },
            required: ["valueRequired"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
                }]
        },
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
