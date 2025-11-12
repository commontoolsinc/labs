import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
export default function TestDerive() {
    const numbers = cell([1, 2, 3]);
    const multiplier = cell(2);
    // Nested callback - inner array map should not capture outer multiplier
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            numbers: {
                type: "array",
                items: {
                    type: "number"
                },
                asCell: true
            },
            multiplier: {
                type: "number",
                asCell: true
            }
        },
        required: ["numbers", "multiplier"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "number"
        },
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema, {
        numbers,
        multiplier: multiplier
    }, ({ numbers: nums, multiplier }) => nums.mapWithPattern(__ctHelpers.recipe<{
        element: number;
        params: {
            multiplier: __ctHelpers.Cell<number>;
        };
    }>(({ element: n, params: { multiplier } }) => n * multiplier.get()), {
        multiplier: multiplier
    }));
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
