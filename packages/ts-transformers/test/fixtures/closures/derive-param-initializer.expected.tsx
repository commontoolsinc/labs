import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
export default function TestDerive() {
    const value = 5;
    const multiplier = cell(2, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // Test parameter with default value
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number"
            },
            multiplier: {
                type: "number",
                asCell: true
            }
        },
        required: ["value", "multiplier"]
    } as const satisfies __ctHelpers.JSONSchema, {
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
