/// <cts-enable />
import { handler, Cell, JSONSchema } from "commontools";
interface Item {
    text: string;
}
interface ListState {
    items: Cell<Item[]>;
}
const removeItem = handler({} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    text: {
                        type: "string"
                    }
                },
                required: ["text"]
            },
            asCell: true
        },
        index: {
            type: "number"
        }
    },
    required: ["items", "index"]
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
const removeItemAlias = handler({} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    text: {
                        type: "string"
                    }
                },
                required: ["text"]
            },
            asCell: true
        },
        index: {
            type: "number"
        }
    },
    required: ["items", "index"]
} as const satisfies JSONSchema, (_, { items, index }) => {
    const next = items.get().slice();
    if (index >= 0 && index < next.length)
        next.splice(index, 1);
    items.set(next);
});
export { removeItem, removeItemAlias };
