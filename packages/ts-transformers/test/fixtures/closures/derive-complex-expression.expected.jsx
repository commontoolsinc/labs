import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
export default function TestDerive() {
    const a = cell(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const b = cell(20, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const c = cell(30, {
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
        a,
        b: b,
        c: c
    }, ({ a: x, b, c }) => (x.get() * b.get() + c.get()) / 2);
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
