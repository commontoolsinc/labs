import * as __ctHelpers from "commontools";
import { Cell, lift } from "commontools";
interface CharmEntry {
    id: string;
    name: string;
}
// FIXTURE: schema-generation-lift-cell-array
// Verifies: lift() with Cell<T[]> in the generic arg preserves asCell in the generated schema
//   lift<{ charmsList: Cell<CharmEntry[]> }>(fn) → lift(inputSchema, outputSchema, fn)
// Context: Cell wrapper must produce `asCell: true` in the schema; output schema inferred from return type
// Test that lift with single generic parameter preserves Cell wrapper
// This was broken on main - Cell would be unwrapped to ProxyArray
const logCharmsList = lift({
    type: "object",
    properties: {
        charmsList: {
            type: "array",
            items: {
                $ref: "#/$defs/CharmEntry"
            },
            asCell: true
        }
    },
    required: ["charmsList"],
    $defs: {
        CharmEntry: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/CharmEntry"
    },
    asCell: true,
    $defs: {
        CharmEntry: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, ({ charmsList }) => {
    console.log("logCharmsList: ", charmsList.get());
    return charmsList;
});
export default logCharmsList;
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
