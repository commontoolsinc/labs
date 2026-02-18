import * as __ctHelpers from "commontools";
import { derive, pattern } from "commontools";
export default pattern((items) => {
    // items is OpaqueRef<number[]> as a pattern parameter
    // Inside the derive callback, items.map should NOT be transformed
    const doubled = __ctHelpers.derive({
        type: "object",
        properties: {
            items: {
                type: "array",
                items: {
                    type: "number"
                },
                asOpaque: true
            }
        },
        required: ["items"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "number"
        },
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema, { items: items }, ({ items }) => items.map((n) => n * 2));
    return doubled;
}, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __ctHelpers.JSONSchema, {
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
