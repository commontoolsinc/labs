import * as __ctHelpers from "commontools";
import { Cell, handler } from "commontools";
interface Item {
    text: string;
}
interface ListState {
    items: Cell<Item[]>;
}
const removeItem = handler(true as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: true
        },
        index: {
            type: "number"
        }
    },
    required: ["items", "index"],
    $defs: {
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
} as const satisfies __ctHelpers.JSONSchema, (_, { items, index }) => {
    const next = items.get().slice();
    if (index >= 0 && index < next.length)
        next.splice(index, 1);
    items.set(next);
});
// alias-based intersection variant
type ListStateWithIndex = ListState & {
    index: number;
};
const removeItemAlias = handler(true as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: true
        },
        index: {
            type: "number"
        }
    },
    required: ["items", "index"],
    $defs: {
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
} as const satisfies __ctHelpers.JSONSchema, (_, { items, index }) => {
    const next = items.get().slice();
    if (index >= 0 && index < next.length)
        next.splice(index, 1);
    items.set(next);
});
export { removeItem, removeItemAlias };
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
