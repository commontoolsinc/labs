import * as __ctHelpers from "commontools";
import { Writable, derive, pattern, type JSONSchema } from "commontools";
import "commontools/schema";
// FIXTURE: derive-4arg-form
// Verifies: closure extraction works with explicit 4-arg derive(inputSchema, outputSchema, input, fn)
//   derive(schema, schema, value, fn) → derive(mergedSchema, schema, { value, multiplier }, fn)
// Context: `multiplier` is captured even though schemas are already provided
export default pattern(() => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const multiplier = Writable.of(2, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // Explicit 4-arg form with schemas - should still transform captures
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
    }, ({ value: v, multiplier }) => v.get() * multiplier.get());
    return result;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "number",
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
