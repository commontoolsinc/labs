import * as __cfHelpers from "commonfabric";
import { Writable, computed, pattern } from "commonfabric";
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
    } as const satisfies __cfHelpers.JSONSchema);
    const result = __cfHelpers.derive({
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
