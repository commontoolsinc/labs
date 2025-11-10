import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
export default function TestDerive() {
    const value = cell(5);
    const multiplier = cell(2);
    // Test parameter with default value
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
        value,
        multiplier: multiplier
    }, ({ value: v = 10, multiplier }) => v * multiplier.get());
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
