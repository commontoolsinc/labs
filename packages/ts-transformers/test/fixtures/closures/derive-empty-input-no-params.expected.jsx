import * as __ctHelpers from "commontools";
import { Writable, derive, pattern } from "commontools";
// FIXTURE: derive-empty-input-no-params
// Verifies: zero-parameter callback with empty `{}` input still captures closed-over cells
//   derive({}, () => ...) → derive(schema, schema, { a, b }, ({ a, b }) => ...)
// Context: no explicit input param; captures become the sole parameters of the rewritten callback
export default pattern(() => {
    const a = Writable.of(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const b = Writable.of(20, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // Zero-parameter callback that closes over a and b
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            a: {
                type: "number",
                asCell: true
            },
            b: {
                type: "number",
                asCell: true
            }
        },
        required: ["a", "b"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        a: a,
        b: b
    }, ({ a, b }) => a.get() + b.get());
    return result;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
