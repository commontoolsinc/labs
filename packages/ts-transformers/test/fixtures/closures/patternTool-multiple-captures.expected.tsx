import * as __ctHelpers from "commontools";
import { derive, pattern, patternTool, type PatternToolResult, Writable } from "commontools";
const multiplier = Writable.of(2, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
const prefix = Writable.of("Result: ", {
    type: "string"
} as const satisfies __ctHelpers.JSONSchema);
type Output = {
    tool: PatternToolResult<Record<string, never>>;
};
export default pattern(() => {
    const tool = patternTool(({ value, prefix, multiplier }: {
        value: number;
        prefix: unknown;
        multiplier: unknown;
    }) => {
        return derive({
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { value }, ({ value }) => {
            return prefix.get() + String(value * multiplier.get());
        });
    }, {
        prefix: prefix,
        multiplier: multiplier
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
                    properties: {},
                    additionalProperties: false
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
