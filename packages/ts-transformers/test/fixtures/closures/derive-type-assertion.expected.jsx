import * as __ctHelpers from "commontools";
import { Writable, derive, pattern } from "commontools";
// FIXTURE: derive-type-assertion
// Verifies: a type assertion (`as number`) in the callback body is preserved after capture extraction
//   derive(value, fn) → derive(schema, schema, { value, multiplier }, fn)
// Context: the `as number` cast remains intact in the transformed callback expression
export default pattern(() => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const multiplier = Writable.of(2, {
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
                asCell: true
            }
        },
        required: ["value", "multiplier"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        multiplier: multiplier
    }, ({ value: v, multiplier }) => (v.get() * multiplier.get()) as number);
    return result;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
