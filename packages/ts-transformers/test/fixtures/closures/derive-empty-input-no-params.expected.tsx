import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
export default function TestDeriveEmptyInputNoParams() {
    const a = cell(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const b = cell(20, {
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
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
