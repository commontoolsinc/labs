import * as __ctHelpers from "commontools";
import { cell, derive, patternTool } from "commontools";
const multiplier = cell(2, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
const offset = cell(10, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
// Test: patternTool with an existing extraParam, and a new capture
// The function has { value: number, offset: number } as input type
// We provide offset via extraParams, and the transformer should capture multiplier
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
export default tool;
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
