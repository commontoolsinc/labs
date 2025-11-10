import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
export default function TestDerive() {
    const numbers = cell([1, 2, 3]);
    const multiplier = cell(2);
    // Nested callback - inner array map should not capture outer multiplier
    const result = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            numbers: {
                type: "array",
                items: {
                    type: "number"
                },
                asOpaque: true
            },
            multiplier: {
                type: "number",
                asOpaque: true
            }
        },
        required: ["numbers", "multiplier"]
    } as const satisfies __ctHelpers.JSONSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        numbers,
        multiplier: multiplier
    }, ({ numbers: nums, multiplier }) => nums.map(n => n * multiplier.get()));
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
