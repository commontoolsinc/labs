import * as __ctHelpers from "commontools";
import { cell, compute } from "commontools";
export default function TestCompute() {
    const value = cell(10);
    const multiplier = cell(2);
    const result = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            value: {
                type: "number",
                asOpaque: true
            },
            multiplier: {
                type: "number",
                asOpaque: true
            }
        },
        required: ["value", "multiplier"]
    } as const satisfies __ctHelpers.JSONSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value: value,
        multiplier: multiplier
    }, ({ value, multiplier }) => value.get() * multiplier.get());
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
