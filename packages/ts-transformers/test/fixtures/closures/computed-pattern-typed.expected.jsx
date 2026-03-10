import * as __ctHelpers from "commontools";
import { Writable, computed, pattern } from "commontools";
export default pattern((__ct_pattern_input) => {
    const multiplier = __ct_pattern_input.key("multiplier");
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            multiplier: {
                type: "number",
                asOpaque: true
            }
        },
        required: ["value", "multiplier"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value: value,
        multiplier: multiplier
    }, ({ value, multiplier }) => value.get() * multiplier);
    return result;
}, {
    type: "object",
    properties: {
        multiplier: {
            type: "number"
        }
    },
    required: ["multiplier"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
