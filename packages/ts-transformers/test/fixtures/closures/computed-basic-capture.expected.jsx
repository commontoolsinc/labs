import * as __ctHelpers from "commontools";
import { Writable, computed, pattern } from "commontools";
// FIXTURE: computed-basic-capture
// Verifies: computed(() => expr) with two cell captures is closure-extracted into derive()
//   computed(() => value.get() * multiplier.get()) → derive(captureSchema, resultSchema, { value, multiplier }, ({ value, multiplier }) => value.get() * multiplier.get())
//   Captured cells are annotated with asCell: true in the capture schema.
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
        value: value,
        multiplier: multiplier
    }, ({ value, multiplier }) => value.get() * multiplier.get());
    return result;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
