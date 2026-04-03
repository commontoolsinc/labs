import * as __cfHelpers from "commonfabric";
import { pattern } from "commonfabric";
const identity = <T,>(value: T) => value;
// FIXTURE: map-local-helper-call-root
// Verifies: non-JSX pattern-owned map callbacks lift ordinary local helper
//   calls as whole callback-local derives rather than lowering only the inner
//   receiver-method argument expression.
//   items.map((item) => identity(item.toUpperCase()))
//   -> mapWithPattern(..., ({ item }) => derive(..., ({ item }) => identity(item.toUpperCase())))
export default pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    return items.mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
        const item = __ct_pattern_input.key("element");
        return __cfHelpers.derive({
            type: "object",
            properties: {
                item: {
                    type: "string"
                }
            },
            required: ["item"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { item: item }, ({ item }) => identity(item.toUpperCase()));
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
    } as const satisfies __cfHelpers.JSONSchema), {});
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
