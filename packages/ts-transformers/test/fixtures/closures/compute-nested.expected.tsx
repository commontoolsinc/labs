import * as __ctHelpers from "commontools";
import { cell, computed, recipe } from "commontools";
export default recipe(() => {
    const a = cell(10);
    const b = cell(20);
    const sum = __ctHelpers.derive({
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
            }
        },
        required: ["a", "b"]
    } as const satisfies __ctHelpers.JSONSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        a: a,
        b: b
    }, ({ a, b }) => a.get() + b.get());
    const doubled = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            sum: {
                type: "number",
                asOpaque: true
            }
        },
        required: ["sum"]
    } as const satisfies __ctHelpers.JSONSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, { sum: sum }, ({ sum }) => sum.get() * 2);
    return doubled;
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
