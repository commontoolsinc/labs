/// <cts-enable />
import { handler, Cell, JSONSchema } from "commontools";
interface Item {
    text: string;
}
interface ListState {
    items: Cell<Item[]>;
}
const removeItem = handler(true as const satisfies JSONSchema, {
    $schema: "https://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/definitions/Item"
            },
            asCell: true
        },
        index: {
            type: "number"
        }
    },
    required: ["items", "index"],
    definitions: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string"
                }
            },
            required: ["text"]
        }
    }
} as const satisfies JSONSchema, (_, { items, index }) => {
    const next = items.get().slice();
    if (index >= 0 && index < next.length)
        next.splice(index, 1);
    items.set(next);
});
// alias-based intersection variant
type ListStateWithIndex = ListState & {
    index: number;
};
const removeItemAlias = handler(true as const satisfies JSONSchema, {
    $schema: "https://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/definitions/Item"
            },
            asCell: true
        },
        index: {
            type: "number"
        }
    },
    required: ["items", "index"],
    definitions: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string"
                }
            },
            required: ["text"]
        }
    }
} as const satisfies JSONSchema, (_, { items, index }) => {
    const next = items.get().slice();
    if (index >= 0 && index < next.length)
        next.splice(index, 1);
    items.set(next);
});
export { removeItem, removeItemAlias };
