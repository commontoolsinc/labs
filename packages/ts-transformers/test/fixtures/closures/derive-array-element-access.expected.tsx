import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
export default function TestDerive() {
    const value = cell(10);
    const factors = [2, 3, 4];
    const result = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            value: {
                type: "number",
                asOpaque: true
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
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        factors: factors
    }, ({ value: v, factors }) => v * factors[1]);
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
