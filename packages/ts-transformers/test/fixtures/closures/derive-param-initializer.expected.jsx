import * as __ctHelpers from "commontools";
import { Writable, derive, pattern } from "commontools";
// FIXTURE: derive-param-initializer
// Verifies: a callback parameter with a default value is preserved after capture extraction
//   derive(value, (v = 10) => ...) → derive(schema, schema, { value, multiplier }, ({ value: v = 10, multiplier }) => ...)
// Context: the default initializer `= 10` is carried over to the destructured parameter
export default pattern(() => {
    const value = 5;
    const multiplier = Writable.of(2, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // Test parameter with default value
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number"
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
    }, ({ value: v = 10, multiplier }) => v * multiplier.get());
    return result;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "number",
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
