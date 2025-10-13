import * as __ctHelpers from "commontools";
import { lift, Cell } from "commontools";
interface CharmEntry {
    id: string;
    name: string;
}
// Test that lift with single generic parameter preserves Cell wrapper
// This was broken on main - Cell would be unwrapped to ProxyArray
const logCharmsList = lift({
    $schema: "https://json-schema.org/draft/2020-12/schema",
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
    $schema: "https://json-schema.org/draft/2020-12/schema",
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
