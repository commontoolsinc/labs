import * as __ctHelpers from "commontools";
import { cell, compute } from "commontools";
export default function TestComputeComplexExpression() {
    const a = cell(10);
    const b = cell(20);
    const c = cell(5);
    const result = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            a: {
                type: "number",
                asOpaque: true
            },
            b: {
                type: "number",
                asOpaque: true
            },
            c: {
                type: "number",
                asOpaque: true
            }
        },
        required: ["a", "b", "c"]
    } as const satisfies __ctHelpers.JSONSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        a: a,
        b: b,
        c: c
    }, ({ a, b, c }) => (a.get() * b.get() + c.get()) / 2);
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
