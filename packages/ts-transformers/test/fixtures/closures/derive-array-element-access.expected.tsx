import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
export default function TestDerive() {
    const value = cell(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const factors = [2, 3, 4];
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            factors: {
                type: "array",
                items: {
                    type: "number"
                }
            }
        },
        required: ["value", "factors"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        factors: factors
    }, ({ value: v, factors }) => v.get() * factors[1]!);
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
