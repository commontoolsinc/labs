import * as __cfHelpers from "commonfabric";
import { Cell, lift } from "commonfabric";
// FIXTURE: map-cell-receiver-in-lift
// Verifies: compute-owned map roots on Cell receivers still lower to mapWithPattern
//   lift(() => items.map((item) => item)) -> lift(() => items.mapWithPattern(...))
// Context: No JSX here; the map rewrite happens inside a builder-owned compute context
const items = Cell.of<string[]>([], {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
export const fn = lift(false as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, () => items.mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema), {}));
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
