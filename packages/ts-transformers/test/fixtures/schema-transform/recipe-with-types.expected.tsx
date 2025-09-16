/// <cts-enable />
import { recipe, h, UI, NAME, Cell, Default, handler, JSONSchema } from "commontools";
interface Item {
    text: Default<string, "">;
}
interface InputSchemaInterface {
    title: Default<string, "untitled">;
    items: Default<Item[], [
    ]>;
}
interface OutputSchemaInterface extends InputSchemaInterface {
    items_count: number;
}
type InputEventType = {
    detail: {
        message: string;
    };
};
const inputSchema = {
    type: "object",
    properties: {
        title: {
            type: "string",
            default: "untitled"
        },
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    text: {
                        type: "string",
                        default: ""
                    }
                },
                required: ["text"]
            },
            default: []
        }
    },
    required: ["title", "items"]
} as const satisfies JSONSchema;
const outputSchema = {
    type: "object",
    properties: {
        items_count: {
            type: "number"
        },
        title: {
            type: "string",
            default: "untitled"
        },
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    text: {
                        type: "string",
                        default: ""
                    }
                },
                required: ["text"]
            },
            default: []
        }
    },
    required: ["items_count", "title", "items"]
} as const satisfies JSONSchema;
// Handler that logs the message event
const addItem = handler({
    type: "object",
    properties: {
        detail: {
            type: "object",
            properties: {
                message: {
                    type: "string"
                }
            },
            required: ["message"]
        }
    },
    required: ["detail"]
} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    text: {
                        type: "string",
                        default: ""
                    }
                },
                required: ["text"]
            },
            asCell: true
        }
    },
    required: ["items"]
} as const satisfies JSONSchema, (event: InputEventType, { items }: {
    items: Cell<Item[]>;
}) => {
    items.push({ text: event.detail.message });
});
export default recipe(inputSchema, outputSchema, ({ title, items }) => {
    const items_count = items.length;
    return {
        [NAME]: title,
        [UI]: (<div>
        <h3>{title}</h3>
        <p>Basic recipe</p>
        <p>Items count: {items_count}</p>
        <ul>
          {items.map((item: Item, index: number) => (<li key={index}>{item.text}</li>))}
        </ul>
        <common-send-message name="Send" placeholder="Type a message..." appearance="rounded" onmessagesend={addItem({ items })}/>
      </div>),
        title,
        items,
        items_count
    };
});

