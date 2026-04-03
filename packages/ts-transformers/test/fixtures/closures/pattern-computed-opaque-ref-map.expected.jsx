import * as __ctHelpers from "commontools";
import { computed, pattern } from "commontools";
// FIXTURE: pattern-computed-opaque-ref-map
// Verifies: .map() on an OpaqueRef inside computed() is NOT transformed to mapWithPattern
//   computed(() => items.map((n) => n * 2)) → derive({ items }, ({ items }) => items.map((n) => n * 2))
// Context: Inside computed/derive, OpaqueRef auto-unwraps to a plain array, so
//   .map() is a standard Array.prototype.map — it must remain untransformed.
//   This is a negative test for reactive method detection.
export default pattern((items) => {
    // items is OpaqueRef<number[]> as a pattern parameter
    // Inside the computed callback (which becomes derive), items.map should NOT be transformed
    const doubled = __ctHelpers.derive({
        type: "object",
        properties: {
            items: {
                type: "array",
                items: {
                    type: "number"
                }
            }
        },
        required: ["items"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "number"
        }
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
    }
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
