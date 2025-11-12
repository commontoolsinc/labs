import * as __ctHelpers from "commontools";
import { cell, computed } from "commontools";
export default function TestComputedWithClosedOverCellMap() {
    const numbers = cell([1, 2, 3]);
    const multiplier = cell(2);
    // Inside computed, we close over numbers (a Cell)
    // The computed gets transformed to derive({}, () => numbers.map(...))
    // Inside a derive, .map on a closed-over Cell should STILL be transformed to mapWithPattern
    // because Cells need the pattern-based mapping even when unwrapped
    const doubled = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
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
    } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, {
        numbers: numbers,
        multiplier: multiplier
    }, ({ numbers, multiplier }) => numbers.mapWithPattern(__ctHelpers.recipe<{
        element: number;
        params: {
            multiplier: __ctHelpers.Cell<number>;
        };
    }>(({ element: n, params: { multiplier } }) => n * multiplier.get()), {
        multiplier: multiplier
    }));
    return doubled;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
