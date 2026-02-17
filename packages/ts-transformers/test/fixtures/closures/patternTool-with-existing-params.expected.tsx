import * as __ctHelpers from "commontools";
import { cell, derive, pattern, patternTool, type PatternToolResult } from "commontools";
const multiplier = cell(2, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
const offset = cell(10, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
type Output = {
    tool: PatternToolResult<{
        offset: number;
    }>;
};
// Test: patternTool with an existing extraParam, and a new capture
// The function has { value: number, offset: number } as input type
// We provide offset via extraParams, and the transformer should capture multiplier
export default pattern(() => {
    const tool = patternTool(({ value, offset, multiplier }: {
        value: number;
        offset: number;
        multiplier: unknown;
    }) => {
        return derive({
            type: "object",
            properties: {
                value: {
                    type: "number"
                },
                offset: {
                    type: "number"
                }
            },
            required: ["value", "offset"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { value, offset }, ({ value, offset }) => {
            return value * multiplier.get() + offset;
        });
    }, {
        multiplier: multiplier,
        offset
    });
    return { tool };
}, {
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        tool: {
            type: "object",
            properties: {
                pattern: {
                    $ref: "#/$defs/Recipe"
                },
                extraParams: {
                    type: "object",
                    properties: {
                        offset: {
                            type: "number"
                        }
                    },
                    required: ["offset"]
                }
            },
            required: ["pattern", "extraParams"]
        }
    },
    required: ["tool"],
    $defs: {
        Recipe: {
            type: "object",
            properties: {
                argumentSchema: true,
                resultSchema: true
            },
            required: ["argumentSchema", "resultSchema"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
