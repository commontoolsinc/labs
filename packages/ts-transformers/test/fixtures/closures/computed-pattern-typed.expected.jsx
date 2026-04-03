import * as __ctHelpers from "commontools";
import { Writable, computed, pattern } from "commontools";
// FIXTURE: computed-pattern-typed
// Verifies: computed() inside a typed pattern with destructured params is closure-extracted
//   computed(() => value.get() * multiplier) → derive(..., { value, multiplier }, ({ value, multiplier }) => value.get() * multiplier)
// Context: The pattern uses generic type params <{ multiplier: number }, number>.
//   Destructured `multiplier` is captured with asOpaque: true (it is an OpaqueRef
//   from the pattern input), while `value` is captured with asCell: true.
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
                type: "number"
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
