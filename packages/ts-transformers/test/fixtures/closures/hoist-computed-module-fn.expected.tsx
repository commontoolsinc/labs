import * as __ctHelpers from "commontools";
import { computed, pattern } from "commontools";
function helper(x: number) {
    return x * 2;
}
export default pattern(({ value }) => {
    const result = __lift_0({ value: value });
    return { result };
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        result: {
            type: "number",
            asOpaque: true
        }
    },
    required: ["result"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
const __lift_0 = __ctHelpers.lift({
    type: "object",
    properties: {
        value: {
            type: "number",
            asOpaque: true
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, ({ value }) => helper(value));
