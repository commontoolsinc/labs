import * as __ctHelpers from "commontools";
import { cell, computed } from "commontools";
export default function TestComputedWithClosedOverOpaqueRefMap() {
    const items = cell([1, 2, 3]);
    // Inside computed, we close over items (an OpaqueRef)
    // The computed gets transformed to derive({}, () => items.map(...))
    // Inside a derive, .map on a closed-over OpaqueRef should NOT be transformed to mapWithPattern
    // because items is already an OpaqueRef and will be passed through as-is
    const doubled = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            items: {
                type: "array",
                items: {
                    type: "number"
                },
                asCell: true
            }
        },
        required: ["items"]
    } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, { items: items }, ({ items }) => items.map(n => n * 2));
    return doubled;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
