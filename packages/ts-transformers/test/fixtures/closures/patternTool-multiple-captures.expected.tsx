import * as __ctHelpers from "commontools";
import { derive, patternTool, Writable } from "commontools";
const multiplier = Writable.of(2, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
const prefix = Writable.of("Result: ", {
    type: "string"
} as const satisfies __ctHelpers.JSONSchema);
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
export default tool;
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
