import * as __ctHelpers from "commontools";
import { cell, computed } from "commontools";
export default function TestComputeConditionalExpression() {
    const value = cell(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const threshold = cell(5, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const a = cell(100, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const b = cell(200, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            threshold: {
                type: "number",
                asCell: true
            },
            a: {
                type: "number",
                asCell: true
            },
            b: {
                type: "number",
                asCell: true
            }
        },
        required: ["value", "threshold", "a", "b"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value: value,
        threshold: threshold,
        a: a,
        b: b
    }, ({ value, threshold, a, b }) => value.get() > threshold.get() ? a.get() : b.get());
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
