import * as __ctHelpers from "commontools";
import { derive, OpaqueRef } from "commontools";
export default function TestDeriveWithClosedOverOpaqueRefMap() {
    const items = [1, 2, 3] as OpaqueRef<number[]>;
    // Explicit derive with closed-over OpaqueRef
    // .map on a closed-over OpaqueRef should NOT be transformed to mapWithPattern
    const doubled = __lift_0({ items: items });
    return doubled;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
const __lift_0 = __ctHelpers.lift({
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
} as const satisfies __ctHelpers.JSONSchema, ({ items }) => items.map(n => n * 2));
