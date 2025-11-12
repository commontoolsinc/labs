import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
export default function TestDeriveLocalVariable() {
    const a = cell(10);
    const b = cell(20);
    const c = cell(30);
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
    }, ({ a: aVal, b, c }) => {
        const sum = aVal + b.get();
        return sum * c.get();
    });
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
