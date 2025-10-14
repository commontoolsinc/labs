import * as __ctHelpers from "commontools";
import { Cell, Default, handler, NAME, recipe, toSchema, UI, } from "commontools";
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
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
        title: {
            type: "string",
            default: "untitled"
        },
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            default: []
        }
    },
    required: ["title", "items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    default: ""
                }
            },
            required: ["text"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema;
const outputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
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
                $ref: "#/$defs/Item"
            },
            default: []
        }
    },
    required: ["items_count", "title", "items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    default: ""
                }
            },
            required: ["text"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema;
// Handler that logs the message event
const addItem = handler // <
({
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
} as const satisfies __ctHelpers.JSONSchema, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: true
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    default: ""
                }
            },
            required: ["text"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (event: InputEventType, { items }: {
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
        items_count,
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
