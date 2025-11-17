import * as __ctHelpers from "commontools";
import { cell, computed, recipe } from "commontools";
export default recipe(() => {
    const a = cell(10);
    const b = cell(20);
    const sum = __ctHelpers.derive({
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
    const doubled = __ctHelpers.derive({
        type: "object",
        properties: {
            sum: {
                type: "number",
                asOpaque: true
            }
        },
        required: ["sum"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, { sum: sum }, ({ sum }) => sum * 2);
    return doubled;
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
