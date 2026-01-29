import * as __ctHelpers from "commontools";
import { derive, recipe } from "commontools";
export default recipe({
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
} as const satisfies __ctHelpers.JSONSchema, (items) => {
    // items is OpaqueRef<number[]> as a recipe parameter
    // Inside the derive callback, items.map should NOT be transformed
    const doubled = __lift_0({ items: items });
    return doubled;
});
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
} as const satisfies __ctHelpers.JSONSchema, ({ items }) => items.map((n) => n * 2));
