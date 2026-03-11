import * as __ctHelpers from "commontools";
import { Writable, computed, pattern } from "commontools";
export default pattern(() => {
    const a = Writable.of(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const b = Writable.of(20, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const c = Writable.of(5, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
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
            },
            c: {
                type: "number",
                asCell: true
            }
        },
        required: ["a", "b", "c"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        a: a,
        b: b,
        c: c
    }, ({ a, b, c }) => (a.get() * b.get() + c.get()) / 2);
    return result;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "number",
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
