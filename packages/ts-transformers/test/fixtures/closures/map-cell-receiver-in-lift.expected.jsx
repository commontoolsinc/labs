import * as __ctHelpers from "commontools";
import { Cell, lift } from "commontools";
// FIXTURE: map-cell-receiver-in-lift
// Verifies: compute-owned map roots on Cell receivers still lower to mapWithPattern
//   lift(() => items.map((item) => item)) -> lift(() => items.mapWithPattern(...))
// Context: No JSX here; the map rewrite happens inside a builder-owned compute context
const items = Cell.of<string[]>([], {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __ctHelpers.JSONSchema);
export const fn = lift(false as const satisfies __ctHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __ctHelpers.JSONSchema, () => items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
    const item = __ct_pattern_input.key("element");
    return item;
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
        }
    },
    required: ["element"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "string"
} as const satisfies __ctHelpers.JSONSchema), {}));
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
