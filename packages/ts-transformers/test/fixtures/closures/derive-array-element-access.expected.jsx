import * as __ctHelpers from "commontools";
import { Writable, derive, pattern } from "commontools";
// FIXTURE: derive-array-element-access
// Verifies: an array variable accessed by index inside derive is captured as a whole array
//   derive(value, fn) → derive(schema, schema, { value, factors }, fn)
// Context: `factors[1]!` uses bracket access; the entire `factors` array is captured
export default pattern(() => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const factors = [2, 3, 4];
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            factors: {
                type: "array",
                items: {
                    type: "number"
                }
            }
        },
        required: ["value", "factors"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        factors: factors
    }, ({ value: v, factors }) => v.get() * factors[1]!);
    return result;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "number",
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
