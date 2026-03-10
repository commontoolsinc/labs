import * as __ctHelpers from "commontools";
import { derive, pattern } from "commontools";
// FIXTURE: pattern-derive-opaque-ref-map
// Verifies: .map() on an OpaqueRef inside derive() is NOT transformed to mapWithPattern
//   derive({}, () => items.map((n) => n * 2)) → derive({ items }, ({ items }) => items.map((n) => n * 2))
// Context: Inside derive, OpaqueRef auto-unwraps to a plain array, so .map()
//   is a standard Array.prototype.map — it must remain untransformed. Parallel
//   negative test to pattern-computed-opaque-ref-map but using derive() directly.
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
