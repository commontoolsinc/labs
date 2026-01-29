import * as __ctHelpers from "commontools";
import { cell, computed } from "commontools";
const __lift_0 = __ctHelpers.lift({
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
} as const satisfies __ctHelpers.JSONSchema, ({ numbers, multiplier }) => numbers.mapWithPattern(__ctHelpers.recipe({
    type: "object",
    properties: {
        element: {
            type: "number"
        },
        params: {
            type: "object",
            properties: {
                multiplier: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["multiplier"]
        }
    },
    required: ["element", "params"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, ({ element: n, params: { multiplier } }) => n * multiplier.get()), {
    multiplier: multiplier
}));
export default function TestComputedWithClosedOverCellMap() {
    const numbers = cell([1, 2, 3], {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __ctHelpers.JSONSchema);
    const multiplier = cell(2, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // Inside computed, we close over numbers (a Cell)
    // The computed gets transformed to derive({}, () => numbers.map(...))
    // Inside a derive, .map on a closed-over Cell should STILL be transformed to mapWithPattern
    // because Cells need the pattern-based mapping even when unwrapped
    const doubled = __lift_0({
        numbers: numbers,
        multiplier: multiplier
    });
    return doubled;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
