import * as __ctHelpers from "commontools";
import { Writable, computed, pattern } from "commontools";
export default pattern(() => {
    const numbers = Writable.of([1, 2, 3], {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __ctHelpers.JSONSchema);
    const multiplier = Writable.of(2, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // Inside computed, we close over numbers (a Cell)
    // The computed gets transformed to derive({}, () => numbers.map(...))
    // Inside a derive, .map on a closed-over Cell should STILL be transformed to mapWithPattern
    // because Cells need the pattern-based mapping even when unwrapped
    const doubled = __ctHelpers.derive({
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
        numbers: numbers,
        multiplier: multiplier
    }, ({ numbers, multiplier }) => numbers.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
        const n = __ct_pattern_input.key("element");
        const multiplier = __ct_pattern_input.key("params", "multiplier");
        return n * multiplier.get();
    }, {
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
    } as const satisfies __ctHelpers.JSONSchema), {
        multiplier: multiplier
    }));
    return doubled;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "number"
    },
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
