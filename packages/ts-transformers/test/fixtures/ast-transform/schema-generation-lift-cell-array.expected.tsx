/// <cts-enable />
import { lift, Cell, JSONSchema } from "commontools";
interface CharmEntry {
    id: string;
    name: string;
}
// Test that lift with single generic parameter preserves Cell wrapper
// This was broken on main - Cell would be unwrapped to ProxyArray
const logCharmsList = lift({
    $schema: "https://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
        charmsList: {
            type: "array",
            items: {
                $ref: "#/definitions/CharmEntry"
            },
            asCell: true
        }
    },
    required: ["charmsList"],
    definitions: {
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
} as const satisfies JSONSchema, {
    type: "array",
    items: {
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
    },
    asCell: true
} as const satisfies JSONSchema, ({ charmsList }) => {
    console.log("logCharmsList: ", charmsList.get());
    return charmsList;
});
export default logCharmsList;