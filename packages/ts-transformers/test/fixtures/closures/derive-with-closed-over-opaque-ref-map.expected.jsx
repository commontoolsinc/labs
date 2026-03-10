import * as __ctHelpers from "commontools";
import { OpaqueRef, derive, pattern } from "commontools";
export default pattern(() => {
    const items = [1, 2, 3] as OpaqueRef<number[]>;
    // Explicit derive with closed-over OpaqueRef
    // .map on a closed-over OpaqueRef should NOT be transformed to mapWithPattern
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
    } as const satisfies __ctHelpers.JSONSchema, { items: items }, ({ items }) => items.map(n => n * 2));
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
