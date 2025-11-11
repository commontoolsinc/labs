import * as __ctHelpers from "commontools";
import { cell, compute } from "commontools";
export default function TestComputeConditionalExpression() {
    const value = cell(10);
    const threshold = cell(5);
    const a = cell(100);
    const b = cell(200);
    const result = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            value: {
                type: "number",
                asOpaque: true
            },
            threshold: {
                type: "number",
                asOpaque: true
            },
            a: {
                type: "number",
                asOpaque: true
            },
            b: {
                type: "number",
                asOpaque: true
            }
        },
        required: ["value", "threshold", "a", "b"]
    } as const satisfies __ctHelpers.JSONSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
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
